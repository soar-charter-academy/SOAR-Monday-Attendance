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


  // Per-room teacher names live in Supabase (room_teachers) like everything
  // else, so they show up live on every device -- saves are debounced (see
  // saveTeacherName) rather than firing on every keystroke.
  const TEACHER_SAVE_DEBOUNCE_MS = 500;

  // Aeries sync settings (proxy URL + shared secret) are per-browser
  // localStorage, unlike the roster/check-ins/teacher names above: the
  // shared secret is a credential, and students/checkins/room_teachers are
  // readable by anyone holding the app's anon key (see the migration's RLS
  // policies) -- storing it in Supabase would hand it to every viewer. A
  // sync triggered from any one configured device still updates the shared
  // Supabase roster for everyone, same as a CSV upload would.
  const STORAGE_AERIES_CONFIG_KEY = "mondayAttendance.aeriesConfig.v1";
  const AERIES_SYNC_TIMEOUT_MS = 15000;

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
  let teachers = {}; // { [roomId]: teacherName } -- loaded from Supabase, kept live via realtime
  let teacherSaveTimers = {}; // { [roomId]: timeoutId } -- debounces saveTeacherName's writes
  let aeriesConfig = loadAeriesConfig(); // { workerUrl, sharedSecret, autoRefreshEnabled, autoRefreshMinutes, lastSyncedAt }
  let aeriesTimer = null;

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
  // Teacher names (Supabase-backed, live across devices)
  // ---------------------------------------------------------------------

  async function loadTeachers() {
    if (!db) {
      teachers = {};
      return;
    }
    const { data, error } = await db.from("room_teachers").select("*");
    if (error) {
      console.error("Failed to load teacher names", error);
      showToast("Couldn't load teacher names: " + error.message);
      return;
    }
    teachers = {};
    (data || []).forEach((row) => {
      teachers[row.room_id] = row.teacher_name || "";
    });
  }

  // Debounced so a device typing a teacher name doesn't write on every
  // keystroke -- it still updates the in-memory `teachers` value (and thus
  // this device's own CSV export) immediately, only the Supabase write and
  // the resulting broadcast to other devices are delayed.
  function saveTeacherName(roomId, name) {
    teachers[roomId] = name;
    if (!db) return;
    clearTimeout(teacherSaveTimers[roomId]);
    teacherSaveTimers[roomId] = setTimeout(async () => {
      const { error } = await db
        .from("room_teachers")
        .upsert(
          { room_id: roomId, teacher_name: name, updated_at: new Date().toISOString() },
          { onConflict: "room_id" }
        );
      if (error) {
        console.error(error);
        showToast("Couldn't save teacher name: " + error.message);
      }
    }, TEACHER_SAVE_DEBOUNCE_MS);
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

  // Aeries hands back a durable per-student district ID, and upserting on
  // it (rather than wiping the table and reinserting) keeps the same
  // internal row -- and therefore the same FK -- for a student who's
  // already checked in today, so a roster refresh mid-Monday can't strand
  // that check-in or let it double up.
  //
  // Returns true/false so callers know whether to show their own success
  // toast -- every failure path below already shows its own error toast,
  // and showToast() replaces whatever's currently displayed, so a caller
  // that always shows a success toast regardless of the outcome would
  // instantly bury that error under a false "success".
  async function setRoster(students, opts) {
    opts = opts || {};
    if (!db) {
      showToast("Connect Supabase first — see config.js.");
      return false;
    }
    const rows = students
      .map((s) => ({
        student_id: s.studentId ? String(s.studentId).trim() : null,
        last_name: String(s.lastName || "").trim(),
        first_name: String(s.firstName || "").trim(),
        grade: normalizeGrade(s.grade),
      }))
      .filter((s) => (s.last_name || s.first_name) && s.student_id);
    // A synced roster with no IDed rows at all (e.g. a proxy hiccup
    // returning an empty/malformed roster) would otherwise fall through to
    // the "remove withdrawn students" step below with an empty keepIds
    // set, deleting every single student. Refuse instead.
    if (rows.length === 0) {
      showToast("Aeries sync returned no usable students -- roster left unchanged.");
      return false;
    }

    const { error: upsertErr } = await db.from("students").upsert(rows, { onConflict: "student_id" });
    if (upsertErr) {
      console.error(upsertErr);
      showToast("Couldn't save the synced roster: " + upsertErr.message);
      return false;
    }

    // Removing anyone no longer in the freshly synced roster (e.g.
    // withdrawn) only ever happens when opts.pruneRemoved is explicitly
    // set -- that's the manual "Sync from Aeries" button, after confirming
    // with whoever clicked it (below). A silent/automatic sync (scheduled
    // auto-refresh, or the one on initial page load) never sets it, so it
    // can only ever add or update students -- it can't be the thing that
    // empties the roster overnight with nobody having clicked anything.
    if (opts.pruneRemoved) {
      const { data: allRows, error: selErr } = await db.from("students").select("id, student_id");
      if (selErr) {
        console.error(selErr);
        showToast("Synced, but couldn't check for withdrawn students: " + selErr.message);
      } else {
        const keepIds = new Set(rows.map((r) => r.student_id));
        const idsToRemove = (allRows || [])
          .filter((r) => !r.student_id || !keepIds.has(r.student_id))
          .map((r) => r.id);
        if (idsToRemove.length > 0) {
          const confirmed = confirm(
            "This sync found " + idsToRemove.length + " student(s) no longer in Aeries's roster.\n\n" +
            "Remove them from Monday Attendance too? Cancel keeps them and still saves everyone else."
          );
          if (confirmed) {
            const { error: delErr } = await db.from("students").delete().in("id", idsToRemove);
            if (delErr) {
              console.error(delErr);
              showToast("Synced, but couldn't remove withdrawn students: " + delErr.message);
            }
          } else {
            showToast("Kept " + idsToRemove.length + " student(s) not in the new Aeries roster.");
          }
        }
      }
    }

    await loadRoster();
    renderAll();
    return true;
  }

  // ---------------------------------------------------------------------
  // Aeries live sync
  // ---------------------------------------------------------------------
  //
  // Talks to the small proxy in aeries-proxy/ (see its README), which holds
  // the real Aeries credentials server-side. This app only ever calls that
  // proxy's GET /roster endpoint and expects
  // { roster: [{id,name,firstName,lastName,grade}] }. A failed sync leaves
  // the current roster and today's check-ins untouched — it never wipes
  // data on error.

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

      const students = data.roster.map((s) => ({
        studentId: s.id != null ? String(s.id) : "",
        firstName: s.firstName || "",
        lastName: s.lastName || "",
        grade: s.grade,
      }));
      // Only a manual click (opts.silent unset) is allowed to remove
      // withdrawn students -- and even then only after setRoster confirms
      // it with whoever clicked. A silent/automatic sync (scheduled
      // auto-refresh, or the initial one on page load) only ever adds or
      // updates students, so it can never silently empty the roster.
      const saved = await setRoster(students, { pruneRemoved: !opts.silent });
      if (saved) {
        aeriesConfig.lastSyncedAt = new Date().toISOString();
        saveAeriesConfig();
        renderAeriesStatus();
        // setRoster already showed its own error toast on failure -- only
        // show this one when the roster was actually saved.
        if (!opts.silent) showToast("✅ Synced " + students.length + " students from Aeries.");
      }
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

  // Used by drag-and-drop between room cards: moves an already-checked-in
  // student to a different room, respecting that room's capacity (a manual
  // move can't over-fill a room any more than automatic assignment can).
  async function moveCheckin(checkinId, targetRoomId) {
    const entry = checkins.find((c) => c.id === checkinId);
    if (!db || !entry) return;
    if (entry.roomId === targetRoomId) return; // dropped back where it started

    const targetRoom = ROOMS.find((r) => r.id === targetRoomId);
    if (!targetRoom) return;

    if (countInRoom(targetRoomId) >= targetRoom.capacity) {
      showToast("⚠️ " + targetRoom.name + " is full — can't move " + fullName(entry) + " there.");
      return;
    }

    const fromRoom = ROOMS.find((r) => r.id === entry.roomId);
    const previousRoomId = entry.roomId;
    entry.roomId = targetRoomId;
    renderRosters();

    const { error } = await db.from("checkins").update({ room_id: targetRoomId }).eq("id", checkinId);
    if (error) {
      console.error(error);
      showToast("Couldn't move " + fullName(entry) + ": " + error.message);
      entry.roomId = previousRoomId; // roll back the optimistic move
      renderRosters();
      return;
    }
    showToast(fullName(entry) + " moved to " + targetRoom.name + (fromRoom ? " from " + fromRoom.name : "") + ".");
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
        { event: "UPDATE", schema: "public", table: "checkins" },
        (payload) => {
          // Currently only room moves (drag-and-drop) update a check-in row
          // in place; picking up the whole row keeps this correct even if
          // that ever changes.
          if (payload.new.check_date !== todayKey()) return;
          const idx = checkins.findIndex((c) => c.id === payload.new.id);
          if (idx !== -1) {
            checkins[idx] = mapCheckinRow(payload.new);
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

    db.channel("room-teachers-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_teachers" },
        (payload) => {
          const row = payload.new && Object.keys(payload.new).length > 0 ? payload.new : payload.old;
          if (!row) return;
          const name = payload.eventType === "DELETE" ? "" : row.teacher_name || "";
          // Skip re-rendering when this is just the echo of a write this
          // device itself just made (teachers[room.id] already matches) --
          // avoids rebuilding every room card, which would drop focus out
          // of whichever teacher-name field is being typed in right now.
          if (teachers[row.room_id] === name) return;
          teachers[row.room_id] = name;
          renderRosters();
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

      const teacherInput = document.createElement("input");
      teacherInput.type = "text";
      teacherInput.className = "teacher-input";
      teacherInput.placeholder = "Teacher name";
      teacherInput.value = teachers[room.id] || "";
      teacherInput.setAttribute("aria-label", room.name + " teacher name");
      // teachers[room.id] updates synchronously on every keystroke (so an
      // in-progress edit survives even if a re-render happens mid-type),
      // but the Supabase write -- and the live update it sends to every
      // other device -- is debounced. See saveTeacherName.
      teacherInput.addEventListener("input", () => {
        saveTeacherName(room.id, teacherInput.value);
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
  // Update detection
  // ---------------------------------------------------------------------
  //
  // This is meant to run unattended, possibly with the tab left open across
  // multiple Mondays — normal browser caching won't pick up a new deploy for
  // a tab that's never re-navigated. So instead of relying on cache headers
  // alone, periodically re-fetch index.html with caching explicitly
  // disabled and compare its <meta name="app-version"> against the version
  // this page loaded with; a mismatch means a newer version has been
  // deployed, so reload to pick it up.

  const CURRENT_APP_VERSION = document.querySelector('meta[name="app-version"]').content;
  const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  async function checkForUpdate() {
    try {
      const res = await fetch("index.html?_=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return;
      const html = await res.text();
      const match = html.match(/<meta\s+name=["']app-version["']\s+content=["']([^"']+)["']/i);
      const latestVersion = match && match[1];
      if (latestVersion && latestVersion !== CURRENT_APP_VERSION) {
        showToast("Updating to the latest version…");
        setTimeout(() => location.reload(), 1500);
      }
    } catch (e) {
      // Offline or the network hiccuped — not worth bothering anyone about;
      // it'll just check again next time.
      console.error("Update check failed", e);
    }
  }

  setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
  // Also check right when the tab regains focus/visibility — the common
  // case of someone waking the device or switching back after a while.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkForUpdate();
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  async function init() {
    updateDbBanner();
    await Promise.all([loadRoster(), loadCheckins(), loadTeachers()]);
    renderAll();
    subscribeRealtime();
    renderAeriesStatus();
    scheduleAeriesAutoRefresh();
    if (aeriesConfig.autoRefreshEnabled && aeriesConfig.workerUrl) {
      syncFromAeries({ silent: true });
    }
  }

  init();
})();
