# Aeries sync proxy

A tiny Cloudflare Worker that lets the (otherwise backend-free) Monday
Attendance app pull a live roster from Aeries, without putting your Aeries
API key in browser-visible code.

```
Browser (app.js) --GET /roster (X-App-Secret)--> this Worker --AERIES-CERT--> Aeries API
```

The worker holds the real Aeries credentials as server-side secrets and
exposes exactly one endpoint: `GET /roster`, returning
`{ roster: [{ id, name, grade }], fetchedAt }`. It does not store anything —
every request is a fresh pull from Aeries.

## What you need first

- **Aeries API access**: your district's Aeries administrator needs to issue
  an API key (the `AERIES-CERT` value) scoped to student roster data, plus
  confirm your district's Aeries base URL (e.g.
  `https://yourdistrict.aeries.net`) and the school code to pull students
  for.
- **A Cloudflare account** (free tier is enough) and the `wrangler` CLI:
  `npm install -g wrangler`, then `wrangler login`.

## Deploy

```bash
cd aeries-proxy
wrangler secret put AERIES_BASE_URL      # e.g. https://yourdistrict.aeries.net
wrangler secret put AERIES_API_KEY       # the AERIES-CERT key from your district
wrangler secret put AERIES_SCHOOL_CODE   # the school code to sync
wrangler secret put APP_SHARED_SECRET    # make up any random string
wrangler deploy
```

`wrangler deploy` prints the worker's URL (something like
`https://monday-attendance-aeries-proxy.<you>.workers.dev`). Also edit
`wrangler.toml`'s `ALLOWED_ORIGIN` to match where the app is actually served
from (its default is the GitHub Pages URL this repo's README describes) —
this is what stops other sites from calling your proxy and pulling student
data.

## Configure the app

In the app, click **⚙️ Aeries Settings** and enter:
- **Sync proxy URL**: the `workers.dev` URL from `wrangler deploy`.
- **Shared secret**: the same value you set for `APP_SHARED_SECRET` above.

Then **Save** — this also triggers an immediate sync so you can confirm it
worked. Turn on **Auto-refresh** to keep the roster current automatically
while the check-in laptop's browser tab stays open (it does not sync in the
background if the tab/browser is closed).

## ⚠️ Before relying on this for a real Monday

The grade-level mapping in `worker.js` (`mapAeriesGrade`) is written from
the commonly-documented Aeries `Grade` field shape (0 = Kindergarten, 1-12 =
grades 1-12, TK usually coded as a negative number) — but Aeries
installations vary by district, and this was **not** verified against your
district's actual API response (this session had no live Aeries credentials
to test against). Before your first real Monday:

1. Deploy the worker and call `GET /roster` yourself (e.g. `curl`) with a
   couple of known students, including at least one TK and one K student.
2. Check that each student's `grade` in the response matches what you'd
   expect (`"TK"`, `"K"`, `"1"`-`"8"`).
3. If it doesn't, adjust `mapAeriesGrade()` in `worker.js` to match what
   your Aeries instance actually returns, and re-deploy
   (`wrangler deploy`).

Also worth double-checking: the "active enrollment" filter
(`!s.InactiveStatusCode && !s.DeleteStatus`) — confirm those are the right
fields for excluding withdrawn/inactive students in your district's Aeries
data, and that the endpoint path (`/aeries/api/v5/schools/{code}/students`)
matches your Aeries API version.

## Local testing (no Cloudflare account needed)

`worker.js` only uses standard `fetch`/`Request`/`Response`, so you can run
it directly under plain Node (18+) instead of `wrangler dev`, against a
stand-in Aeries server, to check your grade-mapping/field changes before
deploying:

```js
import worker from './worker.js';
const env = {
  AERIES_BASE_URL: 'http://localhost:8901',   // your test Aeries stand-in
  AERIES_API_KEY: 'test-key',
  AERIES_SCHOOL_CODE: '123',
  APP_SHARED_SECRET: 'test-secret',
  ALLOWED_ORIGIN: '*',
};
const res = await worker.fetch(new Request('http://x/roster', { headers: { 'X-App-Secret': 'test-secret' } }), env);
console.log(await res.json());
```
