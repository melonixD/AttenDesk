/**
 * AttenDesk — Harcourt Butler Technical University pilot seed.
 *
 * Idempotent: safe to run more than once. Creates the organisation, the two
 * administrators, the first teacher, the pilot students, the Food Technology
 * academic structure, three classrooms and their ESP32 beacons.
 *
 *   npm run seed:hbtu
 *
 * Beacon device keys are printed ONCE. Copy them into the firmware immediately;
 * only their hashes are stored. If you lose one, rotate it from the admin panel.
 */
import { createDatabase } from "../src/db.js";
import { hashPassword, keyedHash, passwordProblem, randomToken, sha256 } from "../src/security.js";

const db = createDatabase();
const pepper = process.env.BARCODE_PEPPER;
if (!pepper || pepper.length < 32) throw new Error("BARCODE_PEPPER (32+ chars) must be set before seeding — barcodes are hashed with it");

const DOMAIN = process.env.COLLEGE_EMAIL_DOMAIN || "hbtu.ac.in";
const YEAR = process.env.ACADEMIC_YEAR || "2025-26";

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

const upsertUser = async ({ orgId, email, username, fullName, role, password }) => {
  const existing = await one("SELECT id FROM users WHERE organization_id=$1 AND lower(email)=lower($2)", [orgId, email]);
  if (existing) {
    await db.query(
      "UPDATE users SET full_name=$2, username=$4, password_set_at=CASE WHEN password_hash IS NULL AND $5 IS NOT NULL THEN now() ELSE password_set_at END, password_hash=COALESCE(password_hash,$5) WHERE id=$1 AND role=$3",
      [existing.id, fullName, role, username || null, password ? hashPassword(password) : null]
    );
    return existing.id;
  }
  const created = await one(
    `INSERT INTO users(organization_id,email,full_name,role,status,username,password_hash,password_set_at)
     VALUES($1,$2,$3,$4,'active',$5,$6,CASE WHEN $6 IS NULL THEN NULL ELSE now() END) RETURNING id`,
    [orgId, email, fullName, role, username || null, password ? hashPassword(password) : null]
  );
  return created.id;
};

