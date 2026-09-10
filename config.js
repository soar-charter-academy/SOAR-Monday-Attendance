// Supabase connection settings for Monday Attendance.
//
// Fill these in from your Supabase project: Project Settings -> API.
//   SUPABASE_URL      -> "Project URL"
//   SUPABASE_ANON_KEY -> the "anon" / "public" key (NOT the service_role key)
//
// This file is loaded by index.html before app.js. The anon key is safe to
// ship in client-side code like this -- it only grants what the Row Level
// Security policies in supabase/migrations allow.
window.SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
window.SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";
