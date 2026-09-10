/**
 * Aeries roster sync proxy — Cloudflare Worker
 *
 * The Monday Attendance app is a static site with nowhere safe to hold an
 * Aeries API key, so this tiny worker sits in front of Aeries instead: it
 * holds the real credentials as server-side secrets and exposes exactly one
 * narrow endpoint the app calls from the browser:
 *
 *   GET /roster  ->  { roster: [{ id, name, grade }, ...], fetchedAt }
 *
 * See ../README.md ("Live sync from Aeries") for deployment steps.
 *
 * Required config (set with `wrangler secret put <NAME>`, see wrangler.toml):
 *   AERIES_BASE_URL     e.g. https://yourdistrict.aeries.net
 *   AERIES_API_KEY      the AERIES-CERT value issued by your district
 *   AERIES_SCHOOL_CODE  the school code(s) to pull students for — a single
 *                       code (e.g. "1") or a comma-separated list to combine
 *                       multiple schools into one roster (e.g. "1,2")
 *   APP_SHARED_SECRET   a random string only the app knows; checked against
 *                       the `X-App-Secret` request header so this endpoint
 *                       isn't an open, unauthenticated proxy for student PII
 *   ALLOWED_ORIGIN      the origin the app is served from, for CORS
 *                       (e.g. https://soar-charter-academy.github.io) —
 *                       defaults to "*" if unset, which is fine for testing
 *                       but should be locked down for real student data
 */

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "X-App-Secret",
      Vary: "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/roster") {
      return json({ error: "Not found" }, 404, corsHeaders);
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, corsHeaders);
    }

    if (!env.APP_SHARED_SECRET || request.headers.get("X-App-Secret") !== env.APP_SHARED_SECRET) {
      return json({ error: "Unauthorized" }, 401, corsHeaders);
    }

    if (!env.AERIES_BASE_URL || !env.AERIES_API_KEY || !env.AERIES_SCHOOL_CODE) {
      return json({ error: "Worker is missing Aeries configuration" }, 500, corsHeaders);
    }

    // AERIES_SCHOOL_CODE may be a single code ("1") or a comma-separated
    // list ("1,2") to combine multiple schools into one roster.
    const schoolCodes = String(env.AERIES_SCHOOL_CODE)
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    const baseUrl = env.AERIES_BASE_URL.replace(/\/$/, "");
    const perSchool = await Promise.all(
      schoolCodes.map((code) => fetchSchoolStudents(baseUrl, code, env.AERIES_API_KEY))
    );

    const failed = perSchool.find((r) => r.error);
    if (failed) {
      return json({ error: `School ${failed.schoolCode}: ${failed.error}` }, 502, corsHeaders);
    }

    const roster = perSchool
      .flatMap((r) => r.students)
      .filter((s) => !s.InactiveStatusCode && !s.DeleteStatus) // active enrollment only
      .map((s) => ({
        id: String(s.StudentID ?? s.PermanentID ?? s.LastName + "-" + s.FirstName),
        name: (String(s.FirstName || "") + " " + String(s.LastName || "")).trim(),
        grade: mapAeriesGrade(s.Grade ?? s.GradeLevel),
      }))
      .filter((s) => s.name);

    // Combining schools can occasionally produce the same student twice
    // (e.g. a shared enrollment record) — de-dupe by id, keeping the first.
    const seen = new Set();
    const dedupedRoster = roster.filter((s) => (seen.has(s.id) ? false : seen.add(s.id)));

    return json({ roster: dedupedRoster, fetchedAt: new Date().toISOString() }, 200, corsHeaders);
  },
};

async function fetchSchoolStudents(baseUrl, schoolCode, apiKey) {
  const aeriesUrl = baseUrl + "/api/v5/schools/" + encodeURIComponent(schoolCode) + "/students";

  let aeriesRes;
  try {
    aeriesRes = await fetch(aeriesUrl, {
      headers: { "AERIES-CERT": apiKey, Accept: "application/json" },
    });
  } catch (err) {
    return { schoolCode, error: "Could not reach Aeries: " + err.message };
  }

  if (!aeriesRes.ok) {
    return { schoolCode, error: "Aeries API returned " + aeriesRes.status };
  }

  try {
    const students = await aeriesRes.json();
    return { schoolCode, students: Array.isArray(students) ? students : [] };
  } catch (err) {
    return { schoolCode, error: "Aeries API returned invalid JSON" };
  }
}

// Aeries reports grade level as a small integer in most district
// configurations: 0 for Kindergarten and 1-12 for grades 1-12, with TK
// (Transitional Kindergarten) commonly coded as a negative number.
//
// ⚠️ VERIFY THIS against your own district's actual `/students` response
// before relying on it in production — Aeries installations vary, and TK
// in particular is sometimes coded differently (or as a separate field).
// Adjust the mapping below to match what your Aeries instance returns.
function mapAeriesGrade(gradeValue) {
  const g = Number(gradeValue);
  if (Number.isNaN(g)) return String(gradeValue ?? "").trim().toUpperCase();
  if (g <= -1) return "TK";
  if (g === 0) return "K";
  return String(g);
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
