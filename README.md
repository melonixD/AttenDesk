# AttenDesk

AttenDesk is a complete college attendance system built around the barcode already printed on a student's ID/library card. A teacher's Android phone advertises a short-lived Bluetooth Low Energy (BLE) session, eligible students see the nearby class, scan their own card, and appear on the teacher's live roster. No ESP32 hardware is required for this version.

## What is included

- `android/` — native Android teacher/student app with real email-OTP login, BLE advertising/scanning, ID-card scanning, live roster, manual attendance and device-change requests.
- `web/` — responsive admin, teacher-report and student-attendance website.
- `server/` — production Express API, PostgreSQL migrations, OTP mail delivery and Excel/PDF generation.
- `prototype/` — the original click-through UI demo, still available at `/demo/`.
- `docs/` — architecture, deployment, testing, security and backup guidance.

## Implemented production features

1. PostgreSQL persistence; the schema also works with a Supabase PostgreSQL connection string.
2. Student and teacher self-registration with administrator approval.
3. College-domain email login using expiring, single-use OTP codes.
4. Role-based admin website.
5. Branch, semester, section, subject, course and enrollment management.
6. Weekly timetable management with teacher, section and room conflict rejection; production sessions can be restricted to the scheduled room/time.
7. Secure barcode registration: only a keyed hash and the last four characters are stored.
8. One active phone per student with email-verified device-change requests and admin approval.
9. Student dashboard with overall, subject-wise and per-class attendance history plus below-threshold warnings.
10. Formatted Excel and PDF attendance exports.
11. Persistent sessions, attendance records, audit logs and manual-override reasons.
12. Short-lived device-bound access tokens, rotating refresh tokens, account suspension, rate limits, tenant/role checks, security headers, non-root containers, versioned migrations, HTTPS-only release builds, Docker health checks, encrypted-offsite backup support and guarded restore drills.

## Quick start with Docker

Requirements: Docker with Compose and a mail provider account for real OTP email.

```bash
cp .env.example .env
```

Edit `.env`. At minimum, replace all three secrets, set your real college name/domain, and set the first administrator's college email. Generate each secret with `openssl rand -base64 48`.

For local testing, leave `NODE_ENV=development`. OTP codes are printed by the server and returned to the UI. For real use, set `NODE_ENV=production`, add `RESEND_API_KEY`, and use an `EMAIL_FROM` address on a verified sending domain.

```bash
docker compose up --build
```

Open `http://localhost:8787`. The container applies each versioned database migration before starting. Sign in using `ADMIN_EMAIL`, configure the academic structure, approve registrations, register student barcodes, create course offerings/enrollments, and then build the Android app.

## Run without Docker

Use Node.js 20+, PostgreSQL 15+ and the PostgreSQL client tools.

```bash
cd server
npm install
set -a; . ../.env; set +a
npm run migrate
npm start
```

Set `DATABASE_URL` to Supabase's server-side PostgreSQL URI if you prefer Supabase. Use its pooled URI for the app and a direct URI for migration/backup tools. Keep the database password only on the server; the Android and browser clients never receive it.

## Build the Android app

1. Open the `android` folder in Android Studio.
2. Install Android SDK 35 and let Gradle sync.
3. For an emulator and a local server, the default API URL is `http://10.0.2.2:8787`.
4. For physical phones during local testing, build with your computer's LAN address:

```bash
gradle assembleDebug -PATTENDESK_API_URL=http://192.168.1.20:8787
```

5. For production, use your HTTPS API URL and create a signed release build:

```bash
gradle bundleRelease -PATTENDESK_API_URL=https://attendance.college.edu
```

Release builds reject cleartext HTTP. Keep signing keys outside this repository.

## Correct setup order

1. Bootstrap the administrator through `.env` and run the migration.
2. Add branches, semesters, subjects and sections.
3. Students and teachers request accounts and verify their college email.
4. The administrator approves their requests.
5. Register each student's physical ID-card barcode from **People** using a USB scanner or manual entry.
6. Create course offerings, enroll students and add timetable periods.
7. Students sign into the Android app. The first successfully verified phone becomes their registered phone.
8. Teachers sign in, select a class and open a timed BLE attendance window.

## Important proximity limitation

BLE passes through walls. The system separates adjacent classes using a unique random session token, exact roster eligibility and rejection of overlapping attendance. These controls prevent a Fluid Mechanics student from joining an unrelated Microbiology roster, but a phone-only system cannot prove which side of a wall a student occupies. Calibrate `MIN_RSSI` on your actual campus and treat signal strength as supporting evidence. A future ESP32 anchor can add room-specific proof without changing the database model.

Start with [PILOT_INPUTS.md](docs/PILOT_INPUTS.md), then read [DEPLOYMENT.md](docs/DEPLOYMENT.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), [SECURITY_AND_BACKUPS.md](docs/SECURITY_AND_BACKUPS.md), and [TESTING.md](docs/TESTING.md) before using real student data.
