CREATE INDEX IF NOT EXISTS refresh_tokens_active_user_idx
  ON refresh_tokens(user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS timetable_active_lookup_idx
  ON timetable_entries(offering_id, day_of_week, valid_from, valid_until, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS timetable_room_lookup_idx
  ON timetable_entries(lower(trim(room)), day_of_week, valid_from, valid_until, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS attendance_active_room_idx
  ON attendance_sessions(lower(trim(room)), ends_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS enrollment_student_idx
  ON student_enrollments(student_id, offering_id);
