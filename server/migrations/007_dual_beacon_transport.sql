-- AttenDesk 007: dual ESP32 transport.
-- Wi-Fi mode keeps server-polled rotating codes. Bluetooth mode lets a teacher
-- provision the room beacon directly when campus Wi-Fi is unavailable.

ALTER TABLE attendance_sessions
  ADD COLUMN IF NOT EXISTS beacon_transport text NOT NULL DEFAULT 'wifi';

ALTER TABLE attendance_sessions
  DROP CONSTRAINT IF EXISTS attendance_sessions_beacon_transport_check;
ALTER TABLE attendance_sessions
  ADD CONSTRAINT attendance_sessions_beacon_transport_check
  CHECK (beacon_transport IN ('wifi', 'bluetooth'));

ALTER TABLE attendance_records
  DROP CONSTRAINT IF EXISTS attendance_records_proof_check;
ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_records_proof_check
  CHECK (proof IS NULL OR proof IN ('rotating_beacon', 'session_token', 'direct_ble', 'manual', 'admin'));

