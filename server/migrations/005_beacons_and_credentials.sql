-- AttenDesk 005: server-token ESP32 beacons, classroom registry and credential login.

-- 1. Credentials -------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS username citext;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (organization_id, username) WHERE username IS NOT NULL;

-- 2. Classroom registry ------------------------------------------------------
CREATE TABLE IF NOT EXISTS classrooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  room_number text NOT NULL,
  building text,
  floor text,
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  min_rssi smallint NOT NULL DEFAULT -92 CHECK (min_rssi BETWEEN -127 AND -10),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, room_number)
);
CREATE INDEX IF NOT EXISTS classrooms_room_lookup_idx ON classrooms (organization_id, lower(trim(room_number)));

-- 3. ESP32 beacon registry ---------------------------------------------------
-- A beacon holds no secret of its own beyond a provisioning key. It polls the
-- API and advertises only the rotating code the server hands it.
CREATE TABLE IF NOT EXISTS beacons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  classroom_id uuid REFERENCES classrooms(id) ON DELETE SET NULL,
  beacon_code text NOT NULL,
  label text NOT NULL,
  device_key_hash text NOT NULL,
  hardware text NOT NULL DEFAULT 'esp32',
  firmware_version text,
  status text NOT NULL DEFAULT 'provisioned' CHECK (status IN ('provisioned', 'online', 'offline', 'disabled')),
  last_seen_at timestamptz,
  last_ip_hash text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, beacon_code),
  -- Globally unique: a beacon authenticates by code alone, before any
  -- organisation is known, so two colleges must never share one.
  UNIQUE (beacon_code)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_enabled_beacon_per_classroom
  ON beacons (classroom_id) WHERE enabled = true AND classroom_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS beacons_seen_idx ON beacons (organization_id, last_seen_at DESC);

-- 4. Bind sessions to the classroom and beacon that carried them -------------
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS classroom_id uuid REFERENCES classrooms(id);
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS beacon_id uuid REFERENCES beacons(id);
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id);
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS absent_written_at timestamptz;

UPDATE attendance_sessions a
SET organization_id = o.organization_id
FROM course_offerings o
WHERE o.id = a.offering_id AND a.organization_id IS NULL;

CREATE INDEX IF NOT EXISTS sessions_org_active_idx
  ON attendance_sessions (organization_id, ends_at DESC) WHERE status = 'active';

-- 5. Record which proof carried the attendance -------------------------------
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS proof text;
ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_proof_check;
ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_records_proof_check
  CHECK (proof IS NULL OR proof IN ('rotating_beacon', 'session_token', 'manual', 'admin'));

ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_method_check;
ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_records_method_check
  CHECK (method IN ('barcode_ble', 'barcode_web_ble', 'manual', 'admin_correction'));

-- 6. Beacon heartbeat history (health panel + telemetry) ---------------------
CREATE TABLE IF NOT EXISTS beacon_events (
  id bigserial PRIMARY KEY,
  beacon_id uuid NOT NULL REFERENCES beacons(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('poll', 'advertise_start', 'advertise_stop', 'error', 'boot')),
  session_id uuid REFERENCES attendance_sessions(id) ON DELETE SET NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS beacon_events_recent_idx ON beacon_events (beacon_id, created_at DESC);
