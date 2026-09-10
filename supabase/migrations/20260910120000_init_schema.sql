-- Monday Attendance: initial schema
-- Students on the roster, and today's (and historical) check-in events.

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

-- Partial (not full) unique index: only enforced where student_id is set,
-- so multiple CSV-uploaded/walk-in rows with no district ID can all have a
-- null student_id without colliding. This is also what lets an Aeries
-- re-sync upsert on student_id (see setRoster's preserveIds option in
-- app.js) instead of wiping and recreating every row, so an already
-- checked-in student's internal id -- and their check-in's FK to it --
-- survives a mid-Monday roster refresh.
create unique index if not exists students_student_id_unique_idx on students (student_id) where student_id is not null;
create index if not exists checkins_check_date_idx on checkins (check_date);
create index if not exists checkins_room_id_idx on checkins (room_id);

alter table students enable row level security;
alter table checkins enable row level security;

-- MVP policy: anyone holding the app's anon key (i.e. anyone who can load the
-- page) can read and write. This is appropriate for a trusted internal tool
-- with no login. Tighten with Supabase Auth + narrower policies if this ever
-- needs to be internet-public or handle sensitive data.
create policy "public read students" on students for select using (true);
create policy "public insert students" on students for insert with check (true);
create policy "public update students" on students for update using (true);
create policy "public delete students" on students for delete using (true);

create policy "public read checkins" on checkins for select using (true);
create policy "public insert checkins" on checkins for insert with check (true);
-- Update is needed for drag-and-drop between rooms (moveCheckin in app.js
-- only ever changes room_id on an existing check-in row).
create policy "public update checkins" on checkins for update using (true) with check (true);
create policy "public delete checkins" on checkins for delete using (true);

-- Realtime: broadcast changes on these tables so every open browser tab
-- updates live as check-ins happen anywhere.
alter publication supabase_realtime add table checkins;
alter publication supabase_realtime add table students;
