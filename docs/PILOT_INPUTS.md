# Pilot inputs needed

AttenDesk is code-complete enough for a controlled pilot, but it cannot be connected to a real college without the institution-specific information below. Use redacted samples while developing. Keep database passwords, API keys and Android signing keys in a secret manager or local `.env`; do not paste them into chat, commit them, or put them in the Android app.

## 1. College rules and identity

- Official college name and college email domain (for example, `college.edu`).
- College timezone.
- Required attendance percentage.
- Academic year/term and semester start/end dates.
- Allowed attendance-window durations and timetable grace period.
- Whether teachers may start an unscheduled session. Production defaults to timetable enforcement.
- Approved manual-attendance reasons and who may correct a record later.
- Data-retention, privacy-notice and student-consent requirements.

## 2. First administrator

- Full name and official college email address of the initial AttenDesk administrator.
- At least one backup administrator after launch.

## 3. Academic and roster data

Provide spreadsheets/CSV exports with these columns. IDs may be added during import; the human-readable codes below are enough for preparation.

| Data | Required columns |
|---|---|
| Branches | `branch_code`, `branch_name` |
| Semesters | `number`, `academic_year`, `term`, `starts_on`, `ends_on` |
| Sections | `branch_code`, `semester`, `section_name` |
| Subjects | `subject_code`, `subject_name`, `credits` |
| Teachers | `full_name`, `college_email`, `employee_code`, `branch_code` |
| Students | `full_name`, `college_email`, `roll_number`, `branch_code`, `semester`, `section_name`, optional `phone` |
| Course offerings | `subject_code`, `teacher_employee_code`, `branch_code`, `semester`, `section_name`, `default_room` |
| Enrollments | course-offering identifier and `student_roll_number` |
| Timetable | course-offering identifier, `day`, `starts_at`, `ends_at`, `room`, `valid_from`, `valid_until` |
| ID cards | `student_roll_number`, raw barcode value |

Raw barcode values are sensitive identifiers. Prefer registering them through the admin page with a USB barcode scanner. The server stores only a college-scoped keyed hash and the last four characters.

Also provide one redacted close-up photo of the printed barcode or confirm its symbology (`CODE_128`, `CODE_39`, `CODABAR`, `EAN_13`, `EAN_8` or `ITF`). Do not send a real student's full unredacted card in chat.

## 4. Hosting and email choices

- PostgreSQL/Supabase project and a server-side connection string.
- API hosting provider or college server.
- Production HTTPS hostname, such as `attendance.college.edu`, plus permission to edit its DNS.
- Resend account, verified sending domain, API key and From address for OTP email.
- Backup destination (an encrypted S3-compatible bucket is supported), retention period and restore owner.
- Monitoring destination for health/5xx/backup-age alerts.

## 5. Android release choices

- Final Android package ID (currently `in.attendesk.app`). Changing it later creates a different app.
- App icon/logo and optional college colors.
- Google Play Console account or an approved private-distribution method.
- Android upload/signing key, owned and backed up by the college. Never send the private key in chat.
- Production HTTPS API URL.
- Minimum phone policy. The student-only app supports Android 8+ and requires BLE scanning. Teachers use the HTTPS website.
- Decide whether the optional Chrome/Web Bluetooth fallback remains enabled. The 60-student pilot must use the native Android passive-scan path.

## 6. Physical pilot resources

- One provisioned ESP32 beacon per test classroom and a teacher laptop/phone for the HTTPS website.
- At least five representative Android student phone models with the native app and real test ID cards.
- Two adjacent classrooms for cross-wall testing.
- Reliable Wi-Fi/mobile data during the attendance window.
- A small pilot roster, named pilot owner, support contact and rollback procedure.

## Values that must be measured, not guessed

- `MIN_RSSI`: measure centre, door, back-bench and both sides of the shared wall before choosing it for native-app students. Stable Web Bluetooth does not expose RSSI.
- Session duration: test with the largest expected class (about 60 students).
- Timetable grace: choose a value based on actual class-change timing.
- Backup retention and recovery objective: obtain college approval and complete a restore drill.
