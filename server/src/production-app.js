import crypto from "node:crypto";
import express from "express";
import { fileURLToPath } from "node:url";
import { attendancePdf, attendanceWorkbook } from "./reports.js";
import { createMailer } from "./mailer.js";
import { createRateLimiter, ipDigest, issueAccessToken, keyedHash, numericOtp, otpHash, randomToken, securityHeaders, sha256, verifyAccessToken } from "./security.js";

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const cleanEmail = (value) => String(value || "").trim().toLowerCase();
const cleanRoom = (value) => String(value || "").trim().replace(/\s+/g, " ");
const required = (body, fields) => fields.filter((field) => !String(body[field] ?? "").trim());
const median = (values = []) => {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

export function createProductionApp({ db, mailer = createMailer(), app = express() }) {
  const authSecret = process.env.AUTH_SECRET;
  const otpSecret = process.env.OTP_SECRET;
  const barcodePepper = process.env.BARCODE_PEPPER;
  if (!authSecret || !otpSecret || !barcodePepper) throw new Error("AUTH_SECRET, OTP_SECRET and BARCODE_PEPPER are required");
  if ([authSecret, otpSecret, barcodePepper].some((value) => value.length < 32)) throw new Error("Security secrets must each contain at least 32 characters");
  if (new Set([authSecret, otpSecret, barcodePepper]).size !== 3) throw new Error("AUTH_SECRET, OTP_SECRET and BARCODE_PEPPER must be different");
  const enforceTimetable = process.env.ENFORCE_TIMETABLE === "true" || (process.env.ENFORCE_TIMETABLE !== "false" && process.env.NODE_ENV === "production");
  const configuredGraceMinutes = Number(process.env.TIMETABLE_GRACE_MINUTES);
  const timetableGraceMinutes = Math.max(0, Math.min(60, Number.isFinite(configuredGraceMinutes) ? configuredGraceMinutes : 10));
  const configuredMinRssi = Number(process.env.MIN_RSSI);
  const minimumRssi = Number.isFinite(configuredMinRssi) ? Math.max(-127, Math.min(-10, configuredMinRssi)) : -92;

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(express.json({ limit: "100kb", strict: true }));
  app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    next();
  });
  app.use("/api/auth", createRateLimiter({ max: 12, windowMs: 10 * 60_000 }));
  app.use("/api", createRateLimiter({ max: 180, windowMs: 60_000 }));

  const authenticate = asyncRoute(async (req, res, next) => {
    const raw = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const claims = verifyAccessToken(authSecret, raw);
    if (!claims) return res.status(401).json({ error: "UNAUTHORISED" });
    const user = await db.query("SELECT id, organization_id, email, full_name, role, status FROM users WHERE id=$1", [claims.sub]);
    if (!user.rows[0] || user.rows[0].status !== "active") return res.status(401).json({ error: "ACCOUNT_INACTIVE" });
    req.user = user.rows[0];
    req.authClaims = claims;
    next();
  });
  const roles = (...allowed) => (req, res, next) => allowed.includes(req.user.role) ? next() : res.status(403).json({ error: "FORBIDDEN" });
  const audit = async (client, req, action, entityType, entityId, beforeData = null, afterData = null) => {
    await client.query(
      "INSERT INTO audit_logs(organization_id, actor_id, action, entity_type, entity_id, before_data, after_data, request_id, ip_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [req.user.organization_id, req.user.id, action, entityType, String(entityId || ""), beforeData, afterData, req.requestId, ipDigest(authSecret, req.ip)]
    );
  };
  const organizationForEmail = async (email) => {
    const domain = email.split("@")[1];
    if (!domain) return null;
    const result = await db.query("SELECT * FROM organizations WHERE lower(email_domain)=lower($1)", [domain]);
    return result.rows[0] || null;
  };
  const registrationAssignmentIsValid = async (connection, organizationId, role, details) => {
    if (role === "teacher") {
      if (!details.branchId) return true;
      const branch = await connection.query("SELECT 1 FROM branches WHERE id=$1 AND organization_id=$2 AND active=true", [details.branchId, organizationId]);
      return Boolean(branch.rowCount);
    }
    const academic = await connection.query(
      `SELECT 1 FROM branches b JOIN semesters se ON se.id=$2 JOIN sections sc ON sc.id=$3
       WHERE b.id=$1 AND b.organization_id=$4 AND se.organization_id=$4 AND sc.branch_id=b.id AND sc.semester_id=se.id
         AND b.active=true AND se.active=true AND sc.active=true`,
      [details.branchId, details.semesterId, details.sectionId, organizationId]
    );
    return Boolean(academic.rowCount);
  };
  const createOtp = async ({ organization, email, purpose }) => {
    const code = numericOtp();
    await db.query(
      "INSERT INTO otp_challenges(organization_id,email,purpose,code_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",
      [organization.id, email, purpose, otpHash(otpSecret, organization.id, email, code)]
    );
    return mailer.sendOtp({ email, code, purpose });
  };
  const consumeOtp = async ({ organizationId, email, purpose, code }) => db.transaction(async (client) => {
    const found = await client.query(
      "SELECT * FROM otp_challenges WHERE organization_id=$1 AND lower(email)=lower($2) AND purpose=$3 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [organizationId, email, purpose]
    );
    const challenge = found.rows[0];
    if (!challenge || new Date(challenge.expires_at).getTime() <= Date.now()) throw Object.assign(new Error("OTP expired or missing"), { status: 400, code: "OTP_EXPIRED" });
    if (challenge.attempts >= 5) throw Object.assign(new Error("Too many incorrect attempts"), { status: 429, code: "OTP_LOCKED" });
    if (otpHash(otpSecret, organizationId, email, code) !== challenge.code_hash) {
      await client.query("UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1", [challenge.id]);
      throw Object.assign(new Error("Incorrect OTP"), { status: 400, code: "OTP_INCORRECT" });
    }
    await client.query("UPDATE otp_challenges SET consumed_at=now() WHERE id=$1", [challenge.id]);
    return client;
  });
  const timetableConflict = async (client, { organizationId, offeringId, dayOfWeek, startsAt, endsAt, room, validFrom, validUntil, excludeId = null }) => {
    const result = await client.query(
      `SELECT t.id,su.name AS subject,u.full_name AS teacher,sc.name AS section,t.room,
       CASE WHEN existing.teacher_id=target.teacher_id THEN 'teacher'
            WHEN existing.section_id=target.section_id THEN 'section' ELSE 'room' END AS conflict_type
       FROM timetable_entries t
       JOIN course_offerings existing ON existing.id=t.offering_id
       JOIN course_offerings target ON target.id=$1 AND target.organization_id=$2
       JOIN subjects su ON su.id=existing.subject_id JOIN users u ON u.id=existing.teacher_id JOIN sections sc ON sc.id=existing.section_id
       WHERE existing.organization_id=$2 AND t.day_of_week=$3
         AND t.starts_at<$5::time AND t.ends_at>$4::time
         AND t.valid_from<=$8::date AND t.valid_until>=$7::date
         AND ($9::uuid IS NULL OR t.id<>$9::uuid)
         AND (existing.teacher_id=target.teacher_id OR existing.section_id=target.section_id OR lower(trim(t.room))=lower(trim($6)))
       ORDER BY t.starts_at LIMIT 1`,
      [offeringId, organizationId, dayOfWeek, startsAt, endsAt, room, validFrom, validUntil, excludeId]
    );
    return result.rows[0] || null;
  };
  const validateTimetableInput = ({ dayOfWeek, startsAt, endsAt, room, validFrom, validUntil }) => {
    if (!Number.isInteger(Number(dayOfWeek)) || Number(dayOfWeek) < 1 || Number(dayOfWeek) > 7) return "INVALID_DAY";
    if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(String(startsAt)) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(String(endsAt)) || String(endsAt) <= String(startsAt)) return "INVALID_TIME_RANGE";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(validFrom)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(validUntil)) || String(validUntil) < String(validFrom)) return "INVALID_DATE_RANGE";
    if (!cleanRoom(room)) return "ROOM_REQUIRED";
    return null;
  };

  app.get("/health", asyncRoute(async (_req, res) => {
    await db.query("SELECT 1");
    res.json({ ok: true, service: "attendesk-production", time: new Date().toISOString() });
  }));

  app.get("/api/public/catalog", asyncRoute(async (req, res) => {
    const organization = await organizationForEmail(cleanEmail(req.query.email));
    if (!organization) return res.status(404).json({ error: "UNKNOWN_COLLEGE" });
    const [branches, semesters, sections] = await Promise.all([
      db.query("SELECT id,code,name FROM branches WHERE organization_id=$1 AND active=true ORDER BY name", [organization.id]),
      db.query("SELECT id,number,academic_year,term FROM semesters WHERE organization_id=$1 AND active=true ORDER BY academic_year DESC,number", [organization.id]),
      db.query("SELECT s.id,s.name,s.branch_id,s.semester_id FROM sections s JOIN branches b ON b.id=s.branch_id WHERE b.organization_id=$1 AND s.active=true ORDER BY s.name", [organization.id])
    ]);
    res.json({ organization: { name: organization.name, emailDomain: organization.email_domain }, branches: branches.rows, semesters: semesters.rows, sections: sections.rows });
  }));

  app.post("/api/auth/register", asyncRoute(async (req, res) => {
    const missing = required(req.body, ["email", "fullName", "role"]);
    if (missing.length) return res.status(400).json({ error: "MISSING_FIELDS", fields: missing });
    const email = cleanEmail(req.body.email);
    const role = req.body.role;
    if (!['teacher', 'student'].includes(role)) return res.status(400).json({ error: "BAD_ROLE" });
    const organization = await organizationForEmail(email);
    if (!organization) return res.status(403).json({ error: "COLLEGE_EMAIL_REQUIRED" });
    const existing = await db.query("SELECT 1 FROM users WHERE organization_id=$1 AND lower(email)=lower($2)", [organization.id, email]);
    if (existing.rowCount) return res.status(409).json({ error: "ACCOUNT_EXISTS" });
    const details = role === "student"
      ? { rollNumber: req.body.rollNumber, branchId: req.body.branchId, semesterId: req.body.semesterId, sectionId: req.body.sectionId, phone: req.body.phone || null }
      : { employeeCode: req.body.employeeCode, branchId: req.body.branchId || null, phone: req.body.phone || null };
    const roleRequired = role === "student" ? ["rollNumber", "branchId", "semesterId", "sectionId"] : ["employeeCode"];
    const detailMissing = roleRequired.filter((field) => !String(details[field] || "").trim());
    if (detailMissing.length) return res.status(400).json({ error: "MISSING_FIELDS", fields: detailMissing });
    if (!await registrationAssignmentIsValid(db, organization.id, role, details)) return res.status(400).json({ error: "INVALID_ACADEMIC_ASSIGNMENT" });
    const result = await db.query(
      `INSERT INTO registration_requests(organization_id,email,full_name,requested_role,details,status)
       VALUES($1,$2,$3,$4,$5,'email_pending')
       ON CONFLICT(organization_id,email) DO UPDATE SET full_name=EXCLUDED.full_name, requested_role=EXCLUDED.requested_role, details=EXCLUDED.details, status='email_pending', email_verified_at=NULL
       RETURNING id`,
      [organization.id, email, String(req.body.fullName).trim(), role, details]
    );
    const delivery = await createOtp({ organization, email, purpose: "registration" });
    res.status(201).json({ registrationId: result.rows[0].id, message: "Verification code sent", ...(delivery.developmentCode ? { developmentOtp: delivery.developmentCode } : {}) });
  }));

  app.post("/api/auth/verify-registration", asyncRoute(async (req, res) => {
    const email = cleanEmail(req.body.email);
    const organization = await organizationForEmail(email);
    if (!organization) return res.status(400).json({ error: "UNKNOWN_COLLEGE" });
    await consumeOtp({ organizationId: organization.id, email, purpose: "registration", code: String(req.body.code || "") });
    const result = await db.query("UPDATE registration_requests SET email_verified_at=now(), status='pending_approval' WHERE organization_id=$1 AND lower(email)=lower($2) RETURNING id,status", [organization.id, email]);
    if (!result.rowCount) return res.status(404).json({ error: "REGISTRATION_NOT_FOUND" });
    res.json({ registration: result.rows[0], message: "Email verified. Waiting for administrator approval." });
  }));

  app.post("/api/auth/request-otp", asyncRoute(async (req, res) => {
    const email = cleanEmail(req.body.email);
    const organization = await organizationForEmail(email);
    if (!organization) return res.status(403).json({ error: "COLLEGE_EMAIL_REQUIRED" });
    const user = await db.query("SELECT id,status FROM users WHERE organization_id=$1 AND lower(email)=lower($2)", [organization.id, email]);
    // Keep the response deliberately generic so this endpoint cannot enumerate approved accounts.
    if (!user.rows[0] || user.rows[0].status !== "active") return res.json({ message: "If the account is active, a login code has been sent." });
    const delivery = await createOtp({ organization, email, purpose: "login" });
    res.json({ message: "Login code sent", ...(delivery.developmentCode ? { developmentOtp: delivery.developmentCode } : {}) });
  }));

  app.post("/api/auth/verify-otp", asyncRoute(async (req, res) => {
    const email = cleanEmail(req.body.email);
    const organization = await organizationForEmail(email);
    if (!organization) return res.status(400).json({ error: "UNKNOWN_COLLEGE" });
    await consumeOtp({ organizationId: organization.id, email, purpose: "login", code: String(req.body.code || "") });
    const found = await db.query("SELECT id,organization_id,email,full_name,role,status FROM users WHERE organization_id=$1 AND lower(email)=lower($2)", [organization.id, email]);
    const user = found.rows[0];
    if (!user || user.status !== "active") return res.status(403).json({ error: "ACCOUNT_NOT_ACTIVE" });
    const requestedClientType = req.body.clientType === "web" ? "web" : req.body.clientType === "web_ble" ? "web_ble" : "mobile";
    const clientType = user.role === "student" ? requestedClientType : requestedClientType === "mobile" ? "mobile" : "web";
    const deviceBoundClient = clientType === "mobile" || clientType === "web_ble";
    const installationId = String(req.body.installationId || "").trim();
    if (user.role === "student" && deviceBoundClient) {
      if (!installationId) return res.status(400).json({ error: "INSTALLATION_ID_REQUIRED" });
      const active = await db.query("SELECT * FROM student_devices WHERE student_id=$1 AND status='active'", [user.id]);
      if (!active.rowCount) {
        const platform = clientType === "web_ble" ? "web" : req.body.platform === "ios" ? "ios" : "android";
        await db.query("INSERT INTO student_devices(student_id,installation_id,device_name,platform,status,approved_at) VALUES($1,$2,$3,$4,'active',now())", [user.id, installationId, req.body.deviceName || (clientType === "web_ble" ? "Web Bluetooth browser" : "Android phone"), platform]);
      } else if (active.rows[0].installation_id !== installationId) {
        const deviceChangeToken = issueAccessToken(authSecret, { sub: user.id, org: user.organization_id, role: "device_change" }, 600);
        return res.status(403).json({ error: "DEVICE_CHANGE_REQUIRED", message: "Submit a device-change request from this verified email.", deviceChangeToken });
      }
      await db.query("UPDATE student_devices SET last_seen_at=now() WHERE student_id=$1 AND installation_id=$2 AND status='active'", [user.id, installationId]);
    }
    const accessToken = issueAccessToken(authSecret, {
      sub: user.id, org: user.organization_id, role: user.role, clientType,
      ...(deviceBoundClient ? { installationId } : {})
    });
    const refreshToken = randomToken(48);
    await db.query("INSERT INTO refresh_tokens(user_id,token_hash,installation_id,client_type,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days')", [user.id, sha256(refreshToken), deviceBoundClient ? installationId : null, clientType]);
    await db.query("UPDATE users SET last_login_at=now() WHERE id=$1", [user.id]);
    res.json({ accessToken, refreshToken, expiresIn: 900, user });
  }));

  app.post("/api/auth/device-change-request", asyncRoute(async (req, res) => {
    const changeClaims = verifyAccessToken(authSecret, String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!changeClaims || changeClaims.role !== "device_change") return res.status(401).json({ error: "DEVICE_CHANGE_VERIFICATION_REQUIRED" });
    const email = cleanEmail(req.body.email);
    const organization = await organizationForEmail(email);
    if (!organization) return res.status(400).json({ error: "UNKNOWN_COLLEGE" });
    const user = await db.query("SELECT id FROM users WHERE organization_id=$1 AND lower(email)=lower($2) AND role='student' AND status='active'", [organization.id, email]);
    if (!user.rowCount) return res.status(404).json({ error: "STUDENT_NOT_FOUND" });
    if (user.rows[0].id !== changeClaims.sub || organization.id !== changeClaims.org) return res.status(403).json({ error: "DEVICE_CHANGE_TOKEN_MISMATCH" });
    const missing = required(req.body, ["installationId", "deviceName", "reason"]);
    if (missing.length) return res.status(400).json({ error: "MISSING_FIELDS", fields: missing });
    const active = await db.query("SELECT id FROM student_devices WHERE student_id=$1 AND status='active'", [user.rows[0].id]);
    const result = await db.query(
      `INSERT INTO device_change_requests(student_id,old_device_id,requested_installation_id,requested_device_name,reason)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(student_id) WHERE status='pending' DO UPDATE SET requested_installation_id=EXCLUDED.requested_installation_id, requested_device_name=EXCLUDED.requested_device_name, reason=EXCLUDED.reason, created_at=now()
       RETURNING id,status`,
      [user.rows[0].id, active.rows[0]?.id || null, req.body.installationId, req.body.deviceName, req.body.reason]
    );
    res.status(201).json({ request: result.rows[0], message: "Device-change request sent to an administrator" });
  }));

  app.post("/api/auth/refresh", asyncRoute(async (req, res) => {
    const tokenHash = sha256(req.body.refreshToken || "");
    const refreshed = await db.transaction(async (client) => {
      const found = await client.query(
        `SELECT r.id,r.installation_id,r.client_type,u.id AS user_id,u.organization_id,u.role,u.status FROM refresh_tokens r JOIN users u ON u.id=r.user_id
         WHERE r.token_hash=$1 AND r.revoked_at IS NULL AND r.expires_at>now() FOR UPDATE OF r`, [tokenHash]
      );
      const row = found.rows[0];
      if (!row || row.status !== "active") throw Object.assign(new Error("Refresh token is invalid or already used"), { status: 401, code: "INVALID_REFRESH_TOKEN" });
      const rotated = randomToken(48);
      await client.query("UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL", [row.id]);
      const clientType = row.client_type || (row.installation_id ? "mobile" : "web");
      await client.query("INSERT INTO refresh_tokens(user_id,token_hash,installation_id,client_type,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days')", [row.user_id, sha256(rotated), row.installation_id, clientType]);
      return { row, rotated };
    });
    const { row, rotated } = refreshed;
    const clientType = row.client_type || (row.installation_id ? "mobile" : "web");
    res.json({
      accessToken: issueAccessToken(authSecret, {
        sub: row.user_id, org: row.organization_id, role: row.role, clientType,
        ...(row.installation_id ? { installationId: row.installation_id } : {})
      }),
      refreshToken: rotated,
      expiresIn: 900
    });
  }));

  app.post("/api/auth/logout", asyncRoute(async (req, res) => {
    const tokenHash = sha256(req.body.refreshToken || "");
    await db.query("UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL", [tokenHash]);
    res.status(204).end();
  }));

  app.get("/api/me", authenticate, asyncRoute(async (req, res) => res.json({ user: req.user })));

  // Admin overview and approval workflows.
  app.get("/api/admin/overview", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query(
      `SELECT
        (SELECT count(*) FROM students s JOIN users u ON u.id=s.user_id WHERE u.organization_id=$1 AND u.status='active') AS students,
        (SELECT count(*) FROM teachers t JOIN users u ON u.id=t.user_id WHERE u.organization_id=$1 AND u.status='active') AS teachers,
        (SELECT count(*) FROM registration_requests WHERE organization_id=$1 AND status='pending_approval') AS registrations,
        (SELECT count(*) FROM device_change_requests d JOIN users u ON u.id=d.student_id WHERE u.organization_id=$1 AND d.status='pending') AS device_requests,
        (SELECT count(*) FROM attendance_sessions a JOIN course_offerings o ON o.id=a.offering_id WHERE o.organization_id=$1 AND a.starts_at::date=current_date) AS sessions_today`,
      [req.user.organization_id]
    );
    res.json(result.rows[0]);
  }));

  app.get("/api/admin/registrations", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query("SELECT * FROM registration_requests WHERE organization_id=$1 ORDER BY created_at DESC", [req.user.organization_id]);
    res.json(result.rows);
  }));

  app.post("/api/admin/registrations/:id/approve", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const created = await db.transaction(async (client) => {
      const pending = await client.query("SELECT * FROM registration_requests WHERE id=$1 AND organization_id=$2 AND status='pending_approval' FOR UPDATE", [req.params.id, req.user.organization_id]);
      const registration = pending.rows[0];
      if (!registration) throw Object.assign(new Error("Registration is not ready for approval"), { status: 404, code: "REGISTRATION_NOT_FOUND" });
      if (!await registrationAssignmentIsValid(client, registration.organization_id, registration.requested_role, registration.details)) {
        throw Object.assign(new Error("The selected branch, semester or section is no longer valid"), { status: 400, code: "INVALID_ACADEMIC_ASSIGNMENT" });
      }
      const userResult = await client.query("INSERT INTO users(organization_id,email,full_name,role,status) VALUES($1,$2,$3,$4,'active') RETURNING *", [registration.organization_id, registration.email, registration.full_name, registration.requested_role]);
      const user = userResult.rows[0];
      if (registration.requested_role === "student") {
        await client.query("INSERT INTO students(user_id,roll_number,branch_id,semester_id,section_id,phone) VALUES($1,$2,$3,$4,$5,$6)", [user.id, registration.details.rollNumber, registration.details.branchId, registration.details.semesterId, registration.details.sectionId, registration.details.phone || null]);
      } else {
        await client.query("INSERT INTO teachers(user_id,employee_code,branch_id,phone) VALUES($1,$2,$3,$4)", [user.id, registration.details.employeeCode, registration.details.branchId || null, registration.details.phone || null]);
      }
      await client.query("UPDATE registration_requests SET status='approved',reviewed_by=$1,reviewed_at=now() WHERE id=$2", [req.user.id, registration.id]);
      await audit(client, req, "REGISTRATION_APPROVED", "user", user.id, null, { email: user.email, role: user.role });
      return user;
    });
    res.json({ user: created });
  }));

  app.post("/api/admin/registrations/:id/reject", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    if (!String(req.body.reason || "").trim()) return res.status(400).json({ error: "REASON_REQUIRED" });
    const result = await db.query("UPDATE registration_requests SET status='rejected',rejection_reason=$1,reviewed_by=$2,reviewed_at=now() WHERE id=$3 AND organization_id=$4 AND status IN ('email_pending','pending_approval') RETURNING *", [req.body.reason, req.user.id, req.params.id, req.user.organization_id]);
    if (!result.rowCount) return res.status(404).json({ error: "REGISTRATION_NOT_FOUND" });
    res.json(result.rows[0]);
  }));

  const academicConfigs = {
    branches: { table: "branches", fields: ["code", "name", "active"], required: ["code", "name"], orgColumn: "organization_id", order: "name" },
    semesters: { table: "semesters", fields: ["number", "academic_year", "term", "starts_on", "ends_on", "active"], required: ["number", "academic_year", "term", "starts_on", "ends_on"], orgColumn: "organization_id", order: "academic_year DESC,number" },
    subjects: { table: "subjects", fields: ["code", "name", "credits", "active"], required: ["code", "name"], orgColumn: "organization_id", order: "name" }
  };

  app.get("/api/admin/academic/:entity", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const config = academicConfigs[req.params.entity];
    if (!config) return res.status(404).json({ error: "UNKNOWN_ENTITY" });
    const result = await db.query(`SELECT * FROM ${config.table} WHERE ${config.orgColumn}=$1 ORDER BY ${config.order}`, [req.user.organization_id]);
    res.json(result.rows);
  }));

  app.post("/api/admin/academic/:entity", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const config = academicConfigs[req.params.entity];
    if (!config) return res.status(404).json({ error: "UNKNOWN_ENTITY" });
    const missing = config.required.filter((field) => req.body[field] === undefined || req.body[field] === "");
    if (missing.length) return res.status(400).json({ error: "MISSING_FIELDS", fields: missing });
    const supplied = config.fields.filter((field) => req.body[field] !== undefined);
    const columns = [config.orgColumn, ...supplied];
    const values = [req.user.organization_id, ...supplied.map((field) => req.body[field])];
    const placeholders = values.map((_, index) => `$${index + 1}`).join(",");
    const result = await db.query(`INSERT INTO ${config.table}(${columns.join(",")}) VALUES(${placeholders}) RETURNING *`, values);
    await db.transaction((client) => audit(client, req, "ACADEMIC_CREATED", req.params.entity, result.rows[0].id, null, result.rows[0]));
    res.status(201).json(result.rows[0]);
  }));

  app.patch("/api/admin/academic/:entity/:id", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const config = academicConfigs[req.params.entity];
    if (!config) return res.status(404).json({ error: "UNKNOWN_ENTITY" });
    const supplied = config.fields.filter((field) => req.body[field] !== undefined);
    if (!supplied.length) return res.status(400).json({ error: "NO_CHANGES" });
    const values = supplied.map((field) => req.body[field]);
    const assignments = supplied.map((field, index) => `${field}=$${index + 1}`).join(",");
    values.push(req.params.id, req.user.organization_id);
    const result = await db.query(`UPDATE ${config.table} SET ${assignments} WHERE id=$${values.length - 1} AND ${config.orgColumn}=$${values.length} RETURNING *`, values);
    if (!result.rowCount) return res.status(404).json({ error: "NOT_FOUND" });
    res.json(result.rows[0]);
  }));

  app.delete("/api/admin/academic/:entity/:id", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const config = academicConfigs[req.params.entity];
    if (!config) return res.status(404).json({ error: "UNKNOWN_ENTITY" });
    const result = await db.query(`UPDATE ${config.table} SET active=false WHERE id=$1 AND ${config.orgColumn}=$2 RETURNING id`, [req.params.id, req.user.organization_id]);
    if (!result.rowCount) return res.status(404).json({ error: "NOT_FOUND" });
    res.status(204).end();
  }));

  app.get("/api/admin/sections", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query(
      `SELECT s.*,b.name AS branch_name,b.code AS branch_code,se.number AS semester_number,se.academic_year
       FROM sections s JOIN branches b ON b.id=s.branch_id JOIN semesters se ON se.id=s.semester_id
       WHERE b.organization_id=$1 ORDER BY b.name,se.number,s.name`, [req.user.organization_id]
    );
    res.json(result.rows);
  }));

  app.post("/api/admin/sections", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const missing = required(req.body, ["branchId", "semesterId", "name"]);
    if (missing.length) return res.status(400).json({ error: "MISSING_FIELDS", fields: missing });
    const parents = await db.query(
      `SELECT b.id AS branch_id,se.id AS semester_id FROM branches b CROSS JOIN semesters se
       WHERE b.id=$1 AND se.id=$2 AND b.organization_id=$3 AND se.organization_id=$3`,
      [req.body.branchId, req.body.semesterId, req.user.organization_id]
    );
    if (!parents.rowCount) return res.status(400).json({ error: "INVALID_BRANCH_OR_SEMESTER" });
    const result = await db.query("INSERT INTO sections(branch_id,semester_id,name) VALUES($1,$2,$3) RETURNING *", [req.body.branchId, req.body.semesterId, String(req.body.name).trim()]);
    res.status(201).json(result.rows[0]);
  }));

  app.patch("/api/admin/sections/:id", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query(
      `UPDATE sections s SET name=COALESCE($1,s.name),active=COALESCE($2,s.active)
       FROM branches b WHERE s.id=$3 AND b.id=s.branch_id AND b.organization_id=$4 RETURNING s.*`,
      [req.body.name || null, req.body.active ?? null, req.params.id, req.user.organization_id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "SECTION_NOT_FOUND" });
    res.json(result.rows[0]);
  }));

  app.get("/api/admin/people", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const role = req.query.role === "teacher" ? "teacher" : "student";
    const query = role === "student"
      ? `SELECT u.id,u.full_name,u.email,u.status,s.roll_number,b.name AS branch,se.number AS semester,sc.name AS section,
           br.barcode_last_four,br.status AS barcode_status,sd.device_name,sd.last_seen_at
         FROM users u JOIN students s ON s.user_id=u.id JOIN branches b ON b.id=s.branch_id JOIN semesters se ON se.id=s.semester_id
         JOIN sections sc ON sc.id=s.section_id LEFT JOIN barcode_registrations br ON br.student_id=u.id AND br.status='active'
         LEFT JOIN student_devices sd ON sd.student_id=u.id AND sd.status='active'
         WHERE u.organization_id=$1 ORDER BY s.roll_number`
      : `SELECT u.id,u.full_name,u.email,u.status,t.employee_code,b.name AS branch
         FROM users u JOIN teachers t ON t.user_id=u.id LEFT JOIN branches b ON b.id=t.branch_id
         WHERE u.organization_id=$1 ORDER BY u.full_name`;
    const result = await db.query(query, [req.user.organization_id]);
    res.json(result.rows);
  }));

  app.patch("/api/admin/users/:id/status", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const status = req.body.status;
    if (!["active", "suspended"].includes(status)) return res.status(400).json({ error: "INVALID_USER_STATUS" });
    if (req.params.id === req.user.id) return res.status(400).json({ error: "CANNOT_CHANGE_OWN_STATUS" });
    const updated = await db.transaction(async (client) => {
      const before = await client.query("SELECT id,email,full_name,role,status FROM users WHERE id=$1 AND organization_id=$2 AND role IN ('teacher','student') FOR UPDATE", [req.params.id, req.user.organization_id]);
      if (!before.rowCount) throw Object.assign(new Error("User not found"), { status: 404, code: "USER_NOT_FOUND" });
      const result = await client.query("UPDATE users SET status=$1,updated_at=now() WHERE id=$2 RETURNING id,email,full_name,role,status", [status, req.params.id]);
      if (status === "suspended") await client.query("UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [req.params.id]);
      await audit(client, req, status === "suspended" ? "USER_SUSPENDED" : "USER_REACTIVATED", "user", req.params.id, before.rows[0], result.rows[0]);
      return result.rows[0];
    });
    res.json(updated);
  }));

  app.post("/api/admin/students/:id/barcode", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const barcode = String(req.body.barcode || "").trim();
    if (barcode.length < 4 || barcode.length > 128) return res.status(400).json({ error: "INVALID_BARCODE" });
    const student = await db.query("SELECT s.user_id FROM students s JOIN users u ON u.id=s.user_id WHERE s.user_id=$1 AND u.organization_id=$2", [req.params.id, req.user.organization_id]);
    if (!student.rowCount) return res.status(404).json({ error: "STUDENT_NOT_FOUND" });
    const hash = keyedHash(barcodePepper, `${req.user.organization_id}:${barcode}`);
    const result = await db.transaction(async (client) => {
      const before = await client.query("SELECT * FROM barcode_registrations WHERE student_id=$1 AND status='active'", [req.params.id]);
      await client.query("UPDATE barcode_registrations SET status='replaced' WHERE student_id=$1 AND status='active'", [req.params.id]);
      const inserted = await client.query(
        `INSERT INTO barcode_registrations(student_id,barcode_hash,barcode_last_four,status,registered_by)
         VALUES($1,$2,$3,'active',$4)
         ON CONFLICT(student_id) DO UPDATE SET barcode_hash=EXCLUDED.barcode_hash,barcode_last_four=EXCLUDED.barcode_last_four,status='active',registered_by=EXCLUDED.registered_by,registered_at=now()
         RETURNING id,student_id,barcode_last_four,status,registered_at`,
        [req.params.id, hash, barcode.slice(-4), req.user.id]
      );
      await audit(client, req, "BARCODE_REGISTERED", "student", req.params.id, before.rows[0] || null, inserted.rows[0]);
      return inserted.rows[0];
    });
    res.json(result);
  }));

  app.get("/api/admin/device-change-requests", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query(
      `SELECT d.*,u.full_name,u.email,s.roll_number,old.device_name AS old_device_name
       FROM device_change_requests d JOIN users u ON u.id=d.student_id JOIN students s ON s.user_id=d.student_id
       LEFT JOIN student_devices old ON old.id=d.old_device_id
       WHERE u.organization_id=$1 ORDER BY (d.status='pending') DESC,d.created_at DESC`, [req.user.organization_id]
    );
    res.json(result.rows);
  }));

  app.post("/api/admin/device-change-requests/:id/approve", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.transaction(async (client) => {
      const found = await client.query(
        `SELECT d.* FROM device_change_requests d JOIN users u ON u.id=d.student_id
         WHERE d.id=$1 AND u.organization_id=$2 AND d.status='pending' FOR UPDATE`, [req.params.id, req.user.organization_id]
      );
      const request = found.rows[0];
      if (!request) throw Object.assign(new Error("Device request not found"), { status: 404, code: "DEVICE_REQUEST_NOT_FOUND" });
      await client.query("UPDATE student_devices SET status='revoked' WHERE student_id=$1 AND status='active'", [request.student_id]);
      await client.query("UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [request.student_id]);
      const device = await client.query(
        `INSERT INTO student_devices(student_id,installation_id,device_name,platform,status,approved_by,approved_at)
         VALUES($1,$2,$3,'android','active',$4,now())
         ON CONFLICT(student_id,installation_id) DO UPDATE SET device_name=EXCLUDED.device_name,status='active',approved_by=EXCLUDED.approved_by,approved_at=now()
         RETURNING *`, [request.student_id, request.requested_installation_id, request.requested_device_name, req.user.id]
      );
      await client.query("UPDATE device_change_requests SET status='approved',reviewed_by=$1,reviewed_at=now() WHERE id=$2", [req.user.id, request.id]);
      await audit(client, req, "DEVICE_CHANGE_APPROVED", "student_device", device.rows[0].id, null, { studentId: request.student_id, deviceName: request.requested_device_name });
      return device.rows[0];
    });
    res.json(result);
  }));

  app.post("/api/admin/device-change-requests/:id/reject", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query(
      `UPDATE device_change_requests d SET status='rejected',reviewed_by=$1,reviewed_at=now()
       FROM users u WHERE d.id=$2 AND u.id=d.student_id AND u.organization_id=$3 AND d.status='pending' RETURNING d.*`,
      [req.user.id, req.params.id, req.user.organization_id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "DEVICE_REQUEST_NOT_FOUND" });
    res.json(result.rows[0]);
  }));

  app.get("/api/admin/offerings", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query(
      `SELECT o.id,o.default_room,o.active,su.name AS subject,su.code AS subject_code,u.full_name AS teacher,
       b.name AS branch,sc.name AS section,se.number AS semester
       FROM course_offerings o JOIN subjects su ON su.id=o.subject_id JOIN users u ON u.id=o.teacher_id
       JOIN sections sc ON sc.id=o.section_id JOIN branches b ON b.id=sc.branch_id JOIN semesters se ON se.id=o.semester_id
       WHERE o.organization_id=$1 ORDER BY se.number,b.name,sc.name,su.name`, [req.user.organization_id]
    );
    res.json(result.rows);
  }));

  app.post("/api/admin/offerings", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const missing = required(req.body, ["subjectId", "teacherId", "sectionId", "semesterId", "defaultRoom"]);
    if (missing.length) return res.status(400).json({ error: "MISSING_FIELDS", fields: missing });
    const result = await db.query(
      `INSERT INTO course_offerings(organization_id,subject_id,teacher_id,section_id,semester_id,default_room)
       SELECT $1,$2,$3,$4,$5,$6
       WHERE EXISTS(SELECT 1 FROM teachers t JOIN users u ON u.id=t.user_id WHERE t.user_id=$3 AND u.organization_id=$1)
         AND EXISTS(SELECT 1 FROM subjects su WHERE su.id=$2 AND su.organization_id=$1 AND su.active=true)
         AND EXISTS(SELECT 1 FROM sections sc JOIN branches b ON b.id=sc.branch_id WHERE sc.id=$4 AND sc.semester_id=$5 AND b.organization_id=$1 AND sc.active=true)
         AND EXISTS(SELECT 1 FROM semesters se WHERE se.id=$5 AND se.organization_id=$1 AND se.active=true)
       RETURNING *`,
      [req.user.organization_id, req.body.subjectId, req.body.teacherId, req.body.sectionId, req.body.semesterId, req.body.defaultRoom]
    );
    if (!result.rowCount) return res.status(400).json({ error: "INVALID_COURSE_ASSIGNMENT" });
    res.status(201).json(result.rows[0]);
  }));

  app.post("/api/admin/enrollments", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const eligible = await db.query(
      `SELECT 1 FROM course_offerings o JOIN students s ON s.user_id=$2 JOIN users u ON u.id=s.user_id
       WHERE o.id=$1 AND o.organization_id=$3 AND o.active=true AND u.organization_id=$3 AND u.status='active'`,
      [req.body.offeringId, req.body.studentId, req.user.organization_id]
    );
    if (!eligible.rowCount) return res.status(404).json({ error: "STUDENT_OR_OFFERING_NOT_FOUND" });
    const result = await db.query(
      `INSERT INTO student_enrollments(offering_id,student_id)
       SELECT o.id,s.user_id FROM course_offerings o JOIN students s ON s.user_id=$2 JOIN users u ON u.id=s.user_id
       WHERE o.id=$1 AND o.organization_id=$3 AND u.organization_id=$3
       ON CONFLICT DO NOTHING RETURNING *`, [req.body.offeringId, req.body.studentId, req.user.organization_id]
    );
    res.status(result.rowCount ? 201 : 200).json({ enrolled: true, alreadyEnrolled: !result.rowCount });
  }));

  app.get("/api/admin/timetable", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query(
      `SELECT t.*,su.name AS subject,u.full_name AS teacher,b.name AS branch,sc.name AS section
       FROM timetable_entries t JOIN course_offerings o ON o.id=t.offering_id JOIN subjects su ON su.id=o.subject_id
       JOIN users u ON u.id=o.teacher_id JOIN sections sc ON sc.id=o.section_id JOIN branches b ON b.id=sc.branch_id
       WHERE o.organization_id=$1 ORDER BY t.day_of_week,t.starts_at`, [req.user.organization_id]
    );
    res.json(result.rows);
  }));

  app.post("/api/admin/timetable", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const missing = required(req.body, ["offeringId", "dayOfWeek", "startsAt", "endsAt", "room", "validFrom", "validUntil"]);
    if (missing.length) return res.status(400).json({ error: "MISSING_FIELDS", fields: missing });
    const entry = { ...req.body, room: cleanRoom(req.body.room), dayOfWeek: Number(req.body.dayOfWeek) };
    const validationError = validateTimetableInput(entry);
    if (validationError) return res.status(400).json({ error: validationError });
    const result = await db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`timetable:${req.user.organization_id}:${entry.dayOfWeek}`]);
      const offering = await client.query("SELECT id FROM course_offerings WHERE id=$1 AND organization_id=$2 AND active=true", [entry.offeringId, req.user.organization_id]);
      if (!offering.rowCount) throw Object.assign(new Error("Course offering not found"), { status: 404, code: "OFFERING_NOT_FOUND" });
      const conflict = await timetableConflict(client, { organizationId: req.user.organization_id, ...entry });
      if (conflict) throw Object.assign(new Error(`Conflicts with ${conflict.subject} (${conflict.conflict_type})`), { status: 409, code: "TIMETABLE_CONFLICT", conflict });
      return client.query(
        `INSERT INTO timetable_entries(offering_id,day_of_week,starts_at,ends_at,room,valid_from,valid_until)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [entry.offeringId, entry.dayOfWeek, entry.startsAt, entry.endsAt, entry.room, entry.validFrom, entry.validUntil]
      );
    });
    res.status(201).json(result.rows[0]);
  }));

  app.patch("/api/admin/timetable/:id", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.transaction(async (client) => {
      const found = await client.query(
        `SELECT t.*,o.organization_id FROM timetable_entries t JOIN course_offerings o ON o.id=t.offering_id
         WHERE t.id=$1 AND o.organization_id=$2 FOR UPDATE OF t`, [req.params.id, req.user.organization_id]
      );
      if (!found.rowCount) throw Object.assign(new Error("Timetable entry not found"), { status: 404, code: "TIMETABLE_ENTRY_NOT_FOUND" });
      const current = found.rows[0];
      const entry = {
        offeringId: current.offering_id,
        dayOfWeek: Number(req.body.dayOfWeek ?? current.day_of_week),
        startsAt: req.body.startsAt ?? String(current.starts_at),
        endsAt: req.body.endsAt ?? String(current.ends_at),
        room: cleanRoom(req.body.room ?? current.room),
        validFrom: req.body.validFrom ?? String(current.valid_from).slice(0, 10),
        validUntil: req.body.validUntil ?? String(current.valid_until).slice(0, 10)
      };
      const validationError = validateTimetableInput(entry);
      if (validationError) throw Object.assign(new Error("Invalid timetable entry"), { status: 400, code: validationError });
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`timetable:${req.user.organization_id}:${entry.dayOfWeek}`]);
      const conflict = await timetableConflict(client, { organizationId: req.user.organization_id, ...entry, excludeId: req.params.id });
      if (conflict) throw Object.assign(new Error(`Conflicts with ${conflict.subject} (${conflict.conflict_type})`), { status: 409, code: "TIMETABLE_CONFLICT", conflict });
      return client.query(
        "UPDATE timetable_entries SET day_of_week=$1,starts_at=$2,ends_at=$3,room=$4,valid_from=$5,valid_until=$6 WHERE id=$7 RETURNING *",
        [entry.dayOfWeek, entry.startsAt, entry.endsAt, entry.room, entry.validFrom, entry.validUntil, req.params.id]
      );
    });
    res.json(result.rows[0]);
  }));

  app.delete("/api/admin/timetable/:id", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query(
      "DELETE FROM timetable_entries t USING course_offerings o WHERE t.id=$1 AND o.id=t.offering_id AND o.organization_id=$2 RETURNING t.id",
      [req.params.id, req.user.organization_id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "TIMETABLE_ENTRY_NOT_FOUND" });
    res.status(204).end();
  }));

  const sessionDetails = async (sessionId, withRoster = false) => {
    const result = await db.query(
      `SELECT a.id,a.teacher_id,a.starts_at,a.ends_at,a.status,a.room,o.id AS offering_id,o.organization_id,su.name AS subject,su.code AS subject_code,
       b.name AS branch,sc.name AS section,u.full_name AS teacher
       FROM attendance_sessions a JOIN course_offerings o ON o.id=a.offering_id JOIN subjects su ON su.id=o.subject_id
       JOIN sections sc ON sc.id=o.section_id JOIN branches b ON b.id=sc.branch_id JOIN users u ON u.id=a.teacher_id
       WHERE a.id=$1`, [sessionId]
    );
    if (!result.rowCount) return null;
    const session = result.rows[0];
    if (!withRoster) return session;
    const roster = await db.query(
      `SELECT u.id,u.full_name,s.roll_number,s.profile_photo_url,COALESCE(ar.status,'absent') AS status,ar.method,ar.marked_at,ar.reason
       FROM student_enrollments e JOIN students s ON s.user_id=e.student_id JOIN users u ON u.id=s.user_id
       LEFT JOIN attendance_records ar ON ar.student_id=e.student_id AND ar.session_id=$1
       WHERE e.offering_id=$2 ORDER BY s.roll_number`, [sessionId, session.offering_id]
    );
    return { ...session, roster: roster.rows };
  };

  app.get("/api/teacher/classes", authenticate, roles("teacher"), asyncRoute(async (req, res) => {
    const result = await db.query(
      `SELECT o.id,su.name AS subject,su.code,b.name AS branch,sc.name AS section,se.number AS semester,o.default_room,org.attendance_threshold,
       COALESCE(json_agg(json_build_object('dayOfWeek',t.day_of_week,'startsAt',t.starts_at,'endsAt',t.ends_at,'room',t.room)) FILTER (WHERE t.id IS NOT NULL),'[]') AS timetable
       FROM course_offerings o JOIN subjects su ON su.id=o.subject_id JOIN sections sc ON sc.id=o.section_id
       JOIN branches b ON b.id=sc.branch_id JOIN semesters se ON se.id=o.semester_id JOIN organizations org ON org.id=o.organization_id
       LEFT JOIN timetable_entries t ON t.offering_id=o.id
       WHERE o.teacher_id=$1 AND o.active=true GROUP BY o.id,su.name,su.code,b.name,sc.name,se.number,org.attendance_threshold ORDER BY su.name`, [req.user.id]
    );
    res.json(result.rows);
  }));

  app.post("/api/attendance/sessions", authenticate, roles("teacher"), asyncRoute(async (req, res) => {
    const durationSeconds = Math.max(30, Math.min(600, Number(req.body.durationSeconds) || 180));
    const offering = await db.query("SELECT * FROM course_offerings WHERE id=$1 AND teacher_id=$2 AND organization_id=$3 AND active=true", [req.body.offeringId, req.user.id, req.user.organization_id]);
    if (!offering.rowCount) return res.status(403).json({ error: "CLASS_NOT_ASSIGNED" });
    const room = cleanRoom(req.body.room || offering.rows[0].default_room);
    if (!room) return res.status(400).json({ error: "ROOM_REQUIRED" });
    if (enforceTimetable) {
      const scheduled = await db.query(
        `SELECT t.id FROM timetable_entries t JOIN course_offerings o ON o.id=t.offering_id JOIN organizations org ON org.id=o.organization_id
         WHERE t.offering_id=$1 AND o.organization_id=$2 AND t.day_of_week=extract(isodow FROM now() AT TIME ZONE org.timezone)
           AND (now() AT TIME ZONE org.timezone)::date BETWEEN t.valid_from AND t.valid_until
           AND (now() AT TIME ZONE org.timezone)::time BETWEEN t.starts_at-($3::int*interval '1 minute') AND t.ends_at+($3::int*interval '1 minute')
           AND lower(trim(t.room))=lower(trim($4)) LIMIT 1`,
        [req.body.offeringId, req.user.organization_id, timetableGraceMinutes, room]
      );
      if (!scheduled.rowCount) return res.status(409).json({ error: "OUTSIDE_TIMETABLE", message: `No scheduled class is active in room ${room}` });
    }
    const beaconToken = crypto.randomBytes(8).toString("hex");
    const result = await db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`teacher:${req.user.id}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`room:${req.user.organization_id}:${room.toLowerCase()}`]);
      const existing = await client.query("SELECT id FROM attendance_sessions WHERE teacher_id=$1 AND status='active' AND ends_at>now()", [req.user.id]);
      if (existing.rowCount) throw Object.assign(new Error("This teacher already has an active session"), { status: 409, code: "SESSION_ALREADY_ACTIVE", sessionId: existing.rows[0].id });
      const roomInUse = await client.query(
        `SELECT a.id FROM attendance_sessions a JOIN course_offerings o ON o.id=a.offering_id
         WHERE o.organization_id=$1 AND a.status='active' AND a.ends_at>now() AND lower(trim(a.room))=lower(trim($2)) LIMIT 1`,
        [req.user.organization_id, room]
      );
      if (roomInUse.rowCount) throw Object.assign(new Error(`Room ${room} already has an active attendance session`), { status: 409, code: "ROOM_ALREADY_ACTIVE", sessionId: roomInUse.rows[0].id });
      const created = await client.query(
        `INSERT INTO attendance_sessions(offering_id,teacher_id,room,beacon_token_hash,ends_at)
         VALUES($1,$2,$3,$4,now()+($5 || ' seconds')::interval) RETURNING id`,
        [req.body.offeringId, req.user.id, room, sha256(beaconToken), durationSeconds]
      );
      await audit(client, req, "ATTENDANCE_SESSION_STARTED", "attendance_session", created.rows[0].id, null, { offeringId: req.body.offeringId, room, durationSeconds });
      return created;
    });
    const session = await sessionDetails(result.rows[0].id, true);
    res.status(201).json({ ...session, beaconToken });
  }));

  app.get("/api/attendance/beacons/:token", authenticate, roles("student"), asyncRoute(async (req, res) => {
    const result = await db.query(
      `SELECT a.id FROM attendance_sessions a JOIN student_enrollments e ON e.offering_id=a.offering_id
       WHERE a.beacon_token_hash=$1 AND a.status='active' AND a.ends_at>now() AND e.student_id=$2`,
      [sha256(req.params.token), req.user.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "NO_ELIGIBLE_ACTIVE_SESSION" });
    res.json(await sessionDetails(result.rows[0].id));
  }));

  app.get("/api/attendance/sessions/:id", authenticate, roles("teacher", "student", "admin"), asyncRoute(async (req, res) => {
    const session = await sessionDetails(req.params.id, req.user.role !== "student");
    if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    if (session.organization_id !== req.user.organization_id) return res.status(403).json({ error: "FORBIDDEN" });
    if (req.user.role === "teacher" && session.teacher_id !== req.user.id) return res.status(403).json({ error: "FORBIDDEN" });
    if (req.user.role === "student") {
      const enrolled = await db.query("SELECT 1 FROM student_enrollments WHERE offering_id=$1 AND student_id=$2", [session.offering_id, req.user.id]);
      if (!enrolled.rowCount) return res.status(403).json({ error: "NOT_ON_ROSTER" });
    }
    res.json(session);
  }));

  app.post("/api/attendance/sessions/:id/mark", authenticate, roles("student"), asyncRoute(async (req, res) => {
    const webBluetooth = req.authClaims.clientType === "web_ble";
    if (req.authClaims.clientType !== "mobile" && !webBluetooth) return res.status(403).json({ error: "BLUETOOTH_CLIENT_REQUIRED", message: "Attendance requires the registered Android app or a supported Web Bluetooth browser." });
    const installationId = String(req.body.installationId || "");
    if (!installationId || req.authClaims.installationId !== installationId) return res.status(403).json({ error: "DEVICE_TOKEN_MISMATCH" });
    const samples = Array.isArray(req.body.rssiSamples) ? req.body.rssiSamples.map(Number) : [];
    if (!webBluetooth && (samples.length < 3 || samples.length > 20 || samples.some((value) => !Number.isInteger(value) || value < -127 || value > -10))) {
      return res.status(422).json({ error: "INVALID_SIGNAL_SAMPLES", message: "At least three valid Bluetooth signal samples are required" });
    }
    const signal = webBluetooth ? null : median(samples);
    if (!webBluetooth && signal < minimumRssi) return res.status(422).json({ error: "WEAK_OR_MISSING_SIGNAL", medianRssi: signal });
    const beaconToken = String(req.body.beaconToken || "").trim().toLowerCase();
    if (webBluetooth && !/^[a-f0-9]{16}$/.test(beaconToken)) return res.status(422).json({ error: "INVALID_BLUETOOTH_PROOF" });
    const result = await db.transaction(async (client) => {
      const sessionResult = await client.query("SELECT * FROM attendance_sessions WHERE id=$1 FOR UPDATE", [req.params.id]);
      const session = sessionResult.rows[0];
      if (!session || session.status !== "active" || new Date(session.ends_at).getTime() <= Date.now()) throw Object.assign(new Error("Attendance window is closed"), { status: 410, code: "SESSION_CLOSED" });
      if (webBluetooth && session.beacon_token_hash !== sha256(beaconToken)) throw Object.assign(new Error("The Bluetooth proof does not belong to this attendance session"), { status: 403, code: "BLUETOOTH_PROOF_MISMATCH" });
      const enrolled = await client.query("SELECT 1 FROM student_enrollments WHERE offering_id=$1 AND student_id=$2", [session.offering_id, req.user.id]);
      if (!enrolled.rowCount) throw Object.assign(new Error("You are not enrolled in this class"), { status: 403, code: "NOT_ON_ROSTER" });
      const device = await client.query("SELECT 1 FROM student_devices WHERE student_id=$1 AND installation_id=$2 AND status='active'", [req.user.id, installationId]);
      if (!device.rowCount) throw Object.assign(new Error("This is not your registered phone"), { status: 403, code: "DEVICE_MISMATCH" });
      const barcode = await client.query("SELECT barcode_hash FROM barcode_registrations WHERE student_id=$1 AND status='active'", [req.user.id]);
      if (!barcode.rowCount || barcode.rows[0].barcode_hash !== keyedHash(barcodePepper, `${req.user.organization_id}:${req.body.barcode || ""}`)) throw Object.assign(new Error("ID-card barcode does not match your account"), { status: 403, code: "BARCODE_MISMATCH" });
      const overlap = await client.query(
        `SELECT ar.id FROM attendance_records ar JOIN attendance_sessions other ON other.id=ar.session_id
         WHERE ar.student_id=$1 AND ar.status='present' AND other.id<>$2 AND other.starts_at<$3 AND other.ends_at>$4 LIMIT 1`,
        [req.user.id, session.id, session.ends_at, session.starts_at]
      );
      if (overlap.rowCount) throw Object.assign(new Error("You are already present in an overlapping class"), { status: 409, code: "OVERLAPPING_ATTENDANCE" });
      const inserted = await client.query(
        `INSERT INTO attendance_records(session_id,student_id,status,method,median_rssi,marked_by)
         VALUES($1,$2,'present',$4,$3,$2)
         ON CONFLICT(session_id,student_id) DO UPDATE SET status='present',method=EXCLUDED.method,median_rssi=EXCLUDED.median_rssi,marked_by=EXCLUDED.marked_by,marked_at=now(),reason=NULL
         RETURNING *`, [session.id, req.user.id, signal, webBluetooth ? "barcode_web_ble" : "barcode_ble"]
      );
      await audit(client, req, "ATTENDANCE_SELF_MARKED", "attendance_record", inserted.rows[0].id, null, { sessionId: session.id, method: webBluetooth ? "barcode_web_ble" : "barcode_ble", medianRssi: signal });
      return inserted.rows[0];
    });
    res.status(201).json({ attendance: result });
  }));

  app.post("/api/attendance/sessions/:id/manual", authenticate, roles("teacher"), asyncRoute(async (req, res) => {
    if (!String(req.body.reason || "").trim()) return res.status(400).json({ error: "REASON_REQUIRED" });
    const result = await db.transaction(async (client) => {
      const allowed = await client.query(
        `SELECT a.id FROM attendance_sessions a JOIN student_enrollments e ON e.offering_id=a.offering_id
         WHERE a.id=$1 AND a.teacher_id=$2 AND e.student_id=$3`, [req.params.id, req.user.id, req.body.studentId]
      );
      if (!allowed.rowCount) throw Object.assign(new Error("Student or session not found"), { status: 404, code: "NOT_FOUND" });
      const before = await client.query("SELECT * FROM attendance_records WHERE session_id=$1 AND student_id=$2", [req.params.id, req.body.studentId]);
      const inserted = await client.query(
        `INSERT INTO attendance_records(session_id,student_id,status,method,marked_by,reason)
         VALUES($1,$2,$3,'manual',$4,$5)
         ON CONFLICT(session_id,student_id) DO UPDATE SET status=EXCLUDED.status,method='manual',marked_by=EXCLUDED.marked_by,reason=EXCLUDED.reason,marked_at=now()
         RETURNING *`, [req.params.id, req.body.studentId, req.body.status === "absent" ? "absent" : "present", req.user.id, String(req.body.reason).trim()]
      );
      await audit(client, req, "ATTENDANCE_MANUAL_OVERRIDE", "attendance_record", inserted.rows[0].id, before.rows[0] || null, inserted.rows[0]);
      return inserted.rows[0];
    });
    res.json({ attendance: result });
  }));

  app.post("/api/attendance/sessions/:id/close", authenticate, roles("teacher"), asyncRoute(async (req, res) => {
    await db.transaction(async (client) => {
      const before = await client.query("SELECT id,status,ends_at,room FROM attendance_sessions WHERE id=$1 AND teacher_id=$2 FOR UPDATE", [req.params.id, req.user.id]);
      if (!before.rowCount) throw Object.assign(new Error("Session not found"), { status: 404, code: "SESSION_NOT_FOUND" });
      const result = await client.query("UPDATE attendance_sessions SET status='closed',ends_at=LEAST(ends_at,now()) WHERE id=$1 RETURNING id,status,ends_at,room", [req.params.id]);
      await audit(client, req, "ATTENDANCE_SESSION_CLOSED", "attendance_session", req.params.id, before.rows[0], result.rows[0]);
    });
    res.json(await sessionDetails(req.params.id, true));
  }));

  app.get("/api/student/dashboard", authenticate, roles("student"), asyncRoute(async (req, res) => {
    const result = await db.query(
      `SELECT o.id AS offering_id,su.name AS subject,su.code AS subject_code,u.full_name AS teacher,
       count(DISTINCT a.id) FILTER(WHERE a.status<>'cancelled' AND (a.status='closed' OR a.ends_at<=now()))::int AS conducted,
       count(DISTINCT ar.session_id) FILTER(WHERE ar.status='present' AND a.status<>'cancelled')::int AS attended
       FROM student_enrollments e JOIN course_offerings o ON o.id=e.offering_id JOIN subjects su ON su.id=o.subject_id JOIN users u ON u.id=o.teacher_id
       LEFT JOIN attendance_sessions a ON a.offering_id=o.id LEFT JOIN attendance_records ar ON ar.session_id=a.id AND ar.student_id=e.student_id
       WHERE e.student_id=$1 GROUP BY o.id,su.name,su.code,u.full_name ORDER BY su.name`, [req.user.id]
    );
    const organization = await db.query("SELECT attendance_threshold FROM organizations WHERE id=$1", [req.user.organization_id]);
    const profile = await db.query(
      `SELECT s.roll_number,b.name AS branch,se.number AS semester,sc.name AS section,sd.device_name,sd.last_seen_at
       FROM students s JOIN branches b ON b.id=s.branch_id JOIN semesters se ON se.id=s.semester_id JOIN sections sc ON sc.id=s.section_id
       LEFT JOIN student_devices sd ON sd.student_id=s.user_id AND sd.status='active' WHERE s.user_id=$1`, [req.user.id]
    );
    const threshold = Number(organization.rows[0].attendance_threshold);
    const subjects = result.rows.map((row) => {
      const percentage = row.conducted ? Math.round((row.attended / row.conducted) * 1000) / 10 : 0;
      return { ...row, percentage, belowThreshold: row.conducted > 0 && percentage < threshold };
    });
    const conducted = subjects.reduce((sum, row) => sum + row.conducted, 0);
    const attended = subjects.reduce((sum, row) => sum + row.attended, 0);
    res.json({ threshold, overallPercentage: conducted ? Math.round((attended / conducted) * 1000) / 10 : 0, attended, conducted, student: profile.rows[0], subjects });
  }));

  app.get("/api/student/history", authenticate, roles("student"), asyncRoute(async (req, res) => {
    const limit = Math.max(1, Math.min(250, Number(req.query.limit) || 100));
    const result = await db.query(
      `SELECT a.id,a.starts_at,a.ends_at,a.room,su.name AS subject,su.code AS subject_code,u.full_name AS teacher,
       COALESCE(ar.status,'absent') AS status,ar.method,ar.marked_at
       FROM student_enrollments e JOIN course_offerings o ON o.id=e.offering_id JOIN attendance_sessions a ON a.offering_id=o.id
       JOIN subjects su ON su.id=o.subject_id JOIN users u ON u.id=o.teacher_id
       LEFT JOIN attendance_records ar ON ar.session_id=a.id AND ar.student_id=e.student_id
       WHERE e.student_id=$1 AND a.status<>'cancelled' AND (a.status='closed' OR a.ends_at<=now())
       ORDER BY a.starts_at DESC LIMIT $2`, [req.user.id, limit]
    );
    res.json(result.rows);
  }));

  const reportData = async (offeringId, organizationId, teacherId = null) => {
    const offeringResult = await db.query(
      `SELECT o.id,su.name AS subject_name,su.code AS subject_code,b.name AS branch_name,sc.name AS section_name,org.attendance_threshold
       FROM course_offerings o JOIN subjects su ON su.id=o.subject_id JOIN sections sc ON sc.id=o.section_id JOIN branches b ON b.id=sc.branch_id
       JOIN organizations org ON org.id=o.organization_id WHERE o.id=$1 AND o.organization_id=$2 AND ($3::uuid IS NULL OR o.teacher_id=$3)`,
      [offeringId, organizationId, teacherId]
    );
    if (!offeringResult.rowCount) return null;
    const offering = offeringResult.rows[0];
    const rowsResult = await db.query(
      `SELECT u.full_name,s.roll_number,
       count(DISTINCT a.id) FILTER(WHERE a.status<>'cancelled' AND (a.status='closed' OR a.ends_at<=now()))::int AS conducted,
       count(DISTINCT ar.session_id) FILTER(WHERE ar.status='present' AND a.status<>'cancelled')::int AS attended
       FROM student_enrollments e JOIN students s ON s.user_id=e.student_id JOIN users u ON u.id=s.user_id
       LEFT JOIN attendance_sessions a ON a.offering_id=e.offering_id LEFT JOIN attendance_records ar ON ar.session_id=a.id AND ar.student_id=e.student_id
       WHERE e.offering_id=$1 GROUP BY u.full_name,s.roll_number ORDER BY s.roll_number`, [offeringId]
    );
    const threshold = Number(offering.attendance_threshold);
    const rows = rowsResult.rows.map((row) => {
      const percentage = row.conducted ? Math.round((row.attended / row.conducted) * 1000) / 10 : 0;
      return { ...row, percentage, below_threshold: row.conducted > 0 && percentage < threshold };
    });
    return { offering, rows, threshold };
  };

  app.get("/api/reports/offerings/:id", authenticate, roles("teacher", "admin"), asyncRoute(async (req, res) => {
    const data = await reportData(req.params.id, req.user.organization_id, req.user.role === "teacher" ? req.user.id : null);
    if (!data) return res.status(404).json({ error: "OFFERING_NOT_FOUND" });
    res.json(data);
  }));

  app.get("/api/reports/offerings/:id.xlsx", authenticate, roles("teacher", "admin"), asyncRoute(async (req, res) => {
    const data = await reportData(req.params.id, req.user.organization_id, req.user.role === "teacher" ? req.user.id : null);
    if (!data) return res.status(404).json({ error: "OFFERING_NOT_FOUND" });
    const buffer = await attendanceWorkbook(data);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${data.offering.subject_code}-attendance.xlsx"`);
    res.send(buffer);
  }));

  app.get("/api/reports/offerings/:id.pdf", authenticate, roles("teacher", "admin"), asyncRoute(async (req, res) => {
    const data = await reportData(req.params.id, req.user.organization_id, req.user.role === "teacher" ? req.user.id : null);
    if (!data) return res.status(404).json({ error: "OFFERING_NOT_FOUND" });
    const buffer = await attendancePdf(data);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${data.offering.subject_code}-attendance.pdf"`);
    res.send(buffer);
  }));

  app.get("/api/admin/audit", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query("SELECT a.*,u.full_name AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.organization_id=$1 ORDER BY a.created_at DESC LIMIT 500", [req.user.organization_id]);
    res.json(result.rows);
  }));

  app.get("/api/admin/backups", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query("SELECT * FROM backup_runs WHERE organization_id=$1 OR organization_id IS NULL ORDER BY started_at DESC LIMIT 100", [req.user.organization_id]);
    res.json(result.rows);
  }));

  app.use("/api", (_req, res) => res.status(404).json({ error: "API_ROUTE_NOT_FOUND" }));

  const webRoot = fileURLToPath(new URL("../../public", import.meta.url));
  const demoRoot = fileURLToPath(new URL("../../public/demo", import.meta.url));
  app.use("/demo", express.static(demoRoot, { index: "index.html", maxAge: "1h" }));
  app.use(express.static(webRoot, { index: "index.html", maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
  app.get("*", (_req, res) => res.sendFile(`${webRoot}/index.html`));

  app.use((error, req, res, _next) => {
    const databaseStatus = error.code === "23505" ? 409 : ["23503", "23514", "22P02"].includes(error.code) ? 400 : 500;
    const status = Number(error.status || databaseStatus);
    if (status >= 500) console.error(`[${req.requestId}]`, error);
    const applicationError = Boolean(error.status && error.code);
    const publicCode = applicationError ? error.code : status === 409 ? "DATA_CONFLICT" : status === 400 ? "INVALID_DATA" : "INTERNAL_ERROR";
    const publicMessage = status >= 500 ? "Something went wrong" : applicationError ? error.message : status === 409 ? "A record with these details already exists" : "The submitted data is invalid";
    res.status(status).json({ error: publicCode, message: publicMessage, requestId: req.requestId });
  });

  return app;
}
