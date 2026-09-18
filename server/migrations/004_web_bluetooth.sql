ALTER TABLE student_devices DROP CONSTRAINT IF EXISTS student_devices_platform_check;
ALTER TABLE student_devices
  ADD CONSTRAINT student_devices_platform_check CHECK (platform IN ('android', 'ios', 'web'));

ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_method_check;
ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_records_method_check CHECK (method IN ('barcode_ble', 'barcode_web_ble', 'manual', 'admin_correction'));

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS client_type text;
UPDATE refresh_tokens
SET client_type = CASE WHEN installation_id IS NULL THEN 'web' ELSE 'mobile' END
WHERE client_type IS NULL;
ALTER TABLE refresh_tokens ALTER COLUMN client_type SET DEFAULT 'web';
ALTER TABLE refresh_tokens ALTER COLUMN client_type SET NOT NULL;
ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_client_type_check;
ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_client_type_check CHECK (client_type IN ('web', 'mobile', 'web_ble'));
