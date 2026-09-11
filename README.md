# Monday Attendance

A fast, no-fuss attendance checker for a Monday school program. Type a
student's name, click their name, and they're automatically assigned to the
right room for their grade — with live-updating room rosters and capacity
counts, synced across every device running the app.

## How it works

1. **Search** — start typing a student's name in the search box. Matching
   students appear in a dropdown as you type.
2. **Click** — click the student (or press Enter to pick the highlighted
   match). They're instantly checked in and assigned to a room.
3. **Room assignment is automatic**, based on grade:

   | Grade(s)     | Primary room     | Overflows to      |
   |--------------|-------------------|--------------------|
   | TK, K        | TK-K (10 max)     | TK-K Overflow (10 max) |
   | 1st - 4th    | 1st - 4th (20 max) | Combo (20 max)     |
   | 5th - 8th    | 5th - 8th (20 max) | Combo (20 max)     |

   The Combo room accepts 1st - 8th graders and is used once a grade band's
   primary room is full. If every matching room is full, the app tells you
   so on screen instead of over-filling a room — check with a supervisor for
   those students.
4. **Rosters update live, everywhere** — as students are checked in from any
   device, every other open browser tab/laptop updates immediately with the
   current count (e.g. "7 / 10"), a progress bar, and the list of students
   assigned there. Multiple check-in tables can run at once and stay in
   sync.
5. **Made a wrong call on a room?** Drag a student's row from one room card
   onto another to move them there — it still respects that room's
   capacity, so you can't drag someone into a full room.

## Backend: Supabase

The roster and today's check-ins are stored in a Supabase project (Postgres
+ Realtime), so every device shows the same live state.

**One-time setup:**

1. In your Supabase project, go to **Project Settings → API** and copy:
   - the **Project URL**
   - the **anon / public** key (not the `service_role` key)
2. Edit [`config.js`](config.js) and paste those two values in:
   ```js
   window.SUPABASE_URL = "https://your-project-ref.supabase.co";
   window.SUPABASE_ANON_KEY = "your-anon-public-key";
   ```
3. Push to `main`. If this repo is connected to your Supabase project's
   GitHub integration (Project Settings → Integrations → GitHub), the schema
   in [`supabase/migrations`](supabase/migrations) is applied automatically
   on every push to the production branch. Otherwise, run the SQL in
   `supabase/migrations/20260910120000_init_schema.sql` once via the
   Supabase dashboard's SQL Editor.

That's it — reload the app and the banner at the top (which shows if
Supabase isn't connected yet) should disappear.

If you already ran an earlier version of this migration by hand (e.g. via
the SQL Editor), the `create table if not exists` statements will just
no-op — re-run the file and it'll pick up whatever it's missing (the
`checkins` update policy drag-and-drop needs, the unique index on
`student_id` Aeries sync needs, and/or the `room_teachers` table live
teacher names need).

The schema is three tables:
- `students` — the roster synced from Aeries (Student ID, last name, first name, grade).
- `checkins` — today's (and every previous day's) check-in events, each
  tied to a room and timestamp.
- `room_teachers` — one row per room, holding whoever's running it today.

Both have Row Level Security enabled with an open "anyone with the anon key
can read/write" policy — appropriate for a trusted internal tool with no
login. If this ever needs real user accounts or tighter access control, add
Supabase Auth and narrow the policies in a follow-up migration.

## Loading your student roster: Aeries sync

The roster comes exclusively from Aeries — there's no CSV upload or demo
sample roster anymore; **Sync from Aeries** (and, optionally,
auto-refresh) is the only way students get into the app:

- **Sync from Aeries** — pulls the current roster on demand and writes it
  to Supabase, so every device shows the freshly synced roster — not just
  the one that triggered the sync.
- **⚙️ Aeries Settings** — configure the sync (a proxy URL + shared secret,
  see below) and optionally turn on **auto-refresh** to re-pull
  periodically (every 5/15/30/60 min) while that device's browser tab
  stays open. These settings, unlike the roster itself, are saved only in
  that browser — set them up on whichever device(s) you want doing the
  syncing (often just one), and every other device still gets the result
  live via Supabase.

This app is a static site with nowhere safe to hold an Aeries API key
directly, so live sync needs one small piece of separate infrastructure: a
tiny Cloudflare Worker that holds the real Aeries credentials and proxies
just the roster request. See [`aeries-proxy/README.md`](aeries-proxy/README.md)
for what you need (an Aeries API key from your district) and how to deploy
it — it takes a few minutes and Cloudflare's free tier is enough. Until
that's set up, the roster stays empty (walk-ins still work in the
meantime — see below).

