/*
 * Monday Attendance
 *
 * Attendance checker for a Monday school program, backed by Supabase so the
 * roster and today's check-ins stay in sync live across every device running
 * this page (e.g. multiple check-in tables). See README.md for setup.
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Room configuration
  // ---------------------------------------------------------------------

  const ROOMS = [
    { id: "tk-k", name: "TK-K", capacity: 10 },
    { id: "tk-k-overflow", name: "TK-K Overflow", capacity: 10 },
    { id: "grade-1-4", name: "1st - 4th", capacity: 20 },
    { id: "grade-5-8", name: "5th - 8th", capacity: 20 },
    { id: "combo", name: "Combo (1st - 8th)", capacity: 20 },
  ];

  // For a given grade, the ordered list of rooms to try (first room with an
  // open seat wins). This encodes the assignment rules from the program:
  //   TK/K       -> TK-K, then TK-K Overflow
  //   1st - 4th  -> 1st-4th, then Combo
  //   5th - 8th  -> 5th-8th, then Combo
  const ROOM_ORDER_BY_GRADE = {
    TK: ["tk-k", "tk-k-overflow"],
    K: ["tk-k", "tk-k-overflow"],
    "1": ["grade-1-4", "combo"],
    "2": ["grade-1-4", "combo"],
    "3": ["grade-1-4", "combo"],
    "4": ["grade-1-4", "combo"],
    "5": ["grade-5-8", "combo"],
    "6": ["grade-5-8", "combo"],
    "7": ["grade-5-8", "combo"],
    "8": ["grade-5-8", "combo"],
  };

  const GRADE_LABELS = {
    TK: "TK", K: "K", "1": "1st", "2": "2nd", "3": "3rd", "4": "4th",
    "5": "5th", "6": "6th", "7": "7th", "8": "8th",
  };

  const SAMPLE_ROSTER = [
    { name: "Ava Thompson", grade: "TK" },
    { name: "Liam Rodriguez", grade: "TK" },
    { name: "Sophia Nguyen", grade: "K" },
    { name: "Noah Patel", grade: "K" },
    { name: "Mia Johnson", grade: "K" },
    { name: "Elijah Garcia", grade: "1" },
    { name: "Olivia Martinez", grade: "1" },
    { name: "Lucas Kim", grade: "2" },
    { name: "Emma Davis", grade: "2" },
    { name: "Benjamin Lee", grade: "3" },
    { name: "Charlotte Brown", grade: "3" },
    { name: "James Wilson", grade: "4" },
    { name: "Amelia Clark", grade: "4" },
    { name: "Henry Lewis", grade: "5" },
    { name: "Isabella Walker", grade: "5" },
    { name: "Alexander Hall", grade: "6" },
    { name: "Harper Young", grade: "6" },
    { name: "Michael Allen", grade: "7" },
    { name: "Evelyn Scott", grade: "7" },
    { name: "Daniel Torres", grade: "8" },
    { name: "Abigail Reed", grade: "8" },
  ];

  const NIL_UUID = "00000000-0000-0000-0000-000000000000";

  // ---------------------------------------------------------------------
  // Supabase client
  // ---------------------------------------------------------------------

  const SUPABASE_URL = window.SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "";
  const isConfigured = Boolean(
    SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    !SUPABASE_URL.includes("YOUR-PROJECT") &&
    !SUPABASE_ANON_KEY.includes("YOUR-ANON")
  );
  const hasClientLib = typeof window.supabase !== "undefined" && typeof window.supabase.createClient === "function";
  const db = (isConfigured && hasClientLib) ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  let roster = []; // [{ id, name, grade }]
  let checkins = []; // [{ id, studentId, name, grade, roomId, time, walkin }]
  let activeSuggestionIndex = -1;

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------

  const el = {
    dbBanner: document.getElementById("dbBanner"),
    todayLabel: document.getElementById("todayLabel"),
    searchInput: document.getElementById("searchInput"),
    suggestions: document.getElementById("suggestions"),
    rosterStatus: document.getElementById("rosterStatus"),
    rosters: document.getElementById("rosters"),
    csvFile: document.getElementById("csvFile"),
    uploadRosterBtn: document.getElementById("uploadRosterBtn"),
    sampleRosterBtn: document.getElementById("sampleRosterBtn"),
    exportBtn: document.getElementById("exportBtn"),
    resetBtn: document.getElementById("resetBtn"),
    walkinForm: document.getElementById("walkinForm"),
    walkinName: document.getElementById("walkinName"),
    walkinGrade: document.getElementById("walkinGrade"),
    walkinDetails: document.getElementById("walkinDetails"),
    toast: document.getElementById("toast"),
  };

  // ---------------------------------------------------------------------
  // Date helpers
  // ---------------------------------------------------------------------

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function normalizeGrade(raw) {
    if (raw == null) return "";
    const g = String(raw).trim().toUpperCase();
    if (g === "TK" || g === "T-K" || g === "TRANSITIONAL KINDERGARTEN") return "TK";
    if (g === "K" || g === "KINDER" || g === "KINDERGARTEN") return "K";
    const digits = g.replace(/[^0-9]/g, "");
    if (digits) return digits;
    return g;
  }

  // ---------------------------------------------------------------------
  // Row <-> app-state mapping
  // ---------------------------------------------------------------------

  function mapStudentRow(row) {
    return { id: row.id, name: row.name, grade: row.grade };
  }

  function mapCheckinRow(row) {
    return {
      id: row.id,
      studentId: row.student_id,
      name: row.name,
      grade: row.grade,
      roomId: row.room_id,
      time: row.checked_in_at,
      walkin: row.walkin,
    };
  }

  // ---------------------------------------------------------------------
  // Loading from Supabase
  // ---------------------------------------------------------------------

  async function loadRoster() {
    if (!db) {
      roster = [];
      return;
    }
    const { data, error } = await db.from("students").select("*").order("name", { ascending: true });
    if (error) {
      console.error("Failed to load roster", error);
      showToast("Couldn't load roster: " + error.message);
      return;
    }
    roster = (data || []).map(mapStudentRow);
  }

  async function loadCheckins() {
    if (!db) {
      checkins = [];
      return;
    }
    const { data, error } = await db
      .from("checkins")
      .select("*")
      .eq("check_date", todayKey())
      .order("checked_in_at", { ascending: true });
    if (error) {
      console.error("Failed to load today's check-ins", error);
      showToast("Couldn't load today's check-ins: " + error.message);
      return;
    }
    checkins = (data || []).map(mapCheckinRow);
  }

  async function setRoster(students) {
    if (!db) {
      showToast("Connect Supabase first — see config.js.");
      return;
    }
    const rows = students
      .map((s) => ({ name: String(s.name).trim(), grade: normalizeGrade(s.grade) }))
      .filter((s) => s.name);

    const { error: delErr } = await db.from("students").delete().neq("id", NIL_UUID);
    if (delErr) {
      console.error(delErr);
      showToast("Couldn't clear the old roster: " + delErr.message);
      return;
    }
    if (rows.length > 0) {
      const { error: insErr } = await db.from("students").insert(rows);
      if (insErr) {
        console.error(insErr);
        showToast("Couldn't save the new roster: " + insErr.message);
        return;
      }
    }
    await loadRoster();
    renderAll();
  }

  function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return [];
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const nameIdx = header.indexOf("name");
    const gradeIdx = header.indexOf("grade");
    const startRow = nameIdx === -1 || gradeIdx === -1 ? 0 : 1;
    const nIdx = nameIdx === -1 ? 0 : nameIdx;
    const gIdx = gradeIdx === -1 ? 1 : gradeIdx;

    const students = [];
    for (let i = startRow; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const name = (cols[nIdx] || "").trim();
      const grade = (cols[gIdx] || "").trim();
      if (name) students.push({ name, grade });
    }
    return students;
  }

  // ---------------------------------------------------------------------
  // Check-in / room assignment
  // ---------------------------------------------------------------------

  function countInRoom(roomId) {
    return checkins.filter((c) => c.roomId === roomId).length;
  }

  function isCheckedIn(studentId) {
    return checkins.some((c) => c.studentId === studentId);
  }

  function findRoomForGrade(grade) {
    const order = ROOM_ORDER_BY_GRADE[grade];
    if (!order) return null;
    for (const roomId of order) {
      const room = ROOMS.find((r) => r.id === roomId);
      if (countInRoom(roomId) < room.capacity) return room;
    }
    return null;
  }

  async function checkInStudent(student) {
    if (!db) {
      showToast("Connect Supabase first — see config.js.");
      return;
    }
    if (student.id && isCheckedIn(student.id)) {
      showStatus(student.name + " is already checked in today.", "error");
      return;
    }
    const room = findRoomForGrade(student.grade);
    if (!room) {
      const gradeLabel = GRADE_LABELS[student.grade] || student.grade || "this grade";
      showStatus(
        "No open seats for " + gradeLabel + " — every matching room is full. See a supervisor.",
        "error"
      );
      showToast("⚠️ All rooms full for " + gradeLabel);
      return;
    }

    const { data, error } = await db
      .from("checkins")
      .insert({
        student_id: student.id || null,
        name: student.name,
        grade: student.grade,
        room_id: room.id,
        walkin: !!student.walkin,
        // Set explicitly from the browser's local date so "today" always
        // matches what's on screen, regardless of the server's timezone.
        check_date: todayKey(),
      })
      .select()
      .single();

    if (error) {
      console.error(error);
      showStatus("Couldn't check in " + student.name + ": " + error.message, "error");
      return;
    }

    if (!checkins.some((c) => c.id === data.id)) {
      checkins.push(mapCheckinRow(data));
    }
    showStatus(student.name + " checked in to " + room.name + ".", "success");
    showToast("✅ " + student.name + " → " + room.name);
    renderRosters();
    clearSearch();
  }

  async function removeCheckin(checkinId) {
    const entry = checkins.find((c) => c.id === checkinId);
    if (!db || !entry) return;
    checkins = checkins.filter((c) => c.id !== checkinId);
    renderRosters();

    const { error } = await db.from("checkins").delete().eq("id", checkinId);
    if (error) {
      console.error(error);
      showToast("Couldn't remove " + entry.name + ": " + error.message);
      await loadCheckins();
      renderRosters();
      return;
    }
    showToast("Removed " + entry.name + " from today's attendance.");
  }

  // ---------------------------------------------------------------------
  // Realtime — keep every open browser tab in sync
  // ---------------------------------------------------------------------

  function subscribeRealtime() {
    if (!db) return;

    db.channel("checkins-live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "checkins" },
        (payload) => {
          if (payload.new.check_date !== todayKey()) return;
          if (!checkins.some((c) => c.id === payload.new.id)) {
            checkins.push(mapCheckinRow(payload.new));
            renderRosters();
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "checkins" },
        (payload) => {
          const before = checkins.length;
          checkins = checkins.filter((c) => c.id !== payload.old.id);
          if (checkins.length !== before) renderRosters();
        }
      )
      .subscribe();

    db.channel("students-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "students" },
        () => {
          loadRoster().then(() => {
            renderAll();
            renderSuggestions(getMatches(el.searchInput.value));
          });
        }
      )
      .subscribe();
  }

  // ---------------------------------------------------------------------
  // Search / suggestions
  // ---------------------------------------------------------------------

  function clearSearch() {
    el.searchInput.value = "";
    activeSuggestionIndex = -1;
    renderSuggestions([]);
  }

  function getMatches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return roster
      .filter((s) => !isCheckedIn(s.id))
      .filter((s) => s.name.toLowerCase().includes(q))
      .slice(0, 8);
  }

  function renderSuggestions(matches) {
    el.suggestions.innerHTML = "";
    if (matches.length === 0) {
      el.suggestions.hidden = true;
      return;
    }
    matches.forEach((s, idx) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.className = idx === activeSuggestionIndex ? "active" : "";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = s.name;
      const gradeSpan = document.createElement("span");
      gradeSpan.className = "grade-tag";
      gradeSpan.textContent = GRADE_LABELS[s.grade] || s.grade;
      li.appendChild(nameSpan);
      li.appendChild(gradeSpan);
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        checkInStudent(s);
      });
      el.suggestions.appendChild(li);
    });
    el.suggestions.hidden = false;
  }

  function showStatus(message, type) {
    el.rosterStatus.textContent = message;
    el.rosterStatus.className = "roster-status" + (type ? " " + type : "");
  }

  let toastTimer = null;
  function showToast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 2200);
  }

  function updateDbBanner() {
    if (!el.dbBanner) return;
    if (!hasClientLib) {
      el.dbBanner.textContent =
        "Couldn't load the Supabase library — check your internet connection and reload.";
      el.dbBanner.className = "db-banner error";
      el.dbBanner.hidden = false;
    } else if (!isConfigured) {
      el.dbBanner.textContent =
        "Supabase isn't connected yet — add your project URL and anon key to config.js, then reload.";
      el.dbBanner.className = "db-banner";
      el.dbBanner.hidden = false;
    } else {
      el.dbBanner.hidden = true;
    }
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function renderRosters() {
    el.rosters.innerHTML = "";
    ROOMS.forEach((room) => {
      const entries = checkins
        .filter((c) => c.roomId === room.id)
        .sort((a, b) => new Date(a.time) - new Date(b.time));
      const count = entries.length;
      const pct = Math.min(100, Math.round((count / room.capacity) * 100));
      const level = count >= room.capacity ? "full" : count >= room.capacity * 0.8 ? "warn" : "ok";

      const card = document.createElement("div");
      card.className = "room-card";

      const header = document.createElement("div");
      header.className = "room-card-header";
      header.innerHTML =
        "<h2>" + room.name + "</h2>" +
        '<span class="room-count ' + level + '">' + count + " / " + room.capacity + "</span>";
      card.appendChild(header);

      const track = document.createElement("div");
      track.className = "progress-track";
      const fill = document.createElement("div");
      fill.className = "progress-fill " + level;
      fill.style.width = pct + "%";
      track.appendChild(fill);
      card.appendChild(track);

      const list = document.createElement("ul");
      list.className = "roster-list";
      if (entries.length === 0) {
        const empty = document.createElement("li");
        empty.className = "roster-empty";
        empty.textContent = "No students yet.";
        list.appendChild(empty);
      } else {
        entries.forEach((entry) => {
          const li = document.createElement("li");
          const label = document.createElement("span");
          label.textContent = entry.name + (entry.walkin ? " (walk-in)" : "");
          const removeBtn = document.createElement("button");
          removeBtn.className = "remove-btn";
          removeBtn.type = "button";
          removeBtn.title = "Remove from room";
          removeBtn.textContent = "✕";
          removeBtn.addEventListener("click", () => removeCheckin(entry.id));
          li.appendChild(label);
          li.appendChild(removeBtn);
          list.appendChild(li);
        });
      }
      card.appendChild(list);
      el.rosters.appendChild(card);
    });
  }

  function renderAll() {
    el.todayLabel.textContent = new Date().toLocaleDateString(undefined, {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    }) + " • " + roster.length + " students loaded";
    renderRosters();
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------

  function exportCsv() {
    const roomsById = Object.fromEntries(ROOMS.map((r) => [r.id, r.name]));
    const rows = [["Name", "Grade", "Room", "Check-in Time"]];
    checkins
      .slice()
      .sort((a, b) => new Date(a.time) - new Date(b.time))
      .forEach((c) => {
        rows.push([
          c.name,
          GRADE_LABELS[c.grade] || c.grade,
          roomsById[c.roomId] || c.roomId,
          new Date(c.time).toLocaleTimeString(),
        ]);
      });
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "monday-attendance-" + todayKey() + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvEscape(value) {
    const v = String(value);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  // ---------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------

  el.searchInput.addEventListener("input", () => {
    activeSuggestionIndex = -1;
    renderSuggestions(getMatches(el.searchInput.value));
  });

  el.searchInput.addEventListener("keydown", (e) => {
    const matches = getMatches(el.searchInput.value);
    if (matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, matches.length - 1);
      renderSuggestions(matches);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, 0);
      renderSuggestions(matches);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = matches[activeSuggestionIndex] || matches[0];
      if (pick) checkInStudent(pick);
    } else if (e.key === "Escape") {
      clearSearch();
    }
  });

  document.addEventListener("click", (e) => {
    if (!el.suggestions.contains(e.target) && e.target !== el.searchInput) {
      el.suggestions.hidden = true;
    }
  });

  el.uploadRosterBtn.addEventListener("click", () => el.csvFile.click());

  el.csvFile.addEventListener("change", () => {
    const file = el.csvFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const students = parseCsv(String(reader.result));
      if (students.length === 0) {
        showToast("That CSV didn't have any usable rows (expected Name, Grade columns).");
        return;
      }
      await setRoster(students);
      showToast("Loaded " + students.length + " students from " + file.name);
    };
    reader.readAsText(file);
    el.csvFile.value = "";
  });

  el.sampleRosterBtn.addEventListener("click", async () => {
    await setRoster(SAMPLE_ROSTER);
    showToast("Loaded the sample demo roster (" + SAMPLE_ROSTER.length + " students).");
  });

  el.exportBtn.addEventListener("click", () => {
    if (checkins.length === 0) {
      showToast("No check-ins yet today.");
      return;
    }
    exportCsv();
  });

  el.resetBtn.addEventListener("click", async () => {
    if (!db) {
      showToast("Connect Supabase first — see config.js.");
      return;
    }
    if (checkins.length === 0) {
      showToast("Today's attendance is already empty.");
      return;
    }
    if (!confirm("Clear all of today's check-ins? This cannot be undone.")) return;

    checkins = [];
    renderRosters();
    const { error } = await db.from("checkins").delete().eq("check_date", todayKey());
    if (error) {
      console.error(error);
      showToast("Couldn't reset: " + error.message);
      await loadCheckins();
      renderRosters();
      return;
    }
    showToast("Today's attendance has been reset.");
  });

  el.walkinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el.walkinName.value.trim();
    const grade = normalizeGrade(el.walkinGrade.value);
    if (!name || !grade) return;
    await checkInStudent({ name, grade, walkin: true });
    el.walkinForm.reset();
    el.walkinDetails.open = false;
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  async function init() {
    updateDbBanner();
    await Promise.all([loadRoster(), loadCheckins()]);
    renderAll();
    subscribeRealtime();
  }

  init();
})();
