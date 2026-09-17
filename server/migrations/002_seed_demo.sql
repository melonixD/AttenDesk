INSERT INTO organizations (id, name, email_domain, timezone, attendance_threshold)
VALUES ('00000000-0000-4000-8000-000000000001', 'Demo College', 'college.edu', 'Asia/Kolkata', 75)
ON CONFLICT (email_domain) DO NOTHING;

INSERT INTO users (id, organization_id, email, full_name, role, status)
VALUES ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'admin@college.edu', 'Main Administrator', 'admin', 'active')
ON CONFLICT (organization_id, email) DO NOTHING;

INSERT INTO branches (id, organization_id, code, name)
VALUES ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000001', 'FT', 'Food Technology')
ON CONFLICT (organization_id, code) DO NOTHING;
INSERT INTO semesters (id, organization_id, number, academic_year, term, starts_on, ends_on)
VALUES ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000001', 3, '2026-27', 'odd', '2026-07-01', '2026-12-20')
ON CONFLICT (organization_id, number, academic_year, term) DO NOTHING;

INSERT INTO sections (id, branch_id, semester_id, name)
VALUES ('00000000-0000-4000-8000-000000000040', '00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000030', 'A')
ON CONFLICT (branch_id, semester_id, name) DO NOTHING;

INSERT INTO subjects (id, organization_id, code, name, credits)
VALUES
  ('00000000-0000-4000-8000-000000000050', '00000000-0000-4000-8000-000000000001', 'FT-201', 'Fluid Mechanics', 4),
  ('00000000-0000-4000-8000-000000000051', '00000000-0000-4000-8000-000000000001', 'FT-203', 'Food Microbiology', 4)
ON CONFLICT (organization_id, code) DO NOTHING;
