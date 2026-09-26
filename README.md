# AttenDesk

Start with [START-HERE.md](START-HERE.md) for repaired login, account recovery,
required environment variables and the ESP32 setup. It supersedes older setup notes.

Classroom attendance for **Harcourt Butler Technical University**, verified by a
server-controlled ESP32 Bluetooth beacon in each room plus the barcode already
printed on the student's ID card.

A teacher opens a timed window. The ESP32 in that room starts broadcasting a
code that changes every 30 seconds. Students in the room capture the code, scan
their card, and appear on the teacher's live roster. The server decides
everything; nothing is trusted from the client.

## How the beacon works, and why

The ESP32 does **not** broadcast a fixed room identifier. A fixed
`ATTENDESK_ROOM_210` string would be trivial to clone — one student with a
spare board could impersonate room 210 from their hostel.

Instead the beacon polls the API every two seconds and is handed
`HMAC(server-secret, session-id + current-30-second-window)`, truncated to 8
bytes. It advertises that and nothing else. It never learns a subject, a room
roster or a student name. A code forwarded to somebody outside the room expires
after the accepted current/previous time windows. It can still be relayed while
valid; this is not cheat-proof proximity verification.

Two independent checks sit on top: the code only resolves to a session the
student is actually enrolled in, and the server refuses two active sessions in
the same room.

## Layout

```
api/index.js      Vercel Function entrypoint (this is what fixes the old 404)
index.js          the same app for Docker / local
public/           vanilla-JS PWA: admin, teacher and student
server/           Express API, PostgreSQL migrations, reports, backup scripts
firmware/         ESP32 beacon sketch + wiring and calibration notes
android/          native Kotlin student app (passive ESP32 BLE scanner)
docs/             deployment, architecture, auth, security, pilot checklist
```

No build step. No bundler. No framework.

## Quick start

```bash
cp .env.example .env          # fill in the three secrets and your database URL
docker compose up --build
```

Then, once:

```bash
npm run seed:hbtu             # creates the HBTU org, accounts, rooms, beacons
```

It prints each ESP32 device key **once**. Copy them into the firmware before
closing the terminal.

Open `http://localhost:8787`.

| Role | Sign in with |
|---|---|
| Admin | `melonix` or `babatillu` + password |
| Teacher | `alakh` (or `Alakh Kumar Singh`) + password |
| Student | full name + roll number |

Passwords come from `SEED_ADMIN_PASSWORD` / `SEED_TEACHER_PASSWORD`. Change them
from inside the app before real use — see `docs/AUTH.md`, which also explains
why the student sign-in is the weakest link and how to close it.

## What is real and what is not

**Real:** PostgreSQL persistence, scrypt passwords, OTP email login, admin
approval workflows, six CSV bulk-import workflows, editable academic/course/timetable records,
post-session corrections with audit history, student appeals, filtered reports,
academic and timetable management with conflict rejection,
ESP32 beacon provisioning and health, rotating-code attendance verification,
live teacher roster, manual override with audit trail, explicit absent records
on close, Excel/PDF exports, below-threshold reports, one-device-per-student
binding, camera barcode scanning on Chrome for Android, backups with checksums.

**Not real yet:** the click-through at `/demo/` uses fixed sample data and a
simulate button. It never touches the API. Nothing in the production path fakes
Bluetooth or fakes attendance — if the browser cannot do Web Bluetooth, it says
so rather than pretending.

## Browser support for students

Web Bluetooth exists only in Chromium. Students need **Chrome on Android over
HTTPS**. Safari, every iOS browser and Firefox are detected and told plainly
that they cannot mark attendance. iPhone students need the Android app path or
a teacher's manual override until a Capacitor build exists.

Web Bluetooth also cannot scan passively or report signal strength, so the web
student taps a device picker and there is no RSSI check on that path — the
rotating code is the proximity proof. The Android app scans passively and does
collect RSSI.

## Tests

```bash
npm test
```

32 tests covering token integrity, password hashing, beacon-code rotation and
expiry, route authorisation, the beacon protocol's information boundary, CSP
compliance, admin workflow rendering and the Vercel routing contract. They run against stub data — run
`npm run migrate` against a real PostgreSQL to validate the SQL.
