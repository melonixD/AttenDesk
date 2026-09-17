# Testing guide

## Automated checks

From `server/` run:

```bash
npm test
```

The automated suite covers BLE-token resolution, successful attendance, idempotency, registered-device enforcement, wrong barcodes, weak signals, manual reasons, signed-token security, invalid enrollment reporting, mobile-token installation binding and timetable conflict rejection. Static checks also cover required schema constraints and management/report routes.

For a full integration test, start PostgreSQL with Docker, install server dependencies, migrate, and exercise registration/approval/login using `NODE_ENV=development` so the OTP appears in the UI.

## Two-phone test

1. Create and approve one teacher and several student accounts.
2. Register each test card barcode, create an offering, enroll the students and add a timetable period.
3. Build the Android debug app with the test server's LAN IP.
4. Sign in on the teacher phone and open a three-minute session.
5. Sign in on the approved student phone, wait for at least three BLE observations, tap the class bubble and scan that student's registered card.
6. Confirm the live roster changes within two seconds and a repeat scan does not create a duplicate.
7. Try an unregistered card, a second phone and a submission after expiry; all must be rejected.
8. Manually mark one student and confirm the reason appears in the stored record/audit log.

## Adjacent-room test

Run two teacher phones in rooms 210 and 211 with different offerings and overlapping timers. Confirm each enrolled student resolves only their own roster. Test students who legitimately belong to both offerings and verify that the overlapping-attendance rule stops double marking.

Record median RSSI at the centre, door, back bench and both sides of the shared wall across at least five phone models. Tune `MIN_RSSI` only after collecting campus data; BLE RSSI is noisy and is not a precise distance measurement.

## Release checks

- Verify a release build refuses an HTTP API URL.
- Confirm development OTPs are absent in production responses/logs.
- Open Excel and PDF exports and reconcile totals against SQL queries.
- Run a backup, verify its checksum and complete a restore drill.
- Test admin, teacher and student accounts against every protected route.
- Test suspended users, expired OTPs, five incorrect OTP attempts and a reused refresh token.
- Run a 60-student load/pilot test; the included environment cannot replace physical BLE tests.
- Compile debug and release Android variants in Android Studio/CI and run them on real phones. The server test environment does not contain the Android SDK.
