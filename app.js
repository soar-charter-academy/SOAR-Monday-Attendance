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
    { studentId: "100001", firstName: "Ava", lastName: "Thompson", grade: "TK" },
    { studentId: "100002", firstName: "Liam", lastName: "Rodriguez", grade: "TK" },
    { studentId: "100003", firstName: "Sophia", lastName: "Nguyen", grade: "K" },
    { studentId: "100004", firstName: "Noah", lastName: "Patel", grade: "K" },
    { studentId: "100005", firstName: "Mia", lastName: "Johnson", grade: "K" },
    { studentId: "100006", firstName: "Elijah", lastName: "Garcia", grade: "1" },
    { studentId: "100007", firstName: "Olivia", lastName: "Martinez", grade: "1" },
    { studentId: "100008", firstName: "Lucas", lastName: "Kim", grade: "2" },
    { studentId: "100009", firstName: "Emma", lastName: "Davis", grade: "2" },
    { studentId: "100010", firstName: "Benjamin", lastName: "Lee", grade: "3" },
    { studentId: "100011", firstName: "Charlotte", lastName: "Brown", grade: "3" },
    { studentId: "100012", firstName: "James", lastName: "Wilson", grade: "4" },
    { studentId: "100013", firstName: "Amelia", lastName: "Clark", grade: "4" },
    { studentId: "100014", firstName: "Henry", lastName: "Lewis", grade: "5" },
    { studentId: "100015", firstName: "Isabella", lastName: "Walker", grade: "5" },
    { studentId: "100016", firstName: "Alexander", lastName: "Hall", grade: "6" },
    { studentId: "100017", firstName: "Harper", lastName: "Young", grade: "6" },
    { studentId: "100018", firstName: "Michael", lastName: "Allen", grade: "7" },
    { studentId: "100019", firstName: "Evelyn", lastName: "Scott", grade: "7" },
    { studentId: "100020", firstName: "Daniel", lastName: "Torres", grade: "8" },
    { studentId: "100021", firstName: "Abigail", lastName: "Reed", grade: "8" },
  ];

  const NIL_UUID = "00000000-0000-0000-0000-000000000000";

  // Per-room teacher names are a lightweight, purely local UI convenience —
  // stored in this browser's localStorage rather than Supabase, so they
  // aren't synced across devices. Each check-in table sets its own room's
  // teacher name once and it's just along for the ride into CSV exports.
  const STORAGE_TEACHERS_KEY = "mondayAttendance.teachers.v1";

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

  let roster = []; // [{ id, studentId, firstName, lastName, grade }]
  let checkins = []; // [{ id, studentId, aeriesStudentId, firstName, lastName, grade, roomId, time, walkin }]
  let activeSuggestionIndex = -1;
  let teachers = loadTeachers(); // { [roomId]: teacherName }

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

  // Combines a roster/check-in entry's separate name fields for display and
  // search, since neither table stores a single combined "name" anymore.
  function fullName(entry) {
    return [entry.firstName, entry.lastName].filter(Boolean).join(" ");
  }

  // Best-effort split of a single combined "First Last" walk-in name into
  // separate fields, since check-ins are stored with first_name/last_name
  // columns like the rest of the roster. Splits at the FIRST space, so a
  // multi-word last name like "Ruben Reyes Jr." comes out right (First:
  // Ruben, Last: Reyes Jr.); a multi-word first name would not -- there's no
  // way to tell those apart from a single combined string. Only walk-ins
  // need this: roster entries already carry first/last name separately from
  // the CSV upload.
  function splitName(fullNameStr) {
    const trimmed = String(fullNameStr || "").trim();
    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace === -1) return { firstName: trimmed, lastName: "" };
    return { firstName: trimmed.slice(0, firstSpace), lastName: trimmed.slice(firstSpace + 1) };
  }

  // ---------------------------------------------------------------------
  // Local (per-browser) teacher name storage
  // ---------------------------------------------------------------------

  function loadTeachers() {
    try {
      const raw = localStorage.getItem(STORAGE_TEACHERS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.error("Failed to load teacher names", e);
      return {};
    }
  }

  function saveTeachers() {
    localStorage.setItem(STORAGE_TEACHERS_KEY, JSON.stringify(teachers));
  }

  // ---------------------------------------------------------------------
  // Row <-> app-state mapping
  // ---------------------------------------------------------------------

  function mapStudentRow(row) {
    return {
      id: row.id,
      studentId: row.student_id || "",
      firstName: row.first_name,
      lastName: row.last_name,
      grade: row.grade,
    };
  }

  function mapCheckinRow(row) {
    return {
      id: row.id,
      studentId: row.student_id,
      aeriesStudentId: row.aeries_student_id || "",
      firstName: row.first_name,
      lastName: row.last_name,
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
    const { data, error } = await db
      .from("students")
      .select("*")
      .order("last_name", { ascending: true })
      .order("first_name", { ascending: true });
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
      .map((s) => ({
        student_id: s.studentId ? String(s.studentId).trim() : null,
        last_name: String(s.lastName || "").trim(),
        first_name: String(s.firstName || "").trim(),
        grade: normalizeGrade(s.grade),
      }))
      .filter((s) => s.last_name || s.first_name);

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

  // Aeries roster exports use varying header names across school configs;
  // these aliases (matched after lowercasing and stripping everything but
  // letters/digits, so "Last Name", "last_name", and "LastName" all match)
  // cover the common ones. Student ID is the only optional column -- a
  // roster without a district ID column still uploads fine, just with a
  // blank Student ID on export.
  const STUDENT_ID_HEADER_ALIASES = ["studentid", "id", "permanentid", "permid", "studentnumber", "sid"];
  const LAST_NAME_HEADER_ALIASES = ["lastname", "last", "surname"];
  const FIRST_NAME_HEADER_ALIASES = ["firstname", "first", "givenname"];
  const GRADE_HEADER_ALIASES = ["grade", "gradelevel"];

  function normalizeHeader(h) {
    return String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function findColumn(headers, aliases) {
    for (const alias of aliases) {
      const idx = headers.indexOf(alias);
      if (idx !== -1) return idx;
    }
    return -1;
  }

  function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return [];
    const headers = lines[0].split(",").map(normalizeHeader);

    const idIdx = findColumn(headers, STUDENT_ID_HEADER_ALIASES);
    const lastIdx = findColumn(headers, LAST_NAME_HEADER_ALIASES);
    const firstIdx = findColumn(headers, FIRST_NAME_HEADER_ALIASES);
    const gradeIdx = findColumn(headers, GRADE_HEADER_ALIASES);

    // Last Name, First Name, and Grade all need to be identifiable columns;
    // Student ID is the only one that's allowed to be missing.
    if (lastIdx === -1 || firstIdx === -1 || gradeIdx === -1) return [];

    const students = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const lastName = (cols[lastIdx] || "").trim();
      const firstName = (cols[firstIdx] || "").trim();
      const grade = (cols[gradeIdx] || "").trim();
      const studentId = idIdx === -1 ? "" : (cols[idIdx] || "").trim();
      if (lastName || firstName) students.push({ studentId, firstName, lastName, grade });
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
      showStatus(fullName(student) + " is already checked in today.", "error");
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
        aeries_student_id: student.studentId || null,
        first_name: student.firstName || "",
        last_name: student.lastName || "",
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
      showStatus("Couldn't check in " + fullName(student) + ": " + error.message, "error");
      return;
    }

    if (!checkins.some((c) => c.id === data.id)) {
      checkins.push(mapCheckinRow(data));
    }
    showStatus(fullName(student) + " checked in to " + room.name + ".", "success");
    showToast("✅ " + fullName(student) + " → " + room.name);
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
      showToast("Couldn't remove " + fullName(entry) + ": " + error.message);
      await loadCheckins();
      renderRosters();
      return;
    }
    showToast("Removed " + fullName(entry) + " from today's attendance.");
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
      .filter((s) => fullName(s).toLowerCase().includes(q))
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
      nameSpan.textContent = fullName(s);
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

      const teacherInput = document.createElement("input");
      teacherInput.type = "text";
      teacherInput.className = "teacher-input";
      teacherInput.placeholder = "Teacher name";
      teacherInput.value = teachers[room.id] || "";
      teacherInput.setAttribute("aria-label", room.name + " teacher name");
      // Saved on every keystroke (not just on blur) so an in-progress edit
      // survives even if a realtime update triggers a re-render mid-type.
      teacherInput.addEventListener("input", () => {
        teachers[room.id] = teacherInput.value;
        saveTeachers();
      });
      card.appendChild(teacherInput);

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
          label.textContent = fullName(entry) + (entry.walkin ? " (walk-in)" : "");
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

  function studentIdForExport(entry) {
    return entry.aeriesStudentId || "";
  }

  function exportCsv() {
    const rows = [["Student ID", "Last Name", "First Name", "Grade", "Teacher"]];
    checkins
      .slice()
      .sort((a, b) => {
        const teacherA = teachers[a.roomId] || "";
        const teacherB = teachers[b.roomId] || "";
        // Group rows by teacher; within the same teacher, keep the original
        // check-in-time order rather than an arbitrary one.
        return teacherA.localeCompare(teacherB) || new Date(a.time) - new Date(b.time);
      })
      .forEach((c) => {
        rows.push([
          studentIdForExport(c),
          c.lastName || "",
          c.firstName || "",
          GRADE_LABELS[c.grade] || c.grade,
          teachers[c.roomId] || "",
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
        showToast("That CSV didn't have any usable rows (expected Last Name, First Name, Grade columns — Student ID optional).");
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
    const { firstName, lastName } = splitName(name);
    await checkInStudent({ firstName, lastName, grade, walkin: true });
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
