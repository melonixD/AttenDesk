# Vercel deployment

AttenDesk is a full-stack Express application. Vercel deploys the root `index.js` as one Function and serves everything in `public/` from its CDN.

## 1. Select the correct project root

The Vercel **Root Directory** must be the folder that directly contains:

```text
index.js
package.json
vercel.json
public/
server/
```

If you extracted the release ZIP, select its inner `AttenDesk` folder. Selecting the folder above it is the most common cause of a successful-looking deployment that only returns `404 NOT_FOUND`.

Use these Vercel build settings:

- Framework Preset: **Other**
- Root Directory: the folder described above
- Build Command: leave blank
- Output Directory: leave blank
- Install Command: `npm install` (the default is also fine)
- Node.js version: **22.x** or another supported version that satisfies Node 20+

Do not set `public` as the Output Directory. Vercel discovers that directory automatically for an Express project.

## 2. Create and migrate PostgreSQL

Create a PostgreSQL or Supabase database. Use the provider's direct connection URL for this one-time migration from your computer:

```bash
npm ci
export DATABASE_URL='postgresql://...direct-connection...'
export DB_SSL=true
export AUTH_SECRET='first-independent-random-secret-at-least-32-characters'
export OTP_SECRET='second-independent-random-secret-at-least-32-characters'
export BARCODE_PEPPER='third-independent-random-secret-at-least-32-characters'
export COLLEGE_NAME='Your College'
export COLLEGE_EMAIL_DOMAIN='college.edu'
export ADMIN_EMAIL='admin@college.edu'
export ADMIN_NAME='Main Administrator'
npm run migrate
```

Generate each security secret separately with `openssl rand -base64 48`. The migration is versioned and safe to run again when a future AttenDesk release adds a migration.

## 3. Add Vercel environment variables

In **Project Settings → Environment Variables**, add the following to Production. Add them to Preview only if preview deployments should access a separate non-production database.

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Your provider's pooled/serverless PostgreSQL URL |
| `DB_SSL` | `true` |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` unless your database provider explicitly requires otherwise |
| `DB_POOL_SIZE` | `3` to start; increase only after checking the database connection limit |
| `AUTH_SECRET` | First random secret, 32+ characters |
| `OTP_SECRET` | Second, different random secret, 32+ characters |
| `BARCODE_PEPPER` | Third, different random secret, 32+ characters |
| `COLLEGE_NAME` | Official college name |
| `COLLEGE_EMAIL_DOMAIN` | Domain after `@` in allowed college emails |
| `COLLEGE_TIMEZONE` | For example `Asia/Kolkata` |
| `ATTENDANCE_THRESHOLD` | Usually `75` |
| `ADMIN_EMAIL` | First administrator's college email |
| `ADMIN_NAME` | First administrator's full name |
| `RESEND_API_KEY` | Production Resend API key |
| `EMAIL_FROM` | Sender on a verified domain, such as `AttenDesk <attendance@college.edu>` |
| `MIN_RSSI` | Start with `-92`, then calibrate on campus |
| `ENFORCE_TIMETABLE` | `true` after the real timetable is loaded |
| `TIMETABLE_GRACE_MINUTES` | `10` by default |

Never prefix server secrets with `VITE_`, `NEXT_PUBLIC_`, or any other client-exposure prefix.

## 4. Deploy and verify

Redeploy after saving the environment variables, then check:

1. `https://your-project.vercel.app/` loads the AttenDesk sign-in screen.
2. `https://your-project.vercel.app/health` returns JSON with `"ok": true`.
3. A login OTP reaches the administrator's real college email.
4. Vercel Function logs show no database or missing-environment-variable errors.

If `/` still returns Vercel's `404 NOT_FOUND`, recheck the Root Directory and confirm `index.js` appears at the top level in the deployment's **Source** view. If `/` loads but `/health` returns `500`, routing is fixed and the remaining problem is an environment variable, database connection, or migration; inspect the Function log and its request ID.

## Vercel limitations relevant to AttenDesk

- Vercel's filesystem is not persistent. Run database backups from Supabase/your PostgreSQL provider or a separate scheduled backup service, not from the Vercel Function.
- The built-in API rate limiter is per running Function instance. Before a large college rollout, replace it with a shared Redis/gateway limiter.
- Use a pooled/serverless database URL for the Function and keep the direct URL for migrations and backups.
- Build the Android release with the final HTTPS Vercel domain as `ATTENDESK_API_URL`.
