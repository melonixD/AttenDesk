-- AttenDesk 008: persistent admission batches for the grouped student
-- directory. A batch must not be inferred from the current semester because
-- it remains the same while a student progresses through later years.

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS batch_year text;

UPDATE students s
SET batch_year = se.academic_year
FROM semesters se
WHERE se.id = s.semester_id
  AND (s.batch_year IS NULL OR trim(s.batch_year) = '');

ALTER TABLE students
  ALTER COLUMN batch_year SET NOT NULL;

ALTER TABLE students
  DROP CONSTRAINT IF EXISTS students_batch_year_format_check;
ALTER TABLE students
  ADD CONSTRAINT students_batch_year_format_check
  CHECK (batch_year ~ '^[0-9]{2,4}-[0-9]{2,4}$');

CREATE INDEX IF NOT EXISTS students_directory_group_idx
  ON students(branch_id, semester_id, batch_year, roll_number);
