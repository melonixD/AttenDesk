CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email_domain citext NOT NULL UNIQUE,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  attendance_threshold numeric(5,2) NOT NULL DEFAULT 75 CHECK (attendance_threshold BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email citext NOT NULL,
  full_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS semesters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number smallint NOT NULL CHECK (number BETWEEN 1 AND 12),
  academic_year text NOT NULL,
  term text NOT NULL CHECK (term IN ('odd', 'even', 'summer')),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK (ends_on >= starts_on),
  UNIQUE (organization_id, number, academic_year, term)
);

CREATE TABLE IF NOT EXISTS sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  semester_id uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, semester_id, name)
);

CREATE TABLE IF NOT EXISTS subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  credits numeric(4,1) NOT NULL DEFAULT 0 CHECK (credits >= 0),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS teachers (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  employee_code text NOT NULL,
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  phone text,
  UNIQUE (employee_code)
);

CREATE TABLE IF NOT EXISTS students (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  roll_number text NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id),
  semester_id uuid NOT NULL REFERENCES semesters(id),
  section_id uuid NOT NULL REFERENCES sections(id),
  phone text,
  profile_photo_url text,
  UNIQUE (roll_number)
);

CREATE TABLE IF NOT EXISTS registration_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email citext NOT NULL,
  full_name text NOT NULL,
  requested_role text NOT NULL CHECK (requested_role IN ('teacher', 'student')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  email_verified_at timestamptz,
  status text NOT NULL DEFAULT 'email_pending' CHECK (status IN ('email_pending', 'pending_approval', 'approved', 'rejected')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email citext NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('login', 'registration')),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts smallint NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_email_recent_idx ON otp_challenges (organization_id, email, created_at DESC);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  installation_id text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS course_offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES subjects(id),
  teacher_id uuid NOT NULL REFERENCES teachers(user_id),
  section_id uuid NOT NULL REFERENCES sections(id),
  semester_id uuid NOT NULL REFERENCES semesters(id),
  default_room text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (subject_id, teacher_id, section_id, semester_id)
);

CREATE TABLE IF NOT EXISTS student_enrollments (
  offering_id uuid NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (offering_id, student_id)
);

CREATE TABLE IF NOT EXISTS timetable_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id uuid NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  starts_at time NOT NULL,
  ends_at time NOT NULL,
  room text NOT NULL,
  valid_from date NOT NULL,
  valid_until date NOT NULL,
  CHECK (ends_at > starts_at),
  CHECK (valid_until >= valid_from)
);

CREATE TABLE IF NOT EXISTS barcode_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL UNIQUE REFERENCES students(user_id) ON DELETE CASCADE,
  barcode_hash text NOT NULL UNIQUE,
  barcode_last_four text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replaced', 'revoked')),
  registered_by uuid NOT NULL REFERENCES users(id),
  registered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  installation_id text NOT NULL,
  device_name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'revoked')),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, installation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_device_per_student ON student_devices(student_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS one_student_per_active_device ON student_devices(installation_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS device_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  old_device_id uuid REFERENCES student_devices(id),
  requested_installation_id text NOT NULL,
  requested_device_name text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_device_change ON device_change_requests(student_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS attendance_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id uuid NOT NULL REFERENCES course_offerings(id),
  teacher_id uuid NOT NULL REFERENCES teachers(user_id),
  room text NOT NULL,
  beacon_token_hash text NOT NULL UNIQUE,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS active_sessions_idx ON attendance_sessions(status, ends_at);

CREATE TABLE IF NOT EXISTS attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('present', 'absent', 'excused')),
  method text NOT NULL CHECK (method IN ('barcode_ble', 'manual', 'admin_correction')),
  median_rssi smallint,
  marked_at timestamptz NOT NULL DEFAULT now(),
  marked_by uuid NOT NULL REFERENCES users(id),
  reason text,
  UNIQUE (session_id, student_id)
);
CREATE INDEX IF NOT EXISTS attendance_student_idx ON attendance_records(student_id, marked_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  request_id text,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_org_time_idx ON audit_logs(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backup_runs (
  id bigserial PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  storage_path text,
  checksum text,
  size_bytes bigint,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
