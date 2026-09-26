# Deployment

## PostgreSQL or Supabase

AttenDesk uses standard PostgreSQL features (`pgcrypto`, `citext`, JSONB, partial indexes and transactions). You can run the included PostgreSQL 17 container, a managed PostgreSQL service, or Supabase.

For Supabase, create a project, copy a server-side connection string, enable SSL, and set:

```text
DATABASE_URL=postgresql://...
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
```

Use Supabase's session/pooler URI for the continuously running API when required by your hosting platform. Run migration and `pg_dump` with the provider's recommended direct connection. Do not put the service key or database URI in browser JavaScript or the Android build.

## Production checklist

1. Use a dedicated database user and restrict inbound database connections to the application/backup network.
2. Set `NODE_ENV=production`, three independent high-entropy secrets and a real Resend API key.
3. Put the container behind a TLS reverse proxy or managed HTTPS load balancer. Redirect HTTP to HTTPS.
4. Restrict the app's public API hostname, enable DDoS/WAF rate limiting, and centralize logs without recording OTPs or raw barcodes.
5. Run at least two application replicas only after replacing the in-memory rate limiter with a shared Redis or gateway limiter.
6. Run `server/scripts/backup.sh` daily and copy backups to a separate encrypted account/bucket.
7. Run the guarded restore drill monthly against an isolated database.
8. Build a signed Android App Bundle with the production HTTPS URL. Store the Play signing/upload key securely.
9. Obtain college approval, publish a privacy/retention policy and limit admin accounts.
10. Monitor `/health`, database storage, failed OTP volume, 5xx rate and backup age.
11. Set `ENFORCE_TIMETABLE=true` after the real timetable has been imported and checked for conflicts.

## Vercel

The release includes Vercel's required root Express export and `public/` asset layout. Follow [VERCEL.md](VERCEL.md) for the exact Root Directory, environment variables, migration sequence, verification URLs, and `404 NOT_FOUND` troubleshooting. On Vercel, set `DB_POOL_SIZE=3` initially and use a pooled/serverless PostgreSQL URL. Run backups outside Vercel because a Function does not provide persistent local storage.

## Environment notes

- `AUTH_SECRET`, `OTP_SECRET`, and `BARCODE_PEPPER` must be different. Rotating the barcode pepper requires re-registering cards unless you implement versioned peppers.
- `MIN_RSSI` defaults to `-92`. Calibrate it across classrooms and at least five representative phone models.
- `ENFORCE_TIMETABLE` defaults on when `NODE_ENV=production` unless explicitly set to `false`. `TIMETABLE_GRACE_MINUTES` defaults to 10 and accepts 0–60.
- `DB_SSL=false` is appropriate only for the private local Docker network.
- Development mode exposes OTP codes for testing. Never run it with real student data.

## Android release

Debug builds permit cleartext HTTP for local development. Release builds do not. Build using:

```bash
gradle bundleRelease -PATTENDESK_API_URL=https://attendance.college.edu
```

### Build an installable pilot APK with GitHub Actions

The repository includes `.github/workflows/android-apk.yml`, which builds the
student-only Android app without requiring Gradle or the Android SDK on the
developer's computer.

1. Push the project to GitHub.
2. Open **Actions** and select **Build Android APK**.
3. Click **Run workflow**.
4. Enter the live HTTPS Attendesk deployment URL (for example,
   `https://attendance.college.edu`). Do not enter a Supabase key or password.
5. After the job succeeds, download the `AttenDesk-student-v1.1.0` artifact.

To enable the website download button, extract `AttenDesk-student.apk` from the
artifact, place it at `public/downloads/AttenDesk-student.apk`, commit it, and
allow Vercel to deploy that commit.

The artifact contains a debug-signed APK for prototype installation. A public
release still requires a private Android signing key and a release build.

The Android build is student-only. Teachers start and monitor attendance from the HTTPS website, the classroom ESP32 broadcasts the rotating code, and student phones passively scan its service data without opening Bluetooth connections. This is the required path for a 60-student class.

The website still contains an optional Chrome/Web Bluetooth fallback which reads the same ESP32 over GATT. It is not the primary 60-student path; Safari/iPhone and Firefox do not support it.

The source archive does not include a generated Gradle wrapper. Open `android/` in Android Studio (SDK 35/JDK 17), use the IDE's configured Gradle distribution, and generate the wrapper before command-line/CI builds. Commit the generated wrapper files to your deployment repository.

For website Bluetooth, keep the `Permissions-Policy` entries for both `bluetooth=(self)` and `camera=(self)`, deploy only over HTTPS, and do not place the app inside a cross-origin iframe.
