# Security and backups

## Implemented controls

- College domains map users to one organization; protected queries enforce roles and organization ownership.
- OTPs expire after 10 minutes, allow at most five attempts, are stored only as keyed hashes and become unusable after one successful verification.
- Login access tokens expire after 15 minutes. Mobile access tokens are bound to the verified installation. Refresh tokens are random, stored as SHA-256 hashes, expire after 30 days and rotate on use.
- Web student sessions can read dashboards but cannot mark attendance or register themselves as the active phone.
- A new mobile phone receives a 10-minute device-change authorization only after correct email OTP verification. An administrator must approve the request.
- Raw ID-card barcode values are never stored. The database contains a college-scoped HMAC and last four characters for identification.
- Attendance validation runs inside database transactions and has uniqueness constraints for devices, barcodes and student/session records.
- Manual attendance requires a reason and writes an audit event with actor and request ID.
- Security headers block framing, MIME sniffing, external scripts, objects and broad browser permissions. Production Android builds require HTTPS.
- API bodies, OTP attempts and request volume are bounded.
- Administrators can suspend/reactivate teacher and student accounts; suspension is effective immediately and revokes refresh tokens.

## Remaining institutional decisions

Before real deployment, define who may approve registrations/device changes, how long attendance and audit data are retained, how students appeal corrections, which staff can export reports, and how offboarded accounts are suspended. Add monitoring/alerting and independent penetration testing before campus-wide rollout.

Phone-reported BLE RSSI is useful friction but is not tamper-proof: a modified Android client can falsify samples, and radio passes through walls. For a higher-assurance deployment, add Google Play Integrity verification and server-issued request nonces; add ESP32 room anchors if the college needs room-level proof. Keep teacher review/manual correction as the final control during a phone-only pilot.

## Backup procedure

`server/scripts/backup.sh` creates a PostgreSQL custom-format dump, SHA-256 checksum and `backup_runs` audit row. It keeps 30 local days by default and can upload both files to an S3 URI using server-side encryption.

Example daily cron entry (run as a restricted service account):

```text
15 2 * * * cd /opt/attendesk && set -a && . ./.env && set +a && ./server/scripts/backup.sh >> /var/log/attendesk-backup.log 2>&1
```

Keep at least one copy in a different provider/account and enable bucket versioning/object lock according to college policy. Database-provider snapshots are useful but do not replace export/restore testing.

## Restore drill

Create an isolated empty database whose name ends in `_restore_verify`, then run:

```bash
VERIFY_DATABASE_URL=postgresql://.../attendesk_restore_verify \
  ./server/scripts/verify-restore.sh /var/attendesk-backups/attendesk-TIMESTAMP.dump
```

The suffix check is intentional: the script uses `pg_restore --clean` and must never target the live database. Record the drill date, row-count sanity checks, recovery time and operator.
