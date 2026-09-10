# Monday Attendance

A fast, no-fuss attendance checker for a Monday school program. Type a
student's name, click their name, and they're automatically assigned to the
right room for their grade — with live-updating room rosters and capacity
counts on screen the whole time.

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
4. **Rosters update live** — as students are checked in, each room's card
   updates immediately with its current count (e.g. "7 / 10"), a progress
   bar, and the list of students currently assigned there. No refresh
   needed.
5. **Teacher name** — each room card has a "Teacher name" field at the top;
   type in whoever's running that room. It's saved per room (like the
   roster) and stays put across days and resets — update it only when it
   changes.

## Live sync from Aeries (optional)

If your school uses Aeries as its student information system, the app can
pull a live roster straight from it instead of a manually uploaded CSV:

- **Sync from Aeries** — pulls the current roster on demand.
- **⚙️ Aeries Settings** — configure the sync (a proxy URL + shared secret,
  see below) and optionally turn on **auto-refresh** to re-pull
  periodically (every 5/15/30/60 min) while the check-in laptop's browser
  tab stays open.

This app is a static site with nowhere safe to hold an Aeries API key
directly, so live sync needs one small piece of separate infrastructure: a
tiny Cloudflare Worker that holds the real Aeries credentials and proxies
just the roster request. See [`aeries-proxy/README.md`](aeries-proxy/README.md)
for what you need (an Aeries API key from your district) and how to deploy
it — it takes a few minutes and Cloudflare's free tier is enough.

A failed sync (Aeries or the proxy is unreachable) shows an error and
leaves the current roster and today's check-ins untouched — it never wipes
data on error. CSV upload and the sample roster remain available as a
fallback / for schools not using Aeries.

## Loading your student roster

The app needs a list of students and their grades before you can search.
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
CSV) and upload it.

Don't have a real roster handy? Click **Load Sample Roster** to try the app
with 21 made-up demo students spread across every grade band.

Your uploaded roster is remembered in the browser (via `localStorage`) so
you don't need to re-upload it every Monday — just re-upload when your
roster changes (new students, grade promotions, etc.).

## Other tools in the header

- **Export Today's Attendance (CSV)** — downloads a CSV of everyone checked
  in today, with columns: Student ID, Name, Room, Teacher, Date, sorted
  alphabetically by Teacher. Student ID is only populated for students
  synced from Aeries (it's blank for a CSV-uploaded roster, the sample
  roster, or a walk-in, since none of those carry a real district ID);
  Teacher comes from that room's "Teacher name" field.
- **Reset Today** — clears all of today's check-ins (with a confirmation
  prompt) so you can start a fresh session. It does not touch your uploaded
  roster.
- **Walk-ins** — if a student isn't on the uploaded roster, open "Student
  not on the list? Add a walk-in" under the search box to check them in
  manually by name and grade.
- **Move a student between rooms** — drag their name from one room's roster
  and drop it onto a different room card. Blocked if the target room is
  already full (you'll get a message instead of an over-filled room).
- Made a mistake and just want them gone? Click the **✕** next to their name
  to remove the check-in entirely.

## Running it

This is a plain static site — no build step, no server required.

- **Locally**: open `index.html` directly in a browser, or serve the folder
  with any static file server (e.g. `python3 -m http.server`).
- **GitHub Pages**: in the repo settings, enable Pages for the `main`
  branch (root folder). The app will be live at
  `https://<your-username>.github.io/<repo-name>/`.

### Deploying an update

This is meant to run unattended on one check-in laptop, possibly with the
browser tab left open across multiple Mondays — so the app checks on its own
for a newer deployed version (every 5 minutes, and whenever the tab regains
focus) and reloads itself when it finds one, rather than relying on you to
remember to hard-refresh.

**Whenever you push a change that should reach that open tab, bump the
version** — in `index.html`, update all three of:
- `<meta name="app-version" content="N">`
- `style.css?v=N`
- `app.js?v=N`

to the same next number `N`. Forgetting this doesn't break anything on a
fresh page load, but an already-open tab won't notice the update until the
version marker actually changes.

## Data & privacy notes

- All roster and attendance data is stored **only in the browser's
  `localStorage`** on the device running the app — nothing is sent to a
  server, **unless you set up Aeries live sync** (above), in which case the
  roster (names + grades) is fetched from your district's Aeries system via
  the small proxy described in `aeries-proxy/`. Attendance/check-in data is
  never sent anywhere either way. That means:
  - It's private to that one device/browser.
  - Clearing browser data/history will erase the roster and any unexported
    attendance for that day.
  - This app is designed for **one check-in device** (e.g. the laptop at
    the front table). It does not currently sync across multiple devices
    or browsers in real time — if you need attendance visible live on
    multiple screens at once, that would require adding a small shared
    backend (e.g. Firebase, Supabase, or a simple API) as a future
    enhancement.
- Attendance is kept per calendar day, so each Monday starts with a clean
  slate automatically (based on the device's local date).

## Project structure

```
index.html         Page markup (search box, walk-in form, room roster grid,
                    Aeries settings dialog)
style.css           Styling
app.js              All app logic: roster import, search, room assignment,
                    live rendering, CSV export, localStorage persistence,
                    Aeries sync + auto-refresh
sample-roster.csv   Template / demo roster (2-column CSV: Name, Grade)
aeries-proxy/       Optional Cloudflare Worker that proxies Aeries API
                    requests so the app never holds the Aeries API key
                    directly — see aeries-proxy/README.md
```