A failed sync (Aeries or the proxy is unreachable) shows an error and
leaves the current roster and today's check-ins untouched — it never
wipes data on error.

Re-syncing keeps an already-checked-in student matched to their check-in
(by upserting on their durable Aeries-issued Student ID instead of
replacing the whole roster table), so refreshing the roster mid-Monday
can't strand or double up someone who's already been checked in.

**Auto-refresh only ever adds or updates students — it never removes
anyone, even a student Aeries no longer lists as enrolled.** Only a
manual click of **Sync from Aeries** can remove withdrawn students, and
even then only after confirming with you exactly how many it found and
letting you cancel that part while still keeping everyone else's
add/update. This is deliberate: auto-refresh runs on a timer with nobody
watching, so it must never be the thing that can silently empty the
roster overnight — a bad or incomplete response from the proxy (a
network hiccup, a misconfigured school code, anything) can only ever
leave the roster as-is or grow it, never shrink it.

## Other tools in the header

- **Export Today's Attendance (CSV)** — downloads a CSV of everyone checked
  in today: Student ID, Last Name, First Name, Grade, and Teacher (the
  room's teacher name, if set — see below), sorted by teacher. Handy for
  records or for sharing with room leads. Walk-ins export with a blank
  Student ID, since they don't have a district-issued one.
- **Reset Today** — clears all of today's check-ins for everyone (with a
  confirmation prompt) so you can start a fresh session. It does not touch
  the roster or the teacher names below.
- **Walk-ins** — if a student isn't on the synced roster (or Aeries sync
  isn't set up yet), open "Student not on the list? Add a walk-in" under
  the search box to check them in manually by name and grade.
- Click the **✕** next to any name in a room's roster to remove that
  check-in entirely, or drag their row onto a different room card to move
  them there instead (see above).

Each room card also has a small **Teacher name** field. Whatever's typed
there is included as the Teacher column on export — handy for handing a
room's list straight to that teacher. Teacher names live in Supabase too,
same as the roster and check-ins, so typing one in on any device shows up
live on every other one — set it once on whichever device is at that room,
and everyone else's screen (and CSV export) picks it up automatically.

## Running it

This is a plain static site — no build step, no server required beyond
Supabase.

- **Locally**: open `index.html` directly in a browser, or serve the folder
  with any static file server (e.g. `python3 -m http.server`).
- **GitHub Pages**: in the repo settings, enable Pages for the `main`
  branch (root folder). The app will be live at
  `https://<org-or-user>.github.io/<repo-name>/`.

**On every deploy**, bump the version number in two places so browser tabs
left open from a previous Monday pick up the new code on their own:
`<meta name="app-version" content="…">` near the top of `index.html`, and
the matching `?v=…` on the `style.css`/`config.js`/`app.js` `<script>`/
`<link>` tags right below it. `app.js` polls `index.html` every few minutes
(and whenever a tab regains focus) for a version change and reloads itself
when it sees one — nothing else needs to change when you bump it.

## Data & privacy notes

- Roster, attendance, and teacher-name data all live in Supabase (Postgres),
  shared across every device that loads the app — this is what makes the
  live rosters work across multiple check-in tables.
- The app uses Supabase's public **anon key** with open read/write
  policies, appropriate for a trusted internal tool with no login screen.
  Don't point this app at a Supabase project that also holds sensitive
  unrelated data without tightening the policies first.
- If you set up Aeries live sync, its proxy URL and shared secret are kept
  only in that device's `localStorage` — never in Supabase, since the
  students/checkins tables are readable by anyone holding the app's anon
  key and a credential doesn't belong there. The roster it fetches (names,
  grades, Student IDs), however, is written to Supabase like any other
  roster update, so it does reach every device.
- Attendance is kept per calendar day (`check_date`, set from the check-in
  device's local date), so each Monday starts with a clean slate
  automatically without needing a manual reset — though **Reset Today** is
  still there if you want to clear a day early.

## Project structure

```
index.html                    Page markup (search box, walk-in form, room roster grid,
                               Aeries settings dialog)
style.css                     Styling
config.js                     Your Supabase project URL + anon key (fill this in)
app.js                        App logic: Supabase reads/writes, realtime sync, search,
                               room assignment, live rendering, attendance CSV export,
                               Aeries sync + auto-refresh
supabase/config.toml           Supabase CLI project config (optional, for local dev)
supabase/migrations/*.sql      Database schema (students, checkins, room_teachers tables + policies)
aeries-proxy/                 Optional Cloudflare Worker that proxies Aeries API
                               requests so the app never holds the Aeries API key
                               directly — see aeries-proxy/README.md
```
