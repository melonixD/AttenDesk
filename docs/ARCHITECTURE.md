# Architecture

## Components

- Android teacher mode creates the session through HTTPS and broadcasts only its random 8-byte token as BLE service data.
- Android student mode passively scans advertisements, collects RSSI samples, resolves eligible tokens through HTTPS and scans the printed ID barcode.
- The Express API is the authority for timers, roles, rosters, devices, barcodes and attendance.
- PostgreSQL stores academic configuration, identities, login challenges, course rosters, sessions, attendance and audit events.
- The website uses the same role-protected API for administration, dashboards and exports.

## Attendance sequence

1. The teacher selects one of their assigned course offerings, enters the classroom and chooses a 30–600 second duration.
2. The server creates an active session and returns a cryptographically random token.
3. The teacher phone advertises that anonymous token; no teacher, subject, room or student data is broadcast.
4. Student phones observe the token several times. They never pair with or connect to the teacher phone, so 60 students do not create 60 Bluetooth connections.
5. The server reveals session details only when the signed-in student is enrolled in that exact offering.
6. The student scans their card and submits the raw value over HTTPS with the registered installation ID and RSSI samples.
7. The server verifies mobile-app authentication, the active phone, keyed barcode hash, roster, timer, median RSSI and overlapping-attendance rule in a transaction.
8. A unique `(session_id, student_id)` database constraint makes repeat taps idempotent.
9. The teacher polls the authoritative roster every two seconds and can add a reasoned manual override.

## Adjacent classrooms

Every concurrent class has a different BLE token. Token resolution is also roster-filtered: a student not enrolled in Microbiology cannot resolve that session even if its signal crosses the wall. The timetable rejects overlapping use by the same teacher, section or room, and the server prevents two active attendance sessions in the same room. A student enrolled in two simultaneously scheduled courses may see both but can be present in only one overlapping session. The room and subject remain visible before scanning.

## Main database relationships

- One organization owns users, branches, semesters, subjects and offerings.
- A student belongs to a branch, semester and section, and can have many course enrollments.
- A course offering connects one subject, teacher, section and semester.
- A timetable entry and attendance session belong to one offering.
- An attendance record is unique for one student in one session.
- One partial unique index permits only one active device per student and another prevents one active installation from serving two students.

The base schema is `server/migrations/001_production_schema.sql`; later numbered migrations are tracked with checksums in `schema_migrations`.
