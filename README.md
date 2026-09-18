# AttenDesk

AttenDesk is a complete college attendance system built around the barcode already printed on a student's ID/library card. A teacher's Android phone advertises a short-lived Bluetooth Low Energy (BLE) session, eligible students see the nearby class, scan their own card, and appear on the teacher's live roster. No ESP32 hardware is required for this version.

## What is included

- `android/` — native Android teacher/student app with real email-OTP login, BLE advertising/scanning, ID-card scanning, live roster, manual attendance and device-change requests.
- `public/` — responsive admin, teacher-report and student-attendance website. On supported Android Chrome browsers it connects directly to the teacher's BLE GATT beacon and scans the ID-card barcode with the rear camera.
- `server/` — production Express API, PostgreSQL migrations, OTP mail delivery and Excel/PDF generation.
- `public/demo/` — the original click-through UI demo, still available at `/demo/`.
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

## Deploy to Vercel

AttenDesk now includes the root `index.js`, `package.json`, `vercel.json`, and `public/` layout Vercel expects. Import the folder containing those files—not the directory above it—add the production environment variables, run the database migration once, and deploy. See [VERCEL.md](docs/VERCEL.md) for the exact setup and 404 troubleshooting checklist.

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
7. Students sign into either the Android app or the HTTPS website in Chrome on Android. The first successfully verified phone/browser becomes their registered attendance device.
8. Teachers sign in, select a class and open a timed BLE attendance window.

## Website Bluetooth workflow

The teacher still uses the included Android **Teacher Beacon** companion because web browsers cannot advertise the required BLE classroom service. Students may use the website instead of installing the student app:

1. The teacher starts a timed session in the Android app. The phone advertises a connectable `AttenDesk <room>` GATT service.
2. The student opens the HTTPS Attendesk website in Chrome on Android and taps **Find nearby class**.
3. Chrome shows its protected Bluetooth chooser. The student selects the classroom beacon; Attendesk connects, reads the short-lived session token, and disconnects immediately.
4. The website resolves only a class for which that student is enrolled, opens the rear camera, reads the physical ID barcode and submits attendance from the registered browser.

This is not supported in Safari/iPhone or Firefox, and a website cannot provide an automatic background “ShareIt bubble” without a user tap and browser chooser. For a 60-student class, run a real-phone pilot because the teacher phone's concurrent GATT connection limit varies by model.

## Important proximity limitation

BLE passes through walls. The system separates adjacent classes using a unique random session token, a room-labelled browser chooser, exact roster eligibility and rejection of overlapping attendance. These controls prevent a Fluid Mechanics student from joining an unrelated Microbiology roster, but a phone-only system cannot prove which side of a wall a student occupies. Native-app attendance can use calibrated RSSI as supporting evidence; stable Web Bluetooth does not expose RSSI. A future ESP32 anchor can add room-specific proof without changing the database model.

Start with [PILOT_INPUTS.md](docs/PILOT_INPUTS.md), then read [DEPLOYMENT.md](docs/DEPLOYMENT.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), [SECURITY_AND_BACKUPS.md](docs/SECURITY_AND_BACKUPS.md), and [TESTING.md](docs/TESTING.md) before using real student data.
