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

The schema is two tables:
- `students` — the uploaded roster (name, grade).
- `checkins` — today's (and every previous day's) check-in events, each
  tied to a room and timestamp.

Both have Row Level Security enabled with an open "anyone with the anon key
can read/write" policy — appropriate for a trusted internal tool with no
login. If this ever needs real user accounts or tighter access control, add
Supabase Auth and narrow the policies in a follow-up migration.

## Loading your student roster

Click **Upload Roster (CSV)** and choose a CSV file with two columns:

```csv
Name,Grade
Ava Thompson,TK
Noah Patel,K
Elijah Garcia,1
...
```

Grade values accepted: `TK`, `K`, and `1`-`8`. A ready-to-edit template is
included at [`sample-roster.csv`](sample-roster.csv) — export your school's
roster into that same format (e.g. from a spreadsheet: File → Download →
CSV) and upload it. Uploading replaces the previously stored roster for
everyone, so only do this when your roster actually changes.

Don't have a real roster handy? Click **Load Sample Roster** to try the app
with 21 made-up demo students spread across every grade band.

## Other tools in the header

- **Export Today's Attendance (CSV)** — downloads a CSV of everyone checked
  in today: name, grade, assigned room, and check-in time. Handy for
  records or for sharing with room leads.
- **Reset Today** — clears all of today's check-ins for everyone (with a
  confirmation prompt) so you can start a fresh session. It does not touch
  the roster.
- **Walk-ins** — if a student isn't on the uploaded roster, open "Student
  not on the list? Add a walk-in" under the search box to check them in
  manually by name and grade.
- Made a mistake? Click the **✕** next to any name in a room's roster to
  remove that check-in (e.g. to move a student to a different room — remove
  them, then search and check them in again).

## Running it

This is a plain static site — no build step, no server required beyond
Supabase.

- **Locally**: open `index.html` directly in a browser, or serve the folder
  with any static file server (e.g. `python3 -m http.server`).
- **GitHub Pages**: in the repo settings, enable Pages for the `main`
  branch (root folder). The app will be live at
  `https://<org-or-user>.github.io/<repo-name>/`.

## Data & privacy notes

- Roster and attendance data live in Supabase (Postgres), shared across
  every device that loads the app — this is what makes the live rosters
  work across multiple check-in tables.
- The app uses Supabase's public **anon key** with open read/write
  policies, appropriate for a trusted internal tool with no login screen.
  Don't point this app at a Supabase project that also holds sensitive
  unrelated data without tightening the policies first.
- Attendance is kept per calendar day (`check_date`, set from the check-in
  device's local date), so each Monday starts with a clean slate
  automatically without needing a manual reset — though **Reset Today** is
  still there if you want to clear a day early.

## Project structure

```
index.html                    Page markup (search box, walk-in form, room roster grid)
style.css                     Styling
config.js                     Your Supabase project URL + anon key (fill this in)
app.js                        App logic: Supabase reads/writes, realtime sync, search,
                               room assignment, live rendering, CSV import/export
sample-roster.csv             Template / demo roster (2-column CSV: Name, Grade)
supabase/config.toml           Supabase CLI project config (optional, for local dev)
supabase/migrations/*.sql      Database schema (students, checkins tables + policies)
```
