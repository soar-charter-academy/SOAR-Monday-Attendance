-- Monday Attendance: initial schema
-- Students on the roster, today's (and historical) check-in events, and
-- each room's teacher name.

create extension if not exists pgcrypto;

create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  -- Aeries-issued student ID. Nullable: a roster CSV without an ID column
  -- still uploads fine, just with a blank Student ID on export.
  student_id text,
  last_name text not null,
  first_name text not null,
  grade text not null,
  created_at timestamptz not null default now()
);

create table if not exists checkins (
  id uuid primary key default gen_random_uuid(),
  -- Internal FK to students.id, used to detect "already checked in today"
  -- and to catch roster-side updates/deletes. Not the district student ID.
  student_id uuid references students(id) on delete set null,
  -- Copied from students.student_id at check-in time, so a check-in's
  -- exported Student ID stays correct even if the roster is later replaced.
  -- Null for walk-ins, which never have a district-issued ID.
  aeries_student_id text,
  last_name text not null,
  first_name text not null,
  grade text not null,
  room_id text not null,
  walkin boolean not null default false,
  checked_in_at timestamptz not null default now(),
  -- Set explicitly by the app to the check-in device's local calendar date,
  -- so "today" always matches what the person checking students in sees on
  -- screen, regardless of server/UTC time. Do NOT default this from now()/
  -- current_date, which uses UTC and can drift a day off from local time.
  check_date date not null
);

-- One row per room, holding whoever's running it today. app.js's ROOMS
-- constant is the list of valid room_id values; there's no FK here since
-- ROOMS lives in code, not a table.
create table if not exists room_teachers (
  room_id text primary key,
  teacher_name text not null default '',
  updated_at timestamptz not null default now()
);

-- Lets an Aeries re-sync upsert on student_id (see setRoster's preserveIds
-- option in app.js) instead of wiping and recreating every row, so an
-- already checked-in student's internal id -- and their check-in's FK to
-- it -- survives a mid-Monday roster refresh. Multiple CSV-uploaded/
-- walk-in rows with no district ID can still all have a null student_id
-- without colliding -- Postgres treats every NULL as distinct from every
-- other NULL for uniqueness purposes, so nothing partial is needed for
-- that.
--
-- IMPORTANT: this must stay a plain (non-partial) index. An earlier
-- version of this file made it partial ("where student_id is not null"),
-- which broke the upsert above: PostgREST's onConflict: "student_id"
-- generates a plain "ON CONFLICT (student_id)", and Postgres only matches
-- that against a full unique index/constraint, not a partial one --
-- against a partial index it fails with "there is no unique or exclusion
-- constraint matching the ON CONFLICT specification". Dropped and
-- recreated (not just "if not exists") so re-running this file replaces
-- an already-applied partial index with the correct one.
drop index if exists students_student_id_unique_idx;
create unique index if not exists students_student_id_unique_idx on students (student_id);
create index if not exists checkins_check_date_idx on checkins (check_date);
create index if not exists checkins_room_id_idx on checkins (room_id);

alter table students enable row level security;
alter table checkins enable row level security;
alter table room_teachers enable row level security;

-- MVP policy: anyone holding the app's anon key (i.e. anyone who can load the
-- page) can read and write. This is appropriate for a trusted internal tool
-- with no login. Tighten with Supabase Auth + narrower policies if this ever
-- needs to be internet-public or handle sensitive data.
--
-- Unlike "create table"/"create index", Postgres has no "create policy if
-- not exists" -- re-running this file (e.g. after a new table/policy is
-- added here) would fail on every policy that already exists. So each one
-- is dropped first: safe to run repeatedly, and re-creating with the exact
-- same definition is a no-op in effect.
drop policy if exists "public read students" on students;
create policy "public read students" on students for select using (true);
drop policy if exists "public insert students" on students;
create policy "public insert students" on students for insert with check (true);
drop policy if exists "public update students" on students;
create policy "public update students" on students for update using (true);
drop policy if exists "public delete students" on students;
create policy "public delete students" on students for delete using (true);

drop policy if exists "public read checkins" on checkins;
create policy "public read checkins" on checkins for select using (true);
drop policy if exists "public insert checkins" on checkins;
create policy "public insert checkins" on checkins for insert with check (true);
-- Update is needed for drag-and-drop between rooms (moveCheckin in app.js
-- only ever changes room_id on an existing check-in row).
drop policy if exists "public update checkins" on checkins;
create policy "public update checkins" on checkins for update using (true) with check (true);
drop policy if exists "public delete checkins" on checkins;
create policy "public delete checkins" on checkins for delete using (true);

-- No delete policy: a cleared teacher name is saved as an empty string
-- (see saveTeacherName in app.js), never removed.
drop policy if exists "public read room_teachers" on room_teachers;
create policy "public read room_teachers" on room_teachers for select using (true);
drop policy if exists "public insert room_teachers" on room_teachers;
create policy "public insert room_teachers" on room_teachers for insert with check (true);
drop policy if exists "public update room_teachers" on room_teachers;
create policy "public update room_teachers" on room_teachers for update using (true) with check (true);

-- Realtime: broadcast changes on these tables so every open browser tab
-- updates live as check-ins happen anywhere. Postgres has no "add table if
-- not exists" for a publication either (it errors if the table is already
-- a member), so each is guarded the same way.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'checkins'
  ) then
    alter publication supabase_realtime add table checkins;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'students'
  ) then
    alter publication supabase_realtime add table students;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_teachers'
  ) then
    alter publication supabase_realtime add table room_teachers;
  end if;
end $$;
