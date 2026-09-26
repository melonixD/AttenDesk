-- AttenDesk 006: post-session corrections and student attendance appeals.

CREATE TABLE IF NOT EXISTS attendance_appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  attendance_record_id uuid NOT NULL REFERENCES attendance_records(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (length(trim(reason)) >= 4),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_status text NOT NULL DEFAULT 'present' CHECK (requested_status IN ('present', 'absent', 'excused')),
  resolution_note text,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_appeal_per_record
  ON attendance_appeals(attendance_record_id, student_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS attendance_appeals_org_queue_idx
  ON attendance_appeals(organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS attendance_appeals_student_history_idx
  ON attendance_appeals(student_id, created_at DESC);

CREATE INDEX IF NOT EXISTS attendance_sessions_closed_lookup_idx
  ON attendance_sessions(organization_id, starts_at DESC)
  WHERE status = 'closed';
