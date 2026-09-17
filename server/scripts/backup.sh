#!/usr/bin/env sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

backup_directory="${BACKUP_DIRECTORY:-/var/attendesk-backups}"
case "$backup_directory" in
  /|/home|/root) echo "Refusing unsafe BACKUP_DIRECTORY" >&2; exit 1 ;;
esac

mkdir -p "$backup_directory"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$backup_directory/attendesk-$timestamp.dump"
run_id="$(psql "$DATABASE_URL" -qAt -v ON_ERROR_STOP=1 -c "INSERT INTO backup_runs(status,storage_path) VALUES('started','pending') RETURNING id")"

backup_failed() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v run_id="$run_id" -c "UPDATE backup_runs SET status='failed',error_message='pg_dump or upload failed',completed_at=now() WHERE id=:'run_id'" >/dev/null 2>&1 || true
}
trap backup_failed INT TERM HUP EXIT

pg_dump --format=custom --no-owner --no-privileges --file="$backup_file" "$DATABASE_URL"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$backup_file" > "$backup_file.sha256"
else
  shasum -a 256 "$backup_file" > "$backup_file.sha256"
fi

if [ -n "${BACKUP_S3_URI:-}" ]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "aws CLI is required when BACKUP_S3_URI is configured" >&2
    exit 1
  fi
  aws s3 cp "$backup_file" "$BACKUP_S3_URI/$(basename "$backup_file")" --sse AES256
  aws s3 cp "$backup_file.sha256" "$BACKUP_S3_URI/$(basename "$backup_file.sha256")" --sse AES256
fi

checksum="$(cut -d ' ' -f 1 "$backup_file.sha256")"
size_bytes="$(wc -c < "$backup_file" | tr -d ' ')"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v run_id="$run_id" -v storage_path="$backup_file" -v checksum="$checksum" -v size_bytes="$size_bytes" \
  -c "UPDATE backup_runs SET status='succeeded',storage_path=:'storage_path',checksum=:'checksum',size_bytes=:'size_bytes',completed_at=now() WHERE id=:'run_id'" >/dev/null
trap - INT TERM HUP EXIT

find "$backup_directory" -type f -name 'attendesk-*.dump' -mtime "+${BACKUP_RETENTION_DAYS:-30}" -delete
find "$backup_directory" -type f -name 'attendesk-*.dump.sha256' -mtime "+${BACKUP_RETENTION_DAYS:-30}" -delete
echo "Backup created: $backup_file"
