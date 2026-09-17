#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: VERIFY_DATABASE_URL=postgresql://.../attendesk_restore_verify $0 BACKUP.dump" >&2
  exit 1
fi
if [ -z "${VERIFY_DATABASE_URL:-}" ]; then
  echo "VERIFY_DATABASE_URL is required and must point to an isolated restore-test database" >&2
  exit 1
fi
case "$VERIFY_DATABASE_URL" in
  *_restore_verify|*_restore_verify\?*) ;;
  *) echo "Refusing to overwrite a database whose name does not end in _restore_verify" >&2; exit 1 ;;
esac

backup_file="$1"
if [ ! -f "$backup_file" ]; then
  echo "Backup not found: $backup_file" >&2
  exit 1
fi

pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --dbname="$VERIFY_DATABASE_URL" "$backup_file"
psql "$VERIFY_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT count(*) AS organizations FROM organizations; SELECT count(*) AS attendance_records FROM attendance_records;"
echo "Restore verification completed successfully"
