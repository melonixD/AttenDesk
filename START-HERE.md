# Attendesk — production setup

This release fixes identified code defects, not an already deployed server. Upload it and configure the database before testing login. Do not use the interface demo at `/demo/` for real attendance.

## 1. Restore admin login

Use Node 22.12+ (or Node 24) and run commands from the folder containing the root `package.json`.

1. Copy `.env.example` to `.env` using your file manager. Set the database connection and three different random secrets (32+ characters each). Keep this file private.
2. Set `ADMIN_EMAIL` to an email you actually control, `ADMIN_USERNAME=melonix`, and `ADMIN_PASSWORD` to your own strong password. The configured college email domain must match your admin email for email login.
3. Run `npm ci`, then `npm run migrate`. Local commands now load `.env` automatically. Migration creates the initial admin and assigns the password only when none exists. It never replaces an existing password.
4. Start with `npm start`, open the app, choose **Admin**, then enter your full admin email and the password you supplied. Password login does not require Resend.
5. If an existing account has an unknown password, set `RESET_EMAIL` and `RESET_PASSWORD` privately in `.env`, run `npm run reset-password`, then REMOVE these reset variables. Use this only for the account you administer.

For Docker, execute migration/seed/reset inside the app container, for example `docker compose exec app npm run seed:hbtu`. The container receives the configured environment; restart/recreate it after changing `.env`.

## 2. HBTU pilot accounts (optional)

Set `SEED_ADMIN_PASSWORD` and `SEED_TEACHER_PASSWORD` before `npm run seed:hbtu`. No shared default passwords are shipped. Seeding preserves existing passwords and does not reactivate suspended users. The seed contains sample HBTU academic details, names, email addresses and barcode assumptions: verify them before real use.

The `melonix`, `babatillu` and `alakh` usernames exist only after seeding. Normal migration alone creates only your configured initial administrator. The password is the value you supplied, not the variable name. Prefer full email if multiple colleges exist in the database.

Students with an assigned password must enter it in the new student password field. Name plus roll number alone is suitable only for a supervised pilot, not secure identity verification. Configure OTP or assigned student passwords before real deployment. Registered-browser IDs are not hardware-bound and cannot guarantee one physical phone per person.

## 3. Vercel

Set the Root Directory to the folder containing `package.json`, `api/`, `public/` and `vercel.json`; use no frontend build command or output directory. Set production database and secret environment variables in Vercel and redeploy. Run migration separately against that SAME database. A Vercel deploy does not run the seed or create accounts automatically. Never upload `.env`.

If login still fails, send the deployed URL, selected role and exact error text/screenshot. Do not send passwords, database URLs, service keys or beacon keys. The app now distinguishes missing schema, unavailable database, incomplete server configuration and invalid credentials.

## 4. Configure the college from the admin panel

The dashboard now includes a first-time setup checklist. Complete it in this order:

1. **Academic setup:** create a branch, semester, section and subject.
2. **People:** create teachers and students directly, or import students from the downloadable CSV template. Teacher employee codes become their usernames. Student barcodes and initial passwords can be assigned during creation.
3. **Courses:** assign a subject to a teacher and section, then enroll students. Open a course roster to remove an incorrect enrollment.
4. **Timetable:** add class periods after the course exists.
5. **Rooms & beacons:** register the classroom, then provision its ESP32.

Students and teachers may still request their own accounts, but self-registration is no longer required to make a fresh installation usable. Administrators can also reset passwords from **People**; resetting a password revokes that user's existing sessions.

## 5. ESP32 classroom flow

The teacher uses the WEBSITE to start attendance. No teacher phone beacon is required. Keep `REQUIRE_ESP32=true` (the default) so missing/offline ESP32s block opening a session.

1. Register a room and provision its ESP32 in **Rooms & beacons**.
2. Copy that device's code and one-time key privately into the firmware.
3. Configure Wi-Fi, your actual HTTPS API URL, room label and the valid root CA PEM certificate. Firmware no longer disables TLS verification. Network time must be available for certificate checks.
4. Compile the sketch using Arduino ESP32 core 3.x, NimBLE-Arduino 2.5.1 and ArduinoJson 7.x. Use a BLE-capable ESP32; ESP32-S2 has no BLE. The sketch is source-reviewed but has NOT been compiled or tested on hardware here.
5. Power the board, inspect Serial at 115200 baud, and wait for **Online** in the website.
6. Assign teacher/course/student enrollments. The teacher selects the room and timer on the website. Students use the native Android app to scan the ESP32 advertisements and then scan their registered ID barcode. Configure the Android build with the deployed HTTPS API URL before creating the APK.

The internal 30-second code is exchanged automatically over Bluetooth; nobody types or sees a classroom PIN. The ESP32 uses connectionless advertising, so 60 phones listen without making 60 simultaneous Bluetooth connections. Each phone submits its result to the server over mobile data or Wi-Fi.

## Verification and limits

Run `npm test` from the root. Tests include simulated browser login interactions and API/security regression tests using stub databases. They do not prove real PostgreSQL migrations, deployed Vercel configuration, ESP32 compilation, physical BLE reception or 60 simultaneous students. Those require a staging database and physical pilot.

Test one teacher and two students first, then adjacent rooms, then a 60-student session. BLE crosses walls; rotating tokens can still be relayed within their validity window (current and previous 30-second windows are accepted). This is not cheat-proof classroom-location verification.

Firmware API reference: https://h2zero.github.io/NimBLE-Arduino/class_nim_b_l_e_advertising.html
