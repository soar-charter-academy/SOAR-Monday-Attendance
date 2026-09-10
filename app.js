/*
 * Monday Attendance
 *
 * A single-device, no-backend attendance checker for a Monday school program.
 * Everything lives in the browser's localStorage, so it's meant to run on the
 * one laptop at the check-in table. See README.md for setup, roster format,
 * and notes on multi-device use.
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

  const STORAGE_ROSTER_KEY = "mondayAttendance.roster.v1";
  const STORAGE_CHECKIN_PREFIX = "mondayAttendance.checkins.v1.";
  const STORAGE_AERIES_CONFIG_KEY = "mondayAttendance.aeriesConfig.v1";
  const AERIES_SYNC_TIMEOUT_MS = 15000;

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  let roster = loadRoster(); // [{ id, name, grade }]
  let checkins = loadCheckins(); // [{ id, studentId, name, grade, roomId, time, walkin }]
  let activeSuggestionIndex = -1;
  let aeriesConfig = loadAeriesConfig(); // { workerUrl, sharedSecret, autoRefreshEnabled, autoRefreshMinutes, lastSyncedAt }
  let aeriesTimer = null;

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------

  const el = {
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
    syncAeriesBtn: document.getElementById("syncAeriesBtn"),
    aeriesSettingsBtn: document.getElementById("aeriesSettingsBtn"),
    aeriesSettingsDialog: document.getElementById("aeriesSettingsDialog"),
    aeriesSettingsForm: document.getElementById("aeriesSettingsForm"),
    aeriesSettingsCancel: document.getElementById("aeriesSettingsCancel"),
    aeriesWorkerUrl: document.getElementById("aeriesWorkerUrl"),
    aeriesSharedSecret: document.getElementById("aeriesSharedSecret"),
    aeriesAutoRefresh: document.getElementById("aeriesAutoRefresh"),
    aeriesRefreshMinutes: document.getElementById("aeriesRefreshMinutes"),
    aeriesLastSynced: document.getElementById("aeriesLastSynced"),
  };

  // ---------------------------------------------------------------------
  // Date / storage helpers
  // ---------------------------------------------------------------------

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function checkinStorageKey() {
    return STORAGE_CHECKIN_PREFIX + todayKey();
  }

  function loadRoster() {
    try {
      const raw = localStorage.getItem(STORAGE_ROSTER_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error("Failed to load roster", e);
      return [];
    }
  }

  function saveRoster() {
    localStorage.setItem(STORAGE_ROSTER_KEY, JSON.stringify(roster));
  }

  function loadCheckins() {
    try {
      const raw = localStorage.getItem(checkinStorageKey());
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error("Failed to load today's check-ins", e);
      return [];
    }
  }

  function saveCheckins() {
    localStorage.setItem(checkinStorageKey(), JSON.stringify(checkins));
  }

  function loadAeriesConfig() {
    const defaults = {
      workerUrl: "",
      sharedSecret: "",
      autoRefreshEnabled: false,
      autoRefreshMinutes: 15,
      lastSyncedAt: null,
    };
    try {
      const raw = localStorage.getItem(STORAGE_AERIES_CONFIG_KEY);
      return raw ? Object.assign(defaults, JSON.parse(raw)) : defaults;
    } catch (e) {
      console.error("Failed to load Aeries sync settings", e);
      return defaults;
    }
  }

  function saveAeriesConfig() {
    localStorage.setItem(STORAGE_AERIES_CONFIG_KEY, JSON.stringify(aeriesConfig));
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
  // Roster (student list) management
  // ---------------------------------------------------------------------

  // `opts.stableIds` is used for Aeries syncs: Aeries hands back a durable
  // per-student id, and reusing it (instead of regenerating index+name-slug
  // ids) means a student who's already checked in today stays matched to
  // their check-in across roster re-syncs, even if the Aeries order changes.
  function setRoster(students, opts) {
    opts = opts || {};
    roster = students.map((s, i) => ({
      id: opts.stableIds ? "aeries-" + String(s.id) : "s" + i + "-" + slug(s.name),
      name: s.name,
      grade: normalizeGrade(s.grade),
    }));
    saveRoster();
    renderAll();
  }

  function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
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
  // Aeries live sync
  // ---------------------------------------------------------------------
  //
  // Talks to the small proxy in aeries-proxy/ (see its README), which holds
  // the real Aeries credentials server-side. This app only ever calls that
  // proxy's GET /roster endpoint and expects { roster: [{id,name,grade}] }.
  // A failed sync leaves the current roster and today's check-ins untouched
  // — it never wipes data on error.

  async function syncFromAeries(opts) {
    opts = opts || {};
    if (!aeriesConfig.workerUrl) {
      if (!opts.silent) showToast("Set up Aeries sync in ⚙️ Aeries Settings first.");
      return;
    }

    const endpoint = aeriesConfig.workerUrl.replace(/\/$/, "") + "/roster";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AERIES_SYNC_TIMEOUT_MS);

    try {
      const res = await fetch(endpoint, {
        headers: aeriesConfig.sharedSecret ? { "X-App-Secret": aeriesConfig.sharedSecret } : {},
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.json()).error || "";
        } catch (e) {
          // response wasn't JSON; ignore and use the status alone
        }
        throw new Error("Sync proxy returned " + res.status + (detail ? " (" + detail + ")" : ""));
      }
      const data = await res.json();
      if (!data || !Array.isArray(data.roster)) {
        throw new Error("Unexpected response from sync proxy");
      }

      setRoster(data.roster, { stableIds: true });
      aeriesConfig.lastSyncedAt = new Date().toISOString();
      saveAeriesConfig();
      renderAeriesStatus();
      if (!opts.silent) showToast("✅ Synced " + data.roster.length + " students from Aeries.");
    } catch (err) {
      const message = err.name === "AbortError" ? "Sync proxy timed out" : err.message;
      console.error("Aeries sync failed", err);
      if (!opts.silent) showToast("⚠️ Aeries sync failed: " + message);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function scheduleAeriesAutoRefresh() {
    if (aeriesTimer) {
      clearInterval(aeriesTimer);
      aeriesTimer = null;
    }
    if (aeriesConfig.autoRefreshEnabled && aeriesConfig.workerUrl) {
      const ms = Math.max(1, Number(aeriesConfig.autoRefreshMinutes) || 15) * 60 * 1000;
      aeriesTimer = setInterval(() => syncFromAeries({ silent: true }), ms);
    }
  }

  function renderAeriesStatus() {
    if (!el.aeriesLastSynced) return;
    el.aeriesLastSynced.textContent = aeriesConfig.lastSyncedAt
      ? "Last synced: " + new Date(aeriesConfig.lastSyncedAt).toLocaleString()
      : "Never synced yet.";
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

  function checkInStudent(student) {
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
    checkins.push({
      id: "c" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      studentId: student.id || null,
      name: student.name,
      grade: student.grade,
      roomId: room.id,
      time: new Date().toISOString(),
      walkin: !!student.walkin,
    });
    saveCheckins();
    showStatus(student.name + " checked in to " + room.name + ".", "success");
    showToast("✅ " + student.name + " → " + room.name);
    renderRosters();
    clearSearch();
  }

  function removeCheckin(checkinId) {
    const entry = checkins.find((c) => c.id === checkinId);
    checkins = checkins.filter((c) => c.id !== checkinId);
    saveCheckins();
    renderRosters();
    if (entry) showToast("Removed " + entry.name + " from today's attendance.");
  }

  // Used by drag-and-drop between room cards: moves an already-checked-in
  // student to a different room, respecting that room's capacity (a manual
  // move can't over-fill a room any more than automatic assignment can).
  function moveCheckin(checkinId, targetRoomId) {
    const entry = checkins.find((c) => c.id === checkinId);
    if (!entry) return;
    if (entry.roomId === targetRoomId) return; // dropped back where it started

    const targetRoom = ROOMS.find((r) => r.id === targetRoomId);
    if (!targetRoom) return;

    if (countInRoom(targetRoomId) >= targetRoom.capacity) {
      showToast("⚠️ " + targetRoom.name + " is full — can't move " + entry.name + " there.");
      return;
    }

    const fromRoom = ROOMS.find((r) => r.id === entry.roomId);
    entry.roomId = targetRoomId;
    saveCheckins();
    renderRosters();
    showToast(entry.name + " moved to " + targetRoom.name + (fromRoom ? " from " + fromRoom.name : "") + ".");
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

      // Drop target: dragging a student's roster row onto a different
      // room card moves their check-in there (see moveCheckin).
      card.addEventListener("dragenter", (e) => {
        e.preventDefault(); // some browsers only allow drop if this is called too
        card.classList.add("drop-target");
      });
      card.addEventListener("dragover", (e) => {
        e.preventDefault(); // required to allow a drop at all
        e.dataTransfer.dropEffect = "move";
      });
      card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        card.classList.remove("drop-target");
        const checkinId = e.dataTransfer.getData("text/plain");
        if (checkinId) moveCheckin(checkinId, room.id);
      });

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
          li.draggable = true;
          li.title = "Drag to another room to move this student";
          li.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", entry.id);
            e.dataTransfer.effectAllowed = "move";
            // rAF so the drag image is captured before the style change —
            // applying "dragging" synchronously makes some browsers drag a
            // half-transparent ghost instead of the row's normal look.
            requestAnimationFrame(() => li.classList.add("dragging"));
          });
          li.addEventListener("dragend", () => li.classList.remove("dragging"));

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

  el.syncAeriesBtn.addEventListener("click", () => syncFromAeries());

  el.aeriesSettingsBtn.addEventListener("click", () => {
    el.aeriesWorkerUrl.value = aeriesConfig.workerUrl || "";
    el.aeriesSharedSecret.value = aeriesConfig.sharedSecret || "";
    el.aeriesAutoRefresh.checked = !!aeriesConfig.autoRefreshEnabled;
    el.aeriesRefreshMinutes.value = String(aeriesConfig.autoRefreshMinutes || 15);
    renderAeriesStatus();
    el.aeriesSettingsDialog.showModal();
  });

  el.aeriesSettingsCancel.addEventListener("click", () => el.aeriesSettingsDialog.close());

  el.aeriesSettingsForm.addEventListener("submit", () => {
    aeriesConfig.workerUrl = el.aeriesWorkerUrl.value.trim();
    aeriesConfig.sharedSecret = el.aeriesSharedSecret.value;
    aeriesConfig.autoRefreshEnabled = el.aeriesAutoRefresh.checked;
    aeriesConfig.autoRefreshMinutes = Number(el.aeriesRefreshMinutes.value);
    saveAeriesConfig();
    scheduleAeriesAutoRefresh();
    showToast("Aeries sync settings saved.");
    if (aeriesConfig.workerUrl) syncFromAeries();
  });

  el.uploadRosterBtn.addEventListener("click", () => el.csvFile.click());

  el.csvFile.addEventListener("change", () => {
    const file = el.csvFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const students = parseCsv(String(reader.result));
      if (students.length === 0) {
        showToast("That CSV didn't have any usable rows (expected Name, Grade columns).");
        return;
      }
      setRoster(students);
      showToast("Loaded " + students.length + " students from " + file.name);
    };
    reader.readAsText(file);
    el.csvFile.value = "";
  });

  el.sampleRosterBtn.addEventListener("click", () => {
    setRoster(SAMPLE_ROSTER);
    showToast("Loaded the sample demo roster (" + SAMPLE_ROSTER.length + " students).");
  });

  el.exportBtn.addEventListener("click", () => {
    if (checkins.length === 0) {
      showToast("No check-ins yet today.");
      return;
    }
    exportCsv();
  });

  el.resetBtn.addEventListener("click", () => {
    if (checkins.length === 0) {
      showToast("Today's attendance is already empty.");
      return;
    }
    if (confirm("Clear all of today's check-ins? This cannot be undone.")) {
      checkins = [];
      saveCheckins();
      renderRosters();
      showToast("Today's attendance has been reset.");
    }
  });

  el.walkinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = el.walkinName.value.trim();
    const grade = normalizeGrade(el.walkinGrade.value);
    if (!name || !grade) return;
    checkInStudent({ name, grade, walkin: true });
    el.walkinForm.reset();
    el.walkinDetails.open = false;
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  renderAll();
  renderAeriesStatus();
  scheduleAeriesAutoRefresh();
  if (aeriesConfig.autoRefreshEnabled && aeriesConfig.workerUrl) {
    syncFromAeries({ silent: true });
  }
})();