try {
  for (const name of ['SEED_ADMIN_PASSWORD', 'SEED_TEACHER_PASSWORD']) {
    if (passwordProblem(process.env[name])) throw new Error(`Set ${name} to a unique password containing 8+ characters, letters and numbers before seeding.`);
  }
  console.log("Seeding Harcourt Butler Technical University…\n");

  /* --- Organisation ------------------------------------------------------ */
  const org = await one(
    `INSERT INTO organizations(name,email_domain,timezone,attendance_threshold)
     VALUES($1,$2,$3,$4) ON CONFLICT(email_domain) DO UPDATE SET name=EXCLUDED.name, timezone=EXCLUDED.timezone RETURNING id`,
    ["Harcourt Butler Technical University", DOMAIN, process.env.COLLEGE_TIMEZONE || "Asia/Kolkata", Number(process.env.ATTENDANCE_THRESHOLD || 75)]
  );
  console.log(`  organisation  Harcourt Butler Technical University (@${DOMAIN})`);

  /* --- Administrators ---------------------------------------------------- */
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  await upsertUser({ orgId: org.id, email: `melonix@${DOMAIN}`, username: "melonix", fullName: "Akshat Shukla", role: "admin", password: adminPassword });
  await upsertUser({ orgId: org.id, email: `babatillu@${DOMAIN}`, username: "babatillu", fullName: "Priyanshu", role: "admin", password: adminPassword });
  console.log("  admins        melonix, babatillu");

  /* --- Academic structure ------------------------------------------------ */
  const branch = await one(
    `INSERT INTO branches(organization_id,code,name) VALUES($1,'FOF','Food Technology')
     ON CONFLICT(organization_id,code) DO UPDATE SET name=EXCLUDED.name, active=true RETURNING id`, [org.id]
  );
  const semester = await one(
    `INSERT INTO semesters(organization_id,number,academic_year,term,starts_on,ends_on)
     VALUES($1,3,$2,'odd',$3,$4) ON CONFLICT(organization_id,number,academic_year,term) DO UPDATE SET active=true RETURNING id`,
    [org.id, YEAR, process.env.SEMESTER_STARTS_ON || "2025-07-21", process.env.SEMESTER_ENDS_ON || "2025-12-20"]
  );
  const section = await one(
    `INSERT INTO sections(branch_id,semester_id,name) VALUES($1,$2,'A')
     ON CONFLICT(branch_id,semester_id,name) DO UPDATE SET active=true RETURNING id`, [branch.id, semester.id]
  );
  console.log("  academic      Food Technology (FOF) · Semester 3 · Section A");

  const subjectRows = [
    ["FOF-301", "Fluid Mechanics", 4],
    ["FOF-303", "Food Microbiology", 4],
    ["FOF-305", "Heat Transfer", 4]
  ];
  const subjects = [];
  for (const [code, name, credits] of subjectRows) {
    subjects.push(await one(
      `INSERT INTO subjects(organization_id,code,name,credits) VALUES($1,$2,$3,$4)
       ON CONFLICT(organization_id,code) DO UPDATE SET name=EXCLUDED.name, active=true RETURNING id,code,name`,
      [org.id, code, name, credits]
    ));
  }
  console.log(`  subjects      ${subjects.map((s) => s.code).join(", ")}`);

  /* --- Teacher ----------------------------------------------------------- */
  const teacherId = await upsertUser({
    orgId: org.id, email: `alakh@${DOMAIN}`, username: "alakh",
    fullName: "Alakh Kumar Singh", role: "teacher",
    password: process.env.SEED_TEACHER_PASSWORD
  });
  await db.query(
    `INSERT INTO teachers(user_id,employee_code,branch_id) VALUES($1,'HBTU-FOF-001',$2)
     ON CONFLICT(user_id) DO UPDATE SET branch_id=EXCLUDED.branch_id`,
    [teacherId, branch.id]
  );
  console.log("  teacher       Alakh Kumar Singh (username: alakh)");

  /* --- Classrooms and ESP32 beacons -------------------------------------- */
  const issuedKeys = [];
  for (const roomNumber of (process.env.SEED_ROOMS || "210,211,212").split(",").map((r) => r.trim()).filter(Boolean)) {
    const classroom = await one(
      `INSERT INTO classrooms(organization_id,room_number,building,min_rssi) VALUES($1,$2,$3,$4)
       ON CONFLICT(organization_id,room_number) DO UPDATE SET active=true RETURNING id,room_number`,
      [org.id, roomNumber, process.env.SEED_BUILDING || "Main Academic Block", Number(process.env.MIN_RSSI || -92)]
    );
    const beaconCode = `ATTENDESK-${roomNumber}`;
    const existing = await one("SELECT id FROM beacons WHERE organization_id=$1 AND beacon_code=$2", [org.id, beaconCode]);
    if (existing) {
      await db.query("UPDATE beacons SET classroom_id=$2, enabled=true WHERE id=$1", [existing.id, classroom.id]);
      continue;
    }
    const deviceKey = randomToken(24);
    await db.query(
      `INSERT INTO beacons(organization_id,classroom_id,beacon_code,label,device_key_hash,hardware)
       VALUES($1,$2,$3,$4,$5,'esp32')`,
      [org.id, classroom.id, beaconCode, `Room ${roomNumber} beacon`, sha256(deviceKey)]
    );
    issuedKeys.push({ beaconCode, room: roomNumber, deviceKey });
  }
  console.log("  classrooms    210, 211, 212 with ESP32 beacons");

  /* --- Course offerings --------------------------------------------------- */
  const offerings = [];
  const rooms = ["210", "211", "212"];
  for (const [index, subject] of subjects.entries()) {
    offerings.push(await one(
      `INSERT INTO course_offerings(organization_id,subject_id,teacher_id,section_id,semester_id,default_room)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(subject_id,teacher_id,section_id,semester_id) DO UPDATE SET active=true, default_room=EXCLUDED.default_room
       RETURNING id`,
      [org.id, subject.id, teacherId, section.id, semester.id, rooms[index % rooms.length]]
    ));
  }

  /* --- Students, barcodes and enrollments --------------------------------- */
  // The printed HBTU card carries a CODE_39 barcode whose value is the roll
  // number. Only a college-scoped keyed hash of it is stored.
  const students = [
    { fullName: "Akshat Shukla", roll: "250107010", username: "akshat" },
    { fullName: "Priyanshu", roll: "250107043", username: "priyanshu" }
  ];
  const adminId = (await one("SELECT id FROM users WHERE organization_id=$1 AND username='melonix'", [org.id])).id;

  for (const student of students) {
    const userId = await upsertUser({
      orgId: org.id, email: `${student.roll}@${DOMAIN}`, username: student.username,
      fullName: student.fullName, role: "student",
      password: process.env.SEED_STUDENT_PASSWORD || null
    });
    await db.query(
      `INSERT INTO students(user_id,roll_number,branch_id,semester_id,section_id)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET roll_number=EXCLUDED.roll_number, section_id=EXCLUDED.section_id`,
      [userId, student.roll, branch.id, semester.id, section.id]
    );
    await db.query(
      `INSERT INTO barcode_registrations(student_id,barcode_hash,barcode_last_four,registered_by)
       VALUES($1,$2,$3,$4) ON CONFLICT(student_id) DO UPDATE SET barcode_hash=EXCLUDED.barcode_hash, barcode_last_four=EXCLUDED.barcode_last_four, status='active'`,
      [userId, keyedHash(pepper, `${org.id}:${student.roll}`), student.roll.slice(-4), adminId]
    );
    for (const offering of offerings) {
      await db.query("INSERT INTO student_enrollments(offering_id,student_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [offering.id, userId]);
    }
  }
  console.log(`  students      ${students.map((s) => s.roll).join(", ")} (CODE_39 barcode = roll number)\n`);

  if (issuedKeys.length) {
    console.log("──────────────────────────────────────────────────────────────");
    console.log(" ESP32 DEVICE KEYS — shown once. Copy into firmware now.");
    console.log("──────────────────────────────────────────────────────────────");
    for (const key of issuedKeys) console.log(` Room ${key.room}  ${key.beaconCode}\n   ${key.deviceKey}\n`);
    console.log("──────────────────────────────────────────────────────────────\n");
  }

  console.log("Seed complete.\n");
  console.log("  Admin    melonix   / <SEED_ADMIN_PASSWORD>");
  console.log("  Admin    babatillu / <SEED_ADMIN_PASSWORD>");
  console.log("  Teacher  alakh     / <SEED_TEACHER_PASSWORD>");
  console.log("  Student  Akshat Shukla + 250107010");
  console.log("  Student  Priyanshu + 250107043\n");
  console.log("Change every seeded password from the app before real use.");
} finally {
  await db.close();
}
