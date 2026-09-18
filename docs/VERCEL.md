# Deploying AttenDesk to Vercel

## Why the old build returned 404

The previous release exported an Express app from a root-level `index.js` and
the docs claimed Vercel would "detect" it. It does not. Vercel's zero-config
Node runtime only turns files inside an `api/` directory into Functions, and
the old `vercel.json` had no `rewrites`, no `functions` and no `builds` — so
Vercel treated the repository as a static site with no output directory and
answered every path with `404 NOT_FOUND`. Changing the Root Directory could
never have fixed it.

This release ships `api/index.js` plus a `vercel.json` that rewrites all
traffic to it and bundles `public/` into the Function. There is nothing to
configure by hand.

## 1. Project settings

| Setting | Value |
|---|---|
| Framework Preset | **Other** |
| Root Directory | the folder containing `api/`, `public/`, `server/`, `vercel.json` |
| Build Command | leave blank |
| Output Directory | leave blank |
| Install Command | `npm install` |
| Node.js version | 20.x or 22.x |

If you extracted the release ZIP, the Root Directory is the inner `AttenDesk`
folder.

## 2. Database

Create a PostgreSQL database — Supabase, Neon and Vercel Postgres all work.
You need two URLs from the provider:

- a **direct** connection URL, for migrations and backups
- a **pooled / serverless** URL, for the Function

Run the migration once from your own machine using the direct URL:

```bash
npm ci
export DATABASE_URL='postgresql://...direct-connection...'
export DB_SSL=true
export AUTH_SECRET="$(openssl rand -base64 48)"
export OTP_SECRET="$(openssl rand -base64 48)"
export BARCODE_PEPPER="$(openssl rand -base64 48)"
npm run migrate
```

Save those three secrets. `BARCODE_PEPPER` in particular can never be changed
later without re-registering every student's ID card.

Then seed HBTU:

```bash
export COLLEGE_EMAIL_DOMAIN=hbtu.ac.in
export SEED_ADMIN_PASSWORD='choose-a-strong-one'
export SEED_TEACHER_PASSWORD='choose-another'
npm run seed:hbtu
```

Copy the ESP32 device keys it prints. They are shown once.

## 3. Environment variables

Add these in **Project Settings → Environment Variables** (Production):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the **pooled** URL |
| `DB_SSL` | `true` |
| `DB_POOL_SIZE` | `3` |
| `AUTH_SECRET` / `OTP_SECRET` / `BARCODE_PEPPER` | the three secrets from step 2 |
| `COLLEGE_NAME` | `Harcourt Butler Technical University` |
| `COLLEGE_EMAIL_DOMAIN` | `hbtu.ac.in` |
| `COLLEGE_TIMEZONE` | `Asia/Kolkata` |
| `ATTENDANCE_THRESHOLD` | `75` |
| `ENFORCE_TIMETABLE` | `false` (teachers may start unscheduled sessions) |
| `BEACON_OFFLINE_SECONDS` | `45` |
| `RESEND_API_KEY` | only if you want the email-OTP fallback login |
| `EMAIL_FROM` | a sender on a verified domain |

Never prefix a server secret with `VITE_`, `NEXT_PUBLIC_` or anything else that
exposes it to the browser.

## 4. Verify

1. `https://your-project.vercel.app/` shows the AttenDesk sign-in screen.
2. `https://your-project.vercel.app/health` returns `{"ok":true,...}`.
3. Sign in as `melonix` with the admin password.
4. **Rooms & beacons** lists rooms 210, 211 and 212.
5. Point the ESP32's `API_BASE` at this hostname and flash it. Within a minute
   the beacon shows **Online**.

If `/` still 404s, open the deployment's **Source** tab and confirm `api/index.js`
is present at the top level. If `/` loads but `/health` returns 500, routing is
fine and the problem is `DATABASE_URL` or a missing secret — check the Function
log and quote the request ID.

## Vercel limits that matter here

- **The rate limiter is per-instance.** It lives in a `Map` inside one Function
  instance, so under load it is close to decorative. Put Redis or a gateway
  limiter in front before a college-wide rollout.
- **The filesystem is not persistent.** Run backups from your database provider,
  not from `server/scripts/backup.sh` on Vercel.
- **Cold starts open new database connections.** Use the pooled URL and keep
  `DB_POOL_SIZE` small.
- **HTTPS is mandatory anyway.** Web Bluetooth and `getUserMedia` both refuse to
  run on plain HTTP, so a Vercel domain (or any TLS host) is required, not
  optional.
