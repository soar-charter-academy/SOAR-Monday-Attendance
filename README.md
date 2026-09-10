# Monday Attendance

A fast, no-fuss attendance checker for a Monday school program. Type a
student's name, click their name, and they're automatically assigned to the
right room for their grade — with live-updating room rosters and capacity
counts, synced across every device running the app.

## How it works

1. **Sign in** — with a `@soarcharteracademy.org` Google account (see
   **Staff sign-in** below). Nothing else on the page works until you do.
2. **Search** — start typing a student's name in the search box. Matching
   students appear in a dropdown as you type.
3. **Click** — click the student (or press Enter to pick the highlighted
   match). They're instantly checked in and assigned to a room.
4. **Room assignment is automatic**, based on grade:

   | Grade(s)     | Primary room     | Overflows to      |
   |--------------|-------------------|--------------------|
   | TK, K        | TK-K (10 max)     | TK-K Overflow (10 max) |
   | 1st - 4th    | 1st - 4th (20 max) | Combo (20 max)     |
   | 5th - 8th    | 5th - 8th (20 max) | Combo (20 max)     |

   The Combo room accepts 1st - 8th graders and is used once a grade band's
   primary room is full. If every matching room is full, the app tells you
   so on screen instead of over-filling a room — check with a supervisor for
   those students.
5. **Rosters update live, everywhere** — as students are checked in from any
   device, every other open browser tab/laptop updates immediately with the
   current count (e.g. "7 / 10"), a progress bar, and the list of students
   assigned there. Multiple check-in tables can run at once and stay in
   sync.
6. **Made a wrong call on a room?** Drag a student's row from one room card
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
Supabase isn't connected yet) should disappear. You'll land on a sign-in
screen next — see **Staff sign-in** below to create your first account.

If you already ran an earlier version of this migration by hand (e.g. via
the SQL Editor), the `create table if not exists` statements will just
no-op — re-run the file and it'll pick up whatever it's missing (the
`checkins` update policy drag-and-drop needs, the unique index on
`student_id` Aeries sync needs, and/or the `room_teachers` table live
teacher names need).

The schema is three tables:
- `students` — the uploaded roster (Student ID, last name, first name, grade).
- `checkins` — today's (and every previous day's) check-in events, each
  tied to a room and timestamp.
- `room_teachers` — one row per room, holding whoever's running it today.

All three have Row Level Security enabled, requiring a signed-in Supabase
Auth session for every read and write — see **Staff sign-in** below.

## Staff sign-in

The app requires signing in with a **Google account on the
`@soarcharteracademy.org` domain** before showing any student data —
staff use their existing school Google account; there's no separate
password to create or manage, and no other domain can sign in.

**One-time setup, in this order:**

1. **Google Cloud Console** → create (or reuse) a project → **APIs &
   Services → OAuth consent screen**:
   - If `soarcharteracademy.org` is a Google Workspace domain, set
     **User Type** to **Internal**. This is the strongest option — Google
     itself refuses the sign-in for any account outside the Workspace, so
     a wrong-domain account never even reaches this app.
   - Otherwise, **External** still works — this app's own checks (below)
     enforce the domain instead of Google doing it for you at the account
     picker.
2. Still in Google Cloud Console: **Credentials → Create Credentials →
   OAuth client ID → Web application**. For **Authorized redirect URIs**,
   use the callback URL Supabase shows you in the next step.
3. **Supabase dashboard → Authentication → Providers → Google** — enable
   it, paste the Client ID + Client Secret from step 2, save. Copy the
   callback URL shown here into step 2 if you haven't already.
4. **Supabase dashboard → Authentication → URL Configuration → Redirect
   URLs** — add every URL this app is actually served from (its GitHub
   Pages URL, plus e.g. `http://localhost:8000` if you test locally).
   Google OAuth will refuse to redirect back to a URL that isn't listed
   here.

That's it — no accounts to create per staff member. Anyone signing in
with a `@soarcharteracademy.org` Google account gets in immediately, with
the same access as everyone else (there's no separate admin/staff role).
Signing out (the **Sign Out** button in the header) clears that device's
session; signing back in picks up right where the shared
roster/check-ins/teacher names already are, since none of that is tied to
who's signed in.

**Where the domain restriction is actually enforced:** every table's RLS
policy checks a `is_org_user()` database function that reads the signed-in
user's email off their Supabase session and requires it to end in
`@soarcharteracademy.org` — this is checked on every single request, at
the database, which is what actually protects the data regardless of what
Google or the app's UI do. The app also does its own check right after
sign-in (immediately signing out and showing an error for a wrong-domain
account) purely so that mistake produces a clear message instead of a
confusingly broken, empty app — that check alone would **not** stop
someone from reading data by calling the Supabase API directly, only the
database-level policy does that.

The Supabase **anon key** in `config.js` is still required (it's what lets
the page talk to Supabase at all — including attempting a sign-in), but it
no longer grants access to any data by itself: every policy now requires
both an authenticated session and the domain check above. That matters
here because the key sits in this repo's public source — see **Data &
privacy notes** below.

## Loading your student roster

Click **Upload Roster (CSV)** and choose a CSV file with a header row and
columns for Student ID, Last Name, First Name, and Grade — matching the
columns a typical Aeries roster export uses:

```csv
Student ID,Last Name,First Name,Grade
100001,Thompson,Ava,TK
100004,Patel,Noah,K
100006,Garcia,Elijah,1
...
```

The header names are matched loosely (case-insensitive, ignoring spaces —
so `Student ID`, `StudentID`, and `student_id` all work; `Last`/`Surname`
and `First`/`Given Name` are also recognized). **Student ID is optional** —
a roster without a district ID column still uploads fine, just with a
blank Student ID on export; Last Name, First Name, and Grade are required.

Grade values accepted: `TK`, `K`, and `1`-`8`. A ready-to-edit template is
included at [`sample-roster.csv`](sample-roster.csv) — export your school's
roster into that same format (e.g. from Aeries, or a spreadsheet: File →
Download → CSV) and upload it. Uploading replaces the previously stored
roster for everyone, so only do this when your roster actually changes.

Don't have a real roster handy? Click **Load Sample Roster** to try the app
with 21 made-up demo students (with fake Student IDs) spread across every
grade band.

## Live sync from Aeries (optional)

If your school uses Aeries as its student information system, the app can
pull a live roster straight from it instead of a manually uploaded CSV:

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
it — it takes a few minutes and Cloudflare's free tier is enough.

A failed sync (Aeries or the proxy is unreachable) shows an error and
leaves the current roster and today's check-ins untouched — it never
wipes data on error. CSV upload and the sample roster remain available as
a fallback / for schools not using Aeries.

Re-syncing keeps an already-checked-in student matched to their check-in
(by upserting on their durable Aeries-issued Student ID instead of
replacing the whole roster table), so refreshing the roster mid-Monday
can't strand or double up someone who's already been checked in.

## Other tools in the header

- **Export Today's Attendance (CSV)** — downloads a CSV of everyone checked
  in today: Student ID, Last Name, First Name, Grade, and Teacher (the
  room's teacher name, if set — see below), sorted by teacher. Handy for
  records or for sharing with room leads. Walk-ins export with a blank
  Student ID, since they don't have a district-issued one.
- **Reset Today** — clears all of today's check-ins for everyone (with a
  confirmation prompt) so you can start a fresh session. It does not touch
  the roster or the teacher names below.
- **Walk-ins** — if a student isn't on the uploaded roster, open "Student
  not on the list? Add a walk-in" under the search box to check them in
  manually by name and grade.
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
- All of that requires signing in with a `@soarcharteracademy.org` Google
  account (see **Staff sign-in** above), enforced by RLS policies at the
  database level — the public **anon key** in `config.js` no longer grants
  read or write access on its own, only the ability to attempt a sign-in.
  This matters specifically because this repo (and therefore `config.js`)
  is **public on GitHub**: without the domain-restricted sign-in, anyone
  who found the repo could have read or edited every student's name,
  grade, and attendance record directly via the Supabase API, without even
  opening the app. Don't point this app at a Supabase project that also
  holds other sensitive data without reviewing its policies independently.
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
index.html                    Page markup (sign-in screen, search box, walk-in form,
                               room roster grid, Aeries settings dialog)
style.css                     Styling
config.js                     Your Supabase project URL + anon key (fill this in)
app.js                        App logic: sign-in/sign-out, Supabase reads/writes,
                               realtime sync, search, room assignment, live
                               rendering, CSV import/export, Aeries sync + auto-refresh
sample-roster.csv             Template / demo roster (Student ID, Last Name, First Name, Grade)
supabase/config.toml           Supabase CLI project config (optional, for local dev)
supabase/migrations/*.sql      Database schema (students, checkins, room_teachers tables + policies)
aeries-proxy/                 Optional Cloudflare Worker that proxies Aeries API
                               requests so the app never holds the Aeries API key
                               directly — see aeries-proxy/README.md
```
