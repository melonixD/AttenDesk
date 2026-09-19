import crypto from "node:crypto";
import express from "express";
import { fileURLToPath } from "node:url";
import { attendancePdf, attendanceWorkbook } from "./reports.js";
import { createMailer } from "./mailer.js";
import { ROTATION_SECONDS, acceptableRotatingCodes, createRateLimiter, hashPassword, ipDigest, issueAccessToken, keyedHash, numericOtp, otpHash, passwordProblem, randomToken, rotatingCode, secondsUntilRotation, securityHeaders, sha256, verifyAccessToken, verifyPassword } from "./security.js";

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const cleanEmail = (value) => String(value || "").trim().toLowerCase();
const cleanRoom = (value) => String(value || "").trim().replace(/\s+/g, " ");
const required = (body, fields) => fields.filter((field) => !String(body[field] ?? "").trim());
const cleanUsername = (value) => String(value || "").trim().toLowerCase();
const cleanRoll = (value) => String(value || "").trim().toUpperCase();
const normaliseName = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z]+/g, " ").trim();
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
  // HBTU pilot: teachers may start unscheduled sessions, so timetable
  // enforcement is opt-in rather than automatic in production.
  const enforceTimetable = process.env.ENFORCE_TIMETABLE === "true";
  const requireRegisteredClassroom = process.env.REQUIRE_REGISTERED_CLASSROOM === "true";
  const configuredGraceMinutes = Number(process.env.TIMETABLE_GRACE_MINUTES);
  const timetableGraceMinutes = Math.max(0, Math.min(60, Number.isFinite(configuredGraceMinutes) ? configuredGraceMinutes : 10));
  const configuredMinRssi = Number(process.env.MIN_RSSI);
  const minimumRssi = Number.isFinite(configuredMinRssi) ? Math.max(-127, Math.min(-10, configuredMinRssi)) : -92;
  const studentPasswordRequired = process.env.STUDENT_REQUIRE_PASSWORD === "true";
  const beaconOfflineSeconds = Math.max(15, Number(process.env.BEACON_OFFLINE_SECONDS) || 45);

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
  app.use("/api/beacon", createRateLimiter({ max: 1200, windowMs: 60_000 }));
  const generalApiLimiter = createRateLimiter({ max: 180, windowMs: 60_000 });
  app.use("/api", (req, res, next) => (req.path.startsWith("/beacon/") ? next() : generalApiLimiter(req, res, next)));

  const authenticate = asyncRoute(async (req, res, next) => {
    const raw = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const claims = verifyAccessToken(authSecret, raw);
    if (!claims || !['admin', 'teacher', 'student'].includes(claims.role)) return res.status(401).json({ error: "UNAUTHORISED" });
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
  const consumeOtp = async ({ organizationId, email, purpose, code }) => {
    const result = await db.transaction(async (client) => {
    const found = await client.query(
      "SELECT * FROM otp_challenges WHERE organization_id=$1 AND lower(email)=lower($2) AND purpose=$3 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [organizationId, email, purpose]
    );
    const challenge = found.rows[0];
    if (!challenge || new Date(challenge.expires_at).getTime() <= Date.now()) throw Object.assign(new Error("OTP expired or missing"), { status: 400, code: "OTP_EXPIRED" });
    if (challenge.attempts >= 5) throw Object.assign(new Error("Too many incorrect attempts"), { status: 429, code: "OTP_LOCKED" });
    if (otpHash(otpSecret, organizationId, email, code) !== challenge.code_hash) {
      await client.query("UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1", [challenge.id]);
      return false;
    }
    await client.query("UPDATE otp_challenges SET consumed_at=now() WHERE id=$1", [challenge.id]);
    return true;
    });
    if (!result) throw Object.assign(new Error('Incorrect OTP'), { status: 400, code: 'OTP_INCORRECT' });
  };
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

  /* -------------------------------------------------------------------------
   * Credential login.
   *
   * Admins and teachers sign in with a username (or college email) plus a
   * password. Students sign in with their full name plus roll number, as
   * specified for the HBTU pilot. See docs/AUTH.md for why the student mode is
   * the weakest link in the system and what to do about it.
   * ---------------------------------------------------------------------- */
  const issueSession = async ({ req, res, user, requestedClientType, installationId, deviceName, platform }) => {
    const clientType = user.role === "student"
      ? (requestedClientType === "web_ble" ? "web_ble" : requestedClientType === "mobile" ? "mobile" : "web")
      : (requestedClientType === "mobile" ? "mobile" : "web");
    const deviceBoundClient = user.role === "student" && (clientType === "mobile" || clientType === "web_ble");
    if (deviceBoundClient) {
      if (!installationId) return res.status(400).json({ error: "INSTALLATION_ID_REQUIRED" });
      const active = await db.query("SELECT * FROM student_devices WHERE student_id=$1 AND status='active'", [user.id]);
      if (!active.rowCount) {
        const resolvedPlatform = clientType === "web_ble" ? "web" : platform === "ios" ? "ios" : "android";
        await db.query(
          "INSERT INTO student_devices(student_id,installation_id,device_name,platform,status,approved_at) VALUES($1,$2,$3,$4,'active',now())",
          [user.id, installationId, deviceName || (clientType === "web_ble" ? "Web Bluetooth browser" : "Android phone"), resolvedPlatform]
        );
      } else if (active.rows[0].installation_id !== installationId) {
        const deviceChangeToken = issueAccessToken(authSecret, { sub: user.id, org: user.organization_id, role: "device_change" }, 600);
        return res.status(403).json({ error: "DEVICE_CHANGE_REQUIRED", message: "This account is linked to another phone or browser. Ask an administrator to approve this device.", deviceChangeToken });
      }
      await db.query("UPDATE student_devices SET last_seen_at=now() WHERE student_id=$1 AND installation_id=$2 AND status='active'", [user.id, installationId]);
    }
    const accessToken = issueAccessToken(authSecret, {
      sub: user.id, org: user.organization_id, role: user.role, clientType,
      ...(deviceBoundClient ? { installationId } : {})
    });
    const refreshToken = randomToken(48);
    await db.query(
      "INSERT INTO refresh_tokens(user_id,token_hash,installation_id,client_type,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days')",
      [user.id, sha256(refreshToken), deviceBoundClient ? installationId : null, clientType]
    );
    await db.query("UPDATE users SET last_login_at=now() WHERE id=$1", [user.id]);
    const { password_hash, ...safeUser } = user;
    return res.json({ accessToken, refreshToken, expiresIn: 900, user: safeUser });
  };

  app.post("/api/auth/login", asyncRoute(async (req, res) => {
    const identifier = String(req.body.identifier || req.body.username || req.body.email || "").trim();
    const password = String(req.body.password || "");
    if (!identifier || !password) return res.status(400).json({ error: "MISSING_CREDENTIALS", message: "Enter your username and password" });
    const byEmail = identifier.includes("@");
    const organization = byEmail
      ? await organizationForEmail(cleanEmail(identifier))
      : process.env.COLLEGE_EMAIL_DOMAIN
        ? await organizationForEmail(`login@${process.env.COLLEGE_EMAIL_DOMAIN}`)
        : (await db.query("SELECT * FROM organizations ORDER BY created_at LIMIT 1")).rows[0];
    if (!organization) return res.status(403).json({ error: "UNKNOWN_COLLEGE", message: "This college is not configured yet" });
    const found = await db.query(
      `SELECT id,organization_id,email,username,full_name,role,status,password_hash FROM users
       WHERE organization_id=$1
         AND (lower(email)=lower($2) OR lower(username)=lower($2) OR lower(trim(full_name))=lower(trim($2)))
       ORDER BY (lower(username)=lower($2)) DESC LIMIT 1`,
      [organization.id, identifier]
    );
    const user = found.rows[0];
    // Always spend the same work whether or not the account exists.
    const ok = verifyPassword(password, user?.password_hash || "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
    if (!user || !ok) return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Username or password is incorrect" });
    if (user.role === "student") return res.status(403).json({ error: "USE_STUDENT_LOGIN", message: "Students sign in with their name and roll number" });
    if (user.status !== "active") return res.status(403).json({ error: "ACCOUNT_NOT_ACTIVE", message: "This account is not active yet" });
    return issueSession({ req, res, user, requestedClientType: req.body.clientType, installationId: String(req.body.installationId || "").trim(), deviceName: req.body.deviceName, platform: req.body.platform });
  }));

  app.post("/api/auth/student-login", asyncRoute(async (req, res) => {
    const fullName = String(req.body.fullName || "").trim();
    const rollNumber = cleanRoll(req.body.rollNumber);
    if (!fullName || !rollNumber) return res.status(400).json({ error: "MISSING_CREDENTIALS", message: "Enter your full name and roll number" });
    const found = await db.query(
      `SELECT u.id,u.organization_id,u.email,u.username,u.full_name,u.role,u.status,u.password_hash
       FROM students s JOIN users u ON u.id=s.user_id
       WHERE upper(trim(s.roll_number))=$1 AND u.role='student'`,
      [rollNumber]
    );
    const user = found.rows[0];
    if (!user || normaliseName(user.full_name) !== normaliseName(fullName)) {
      return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Name and roll number do not match a registered student" });
    }
    if (user.status !== "active") return res.status(403).json({ error: "ACCOUNT_NOT_ACTIVE", message: "Your account is waiting for administrator approval" });
    if (studentPasswordRequired || user.password_hash) {
      if (!verifyPassword(String(req.body.password || ""), user.password_hash)) {
        return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Incorrect password" });
      }
    }
    return issueSession({ req, res, user, requestedClientType: req.body.clientType || "web_ble", installationId: String(req.body.installationId || "").trim(), deviceName: req.body.deviceName, platform: req.body.platform });
  }));

  app.post("/api/auth/set-password", authenticate, asyncRoute(async (req, res) => {
    const problem = passwordProblem(req.body.newPassword);
    if (problem) return res.status(400).json({ error: "WEAK_PASSWORD", message: problem });
    const current = await db.query("SELECT password_hash FROM users WHERE id=$1", [req.user.id]);
    if (current.rows[0]?.password_hash && !verifyPassword(String(req.body.currentPassword || ""), current.rows[0].password_hash)) {
      return res.status(403).json({ error: "CURRENT_PASSWORD_INCORRECT", message: "Your current password is incorrect" });
    }
    await db.query("UPDATE users SET password_hash=$1, password_set_at=now(), updated_at=now() WHERE id=$2", [hashPassword(req.body.newPassword), req.user.id]);
    await db.query("UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [req.user.id]);
    res.json({ message: "Password updated. Sign in again on your other devices." });
  }));

  app.post("/api/auth/device-change-request", asyncRoute(async (req, res) => {
    const changeClaims = verifyAccessToken(authSecret, String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!changeClaims || changeClaims.role !== "device_change") return res.status(401).json({ error: "DEVICE_CHANGE_VERIFICATION_REQUIRED" });
    const user = await db.query("SELECT id FROM users WHERE organization_id=$1 AND id=$2 AND role='student' AND status='active'", [changeClaims.org, changeClaims.sub]);
    if (!user.rowCount) return res.status(404).json({ error: "STUDENT_NOT_FOUND" });
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
    // Resolve the registered classroom and its enabled ESP32 beacon, if any.
    const classroom = await db.query(
      "SELECT id, room_number, min_rssi FROM classrooms WHERE organization_id=$1 AND lower(trim(room_number))=lower(trim($2)) AND active=true",
      [req.user.organization_id, room]
    );
    const classroomId = classroom.rows[0]?.id || null;
    if (requireRegisteredClassroom && !classroomId) {
      return res.status(400).json({ error: "CLASSROOM_NOT_REGISTERED", message: `Room ${room} is not in the classroom registry. Ask an administrator to add it.` });
    }
    const beaconRow = classroomId
      ? await db.query("SELECT id, beacon_code, label, last_seen_at, status FROM beacons WHERE classroom_id=$1 AND enabled=true LIMIT 1", [classroomId])
      : { rows: [] };
    const beaconId = beaconRow.rows[0]?.id || null;
    if (process.env.REQUIRE_ESP32 !== 'false') {
      if (!beaconId) return res.status(409).json({ error: 'ESP32_REQUIRED', message: 'Register and assign an ESP32 beacon to this classroom first.' });
      const seen = beaconRow.rows[0].last_seen_at;
      if (!seen || Date.now() - new Date(seen).getTime() >= beaconOfflineSeconds * 1000) return res.status(409).json({ error: 'BEACON_OFFLINE', message: 'The classroom ESP32 is offline. Check its power, Wi-Fi, API address and device key.' });
    }
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
        `INSERT INTO attendance_sessions(offering_id,teacher_id,room,beacon_token_hash,ends_at,classroom_id,beacon_id,organization_id)
         VALUES($1,$2,$3,$4,now()+($5 || ' seconds')::interval,$6,$7,$8) RETURNING id`,
        [req.body.offeringId, req.user.id, room, sha256(beaconToken), durationSeconds, classroomId, beaconId, req.user.organization_id]
      );
      await audit(client, req, "ATTENDANCE_SESSION_STARTED", "attendance_session", created.rows[0].id, null, { offeringId: req.body.offeringId, room, durationSeconds });
      return created;
    });
    const session = await sessionDetails(result.rows[0].id, true);
    const beacon = beaconRow.rows[0] || null;
    const beaconOnline = Boolean(beacon?.last_seen_at && Date.now() - new Date(beacon.last_seen_at).getTime() < beaconOfflineSeconds * 1000);
    res.status(201).json({
      ...session,
      beaconToken,
      rotationSeconds: ROTATION_SECONDS,
      beacon: beacon ? { id: beacon.id, code: beacon.beacon_code, label: beacon.label, online: beaconOnline } : null,
      beaconWarning: beacon
        ? (beaconOnline ? null : `The ${beacon.label} beacon has not reported in recently. Students may not be able to detect this room.`)
        : `Room ${room} has no ESP32 beacon registered. Students can only mark attendance if a teacher phone beacon is broadcasting.`
    });
  }));

  /* -------------------------------------------------------------------------
   * Resolve a code observed over Bluetooth into a session the student may join.
   *
   * Two proofs are accepted:
   *   rotating_beacon - the code an ESP32 is advertising right now. It changes
   *                     every ROTATION_SECONDS, so a code forwarded off campus
   *                     stops working almost immediately.
   *   session_token   - the long-lived token a legacy Android teacher-phone
   *                     beacon advertises. Kept for backwards compatibility.
   * Either way the lookup is filtered by enrollment, so a code that leaks
   * through a wall from the class next door resolves to nothing.
   * ---------------------------------------------------------------------- */
  const resolveBeaconCode = async (rawCode, studentId) => {
    const code = String(rawCode || "").trim().toLowerCase();
    if (!/^[a-f0-9]{16}$/.test(code)) return null;
    const rotating = await db.query(
      `SELECT a.id FROM attendance_sessions a JOIN student_enrollments e ON e.offering_id=a.offering_id
       WHERE a.status='active' AND a.ends_at>now() AND e.student_id=$1`,
      [studentId]
    );
    for (const row of rotating.rows) {
      if (acceptableRotatingCodes(authSecret, row.id).includes(code)) return { sessionId: row.id, proof: "rotating_beacon" };
    }
    const legacy = await db.query(
      `SELECT a.id FROM attendance_sessions a JOIN student_enrollments e ON e.offering_id=a.offering_id
       WHERE a.beacon_token_hash=$1 AND a.status='active' AND a.ends_at>now() AND e.student_id=$2`,
      [sha256(code), studentId]
    );
    if (legacy.rowCount) return { sessionId: legacy.rows[0].id, proof: "session_token" };
    return null;
  };

  app.get("/api/attendance/beacons/:token", authenticate, roles("student"), asyncRoute(async (req, res) => {
    const match = await resolveBeaconCode(req.params.token, req.user.id);
    if (!match) return res.status(404).json({ error: "NO_ELIGIBLE_ACTIVE_SESSION", message: "That classroom beacon does not match a class you are enrolled in right now." });
    const session = await sessionDetails(match.sessionId);
    res.json({ ...session, proof: match.proof });
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
    // Every client must present a Bluetooth proof. Web clients have no RSSI, so
    // the proof is the only evidence of presence and must be the *rotating*
    // code wherever an ESP32 beacon is serving the room.
    if (!/^[a-f0-9]{16}$/.test(beaconToken)) return res.status(422).json({ error: "INVALID_BLUETOOTH_PROOF", message: "No valid classroom beacon code was captured." });
    const result = await db.transaction(async (client) => {
      const sessionResult = await client.query("SELECT * FROM attendance_sessions WHERE id=$1 FOR UPDATE", [req.params.id]);
      const session = sessionResult.rows[0];
      if (!session || session.status !== "active" || new Date(session.ends_at).getTime() <= Date.now()) throw Object.assign(new Error("Attendance window is closed"), { status: 410, code: "SESSION_CLOSED" });
      const rotatingMatch = acceptableRotatingCodes(authSecret, session.id).includes(beaconToken);
      const legacyMatch = session.beacon_token_hash === sha256(beaconToken);
      if (!rotatingMatch && !legacyMatch) {
        throw Object.assign(new Error("That classroom beacon code is expired or belongs to another class. Move closer and scan again."), { status: 403, code: "BLUETOOTH_PROOF_MISMATCH" });
      }
      // A rotating code proves presence within the last 60 seconds. A static
      // token does not, so when the room has a registered ESP32 we refuse it.
      if (!rotatingMatch && session.beacon_id) {
        throw Object.assign(new Error("This room uses a rotating classroom beacon. Refresh the Bluetooth connection and try again."), { status: 403, code: "STALE_BEACON_PROOF" });
      }
      const proof = rotatingMatch ? "rotating_beacon" : "session_token";
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
        `INSERT INTO attendance_records(session_id,student_id,status,method,median_rssi,marked_by,proof)
         VALUES($1,$2,'present',$4,$3,$2,$5)
         ON CONFLICT(session_id,student_id) DO UPDATE SET status='present',method=EXCLUDED.method,median_rssi=EXCLUDED.median_rssi,marked_by=EXCLUDED.marked_by,proof=EXCLUDED.proof,marked_at=now(),reason=NULL
         RETURNING *`, [session.id, req.user.id, signal, webBluetooth ? "barcode_web_ble" : "barcode_ble", proof]
      );
      await audit(client, req, "ATTENDANCE_SELF_MARKED", "attendance_record", inserted.rows[0].id, null, { sessionId: session.id, method: webBluetooth ? "barcode_web_ble" : "barcode_ble", medianRssi: signal, proof });
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
        `INSERT INTO attendance_records(session_id,student_id,status,method,marked_by,reason,proof)
         VALUES($1,$2,$3,'manual',$4,$5,'manual')
         ON CONFLICT(session_id,student_id) DO UPDATE SET status=EXCLUDED.status,method='manual',marked_by=EXCLUDED.marked_by,reason=EXCLUDED.reason,proof='manual',marked_at=now()
         RETURNING *`, [req.params.id, req.body.studentId, req.body.status === "absent" ? "absent" : "present", req.user.id, String(req.body.reason).trim()]
      );
      await audit(client, req, "ATTENDANCE_MANUAL_OVERRIDE", "attendance_record", inserted.rows[0].id, before.rows[0] || null, inserted.rows[0]);
      return inserted.rows[0];
    });
    res.json({ attendance: result });
  }));

  /**
   * Closing a session writes an explicit 'absent' row for every enrolled
   * student who did not mark. Absence becomes a stored fact rather than
   * something inferred by a later query.
   */
  const finaliseSession = async (client, req, sessionId) => {
    const result = await client.query(
      "UPDATE attendance_sessions SET status='closed',ends_at=LEAST(ends_at,now()),closed_at=now() WHERE id=$1 RETURNING id,status,ends_at,room,offering_id",
      [sessionId]
    );
    const absent = await client.query(
      `INSERT INTO attendance_records(session_id,student_id,status,method,marked_by,reason,proof)
       SELECT $1, e.student_id, 'absent', 'manual', $2, 'Did not mark before the attendance window closed', 'manual'
       FROM student_enrollments e
       WHERE e.offering_id=$3
         AND NOT EXISTS (SELECT 1 FROM attendance_records r WHERE r.session_id=$1 AND r.student_id=e.student_id)
       RETURNING id`,
      [sessionId, req.user.id, result.rows[0].offering_id]
    );
    await client.query("UPDATE attendance_sessions SET absent_written_at=now() WHERE id=$1", [sessionId]);
    return { session: result.rows[0], absentWritten: absent.rowCount };
  };

  app.post("/api/attendance/sessions/:id/close", authenticate, roles("teacher"), asyncRoute(async (req, res) => {
    const outcome = await db.transaction(async (client) => {
      const before = await client.query("SELECT id,status,ends_at,room FROM attendance_sessions WHERE id=$1 AND teacher_id=$2 FOR UPDATE", [req.params.id, req.user.id]);
      if (!before.rowCount) throw Object.assign(new Error("Session not found"), { status: 404, code: "SESSION_NOT_FOUND" });
      if (before.rows[0].status === "closed") return { session: before.rows[0], absentWritten: 0 };
      const done = await finaliseSession(client, req, req.params.id);
      await audit(client, req, "ATTENDANCE_SESSION_CLOSED", "attendance_session", req.params.id, before.rows[0], { ...done.session, absentWritten: done.absentWritten });
      return done;
    });
    res.json({ ...(await sessionDetails(req.params.id, true)), absentWritten: outcome.absentWritten });
  }));

  /** The teacher's live screen polls this. It also auto-closes an expired session. */
  app.get("/api/attendance/sessions/:id/live", authenticate, roles("teacher"), asyncRoute(async (req, res) => {
    const owned = await db.query("SELECT id,status,ends_at,beacon_id FROM attendance_sessions WHERE id=$1 AND teacher_id=$2", [req.params.id, req.user.id]);
    if (!owned.rowCount) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    const row = owned.rows[0];
    if (row.status === "active" && new Date(row.ends_at).getTime() <= Date.now()) {
      await db.transaction(async (client) => {
        await client.query("SELECT id FROM attendance_sessions WHERE id=$1 FOR UPDATE", [req.params.id]);
        const done = await finaliseSession(client, req, req.params.id);
        await audit(client, req, "ATTENDANCE_SESSION_EXPIRED", "attendance_session", req.params.id, row, { absentWritten: done.absentWritten });
      });
    }
    const session = await sessionDetails(req.params.id, true);
    const present = session.roster.filter((student) => student.status === "present").length;
    let beacon = null;
    if (row.beacon_id) {
      const found = await db.query("SELECT beacon_code,label,last_seen_at FROM beacons WHERE id=$1", [row.beacon_id]);
      const seen = found.rows[0]?.last_seen_at;
      beacon = found.rows[0] ? { code: found.rows[0].beacon_code, label: found.rows[0].label, online: Boolean(seen && Date.now() - new Date(seen).getTime() < beaconOfflineSeconds * 1000) } : null;
    }
    res.json({
      ...session,
      present,
      total: session.roster.length,
      secondsRemaining: Math.max(0, Math.round((new Date(session.ends_at).getTime() - Date.now()) / 1000)),
      beacon
    });
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

  /* =========================================================================
   * ESP32 classroom beacons
   *
   * The beacon never learns anything about students, subjects or rooms beyond
   * its own label, and it holds no long-lived attendance secret. It polls this
   * endpoint every few seconds and is told either "advertise nothing" or "these
   * 8 bytes, for the next N seconds". That is the whole protocol.
   * ====================================================================== */
  const beaconAuth = asyncRoute(async (req, res, next) => {
    const code = String(req.get("X-Beacon-Code") || req.body.beaconCode || "").trim();
    const key = String(req.get("X-Beacon-Key") || req.body.deviceKey || "").trim();
    if (!code || !key) return res.status(401).json({ error: "BEACON_CREDENTIALS_REQUIRED" });
    const found = await db.query("SELECT * FROM beacons WHERE beacon_code=$1", [code]);
    const beacon = found.rows[0];
    const expected = beacon?.device_key_hash || sha256(randomToken(8));
    const supplied = sha256(key);
    const match = supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!beacon || !match) return res.status(401).json({ error: "BEACON_NOT_RECOGNISED" });
    if (!beacon.enabled) return res.status(403).json({ error: "BEACON_DISABLED", message: "This beacon has been disabled by an administrator." });
    req.beacon = beacon;
    next();
  });

  app.post("/api/beacon/poll", beaconAuth, asyncRoute(async (req, res) => {
    const beacon = req.beacon;
    await db.query(
      "UPDATE beacons SET last_seen_at=now(), status='online', firmware_version=COALESCE($2,firmware_version), last_ip_hash=$3 WHERE id=$1",
      [beacon.id, req.body.firmwareVersion || null, ipDigest(authSecret, req.ip)]
    );
    if (!beacon.classroom_id) {
      return res.json({ advertise: false, reason: "UNASSIGNED", pollAfterSeconds: 10, serverTime: Date.now() });
    }
    const session = await db.query(
      `SELECT a.id, a.ends_at, su.name AS subject
       FROM attendance_sessions a JOIN course_offerings o ON o.id=a.offering_id JOIN subjects su ON su.id=o.subject_id
       WHERE a.classroom_id=$1 AND a.beacon_id=$2 AND a.organization_id=$3 AND a.status='active' AND a.ends_at>now() ORDER BY a.starts_at DESC LIMIT 1`,
      [beacon.classroom_id, beacon.id, beacon.organization_id]
    );
    if (!session.rowCount) {
      return res.json({ advertise: false, reason: "NO_ACTIVE_SESSION", pollAfterSeconds: 5, serverTime: Date.now() });
    }
    const row = session.rows[0];
    const secondsRemaining = Math.max(0, Math.round((new Date(row.ends_at).getTime() - Date.now()) / 1000));
    res.json({
      advertise: true,
      sessionId: row.id,
      code: rotatingCode(authSecret, row.id),
      rotationSeconds: ROTATION_SECONDS,
      validForSeconds: Math.min(secondsUntilRotation(), secondsRemaining),
      secondsRemaining,
      pollAfterSeconds: 2,
      serverTime: Date.now()
    });
  }));

  app.post("/api/beacon/event", beaconAuth, asyncRoute(async (req, res) => {
    const event = ["poll", "advertise_start", "advertise_stop", "error", "boot"].includes(req.body.event) ? req.body.event : "poll";
    await db.query(
      "INSERT INTO beacon_events(beacon_id,event,detail) VALUES($1,$2,$3)",
      [req.beacon.id, event, String(req.body.detail || "").slice(0, 500) || null]
    );
    await db.query("UPDATE beacons SET last_seen_at=now(), status='online' WHERE id=$1", [req.beacon.id]);
    res.status(204).end();
  }));

  /* ---- Admin: classroom registry ---------------------------------------- */
  app.get("/api/admin/classrooms", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query(
      `SELECT c.*, b.id AS beacon_id, b.beacon_code, b.label AS beacon_label, b.status AS beacon_status, b.last_seen_at, b.firmware_version,
       (b.last_seen_at IS NOT NULL AND b.last_seen_at > now()-($2||' seconds')::interval) AS beacon_online
       FROM classrooms c LEFT JOIN beacons b ON b.classroom_id=c.id AND b.enabled=true
       WHERE c.organization_id=$1 ORDER BY c.building NULLS FIRST, c.room_number`,
      [req.user.organization_id, String(beaconOfflineSeconds)]
    );
    res.json(result.rows);
  }));

  app.post("/api/admin/classrooms", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const roomNumber = cleanRoom(req.body.roomNumber);
    if (!roomNumber) return res.status(400).json({ error: "MISSING_FIELDS", fields: ["roomNumber"] });
    const minRssi = Number.isFinite(Number(req.body.minRssi)) ? Math.max(-127, Math.min(-10, Number(req.body.minRssi))) : minimumRssi;
    const result = await db.query(
      `INSERT INTO classrooms(organization_id,room_number,building,floor,capacity,min_rssi)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.organization_id, roomNumber, req.body.building || null, req.body.floor || null, req.body.capacity ? Number(req.body.capacity) : null, minRssi]
    );
    await db.transaction((client) => audit(client, req, "CLASSROOM_CREATED", "classroom", result.rows[0].id, null, result.rows[0]));
    res.status(201).json(result.rows[0]);
  }));

  app.patch("/api/admin/classrooms/:id", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query(
      `UPDATE classrooms SET
         room_number=COALESCE($3,room_number), building=COALESCE($4,building), floor=COALESCE($5,floor),
         capacity=COALESCE($6,capacity), min_rssi=COALESCE($7,min_rssi), active=COALESCE($8,active)
       WHERE id=$1 AND organization_id=$2 RETURNING *`,
      [req.params.id, req.user.organization_id,
       req.body.roomNumber ? cleanRoom(req.body.roomNumber) : null, req.body.building ?? null, req.body.floor ?? null,
       req.body.capacity ? Number(req.body.capacity) : null,
       req.body.minRssi !== undefined ? Math.max(-127, Math.min(-10, Number(req.body.minRssi))) : null,
       req.body.active !== undefined ? Boolean(req.body.active) : null]
    );
    if (!result.rowCount) return res.status(404).json({ error: "NOT_FOUND" });
    res.json(result.rows[0]);
  }));

  /* ---- Admin: beacon provisioning --------------------------------------- */
  app.get("/api/admin/beacons", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const result = await db.query(
      `SELECT b.id,b.beacon_code,b.label,b.hardware,b.firmware_version,b.status,b.last_seen_at,b.enabled,
              c.id AS classroom_id,c.room_number,c.building,
              (b.last_seen_at IS NOT NULL AND b.last_seen_at > now()-($2||' seconds')::interval) AS online,
              (SELECT count(*) FROM attendance_sessions a WHERE a.beacon_id=b.id)::int AS sessions_served
       FROM beacons b LEFT JOIN classrooms c ON c.id=b.classroom_id
       WHERE b.organization_id=$1 ORDER BY c.room_number NULLS LAST, b.beacon_code`,
      [req.user.organization_id, String(beaconOfflineSeconds)]
    );
    res.json(result.rows);
  }));

  app.post("/api/admin/beacons", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const beaconCode = String(req.body.beaconCode || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (!beaconCode) return res.status(400).json({ error: "MISSING_FIELDS", fields: ["beaconCode"] });
    if (req.body.classroomId) {
      const classroom = await db.query("SELECT 1 FROM classrooms WHERE id=$1 AND organization_id=$2", [req.body.classroomId, req.user.organization_id]);
      if (!classroom.rowCount) return res.status(400).json({ error: "INVALID_CLASSROOM" });
    }
    // Shown once. The server only ever stores its hash.
    const deviceKey = randomToken(24);
    const result = await db.query(
      `INSERT INTO beacons(organization_id,classroom_id,beacon_code,label,device_key_hash,hardware)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id,beacon_code,label,classroom_id,status,enabled`,
      [req.user.organization_id, req.body.classroomId || null, beaconCode, req.body.label || `AttenDesk ${beaconCode}`, sha256(deviceKey), req.body.hardware || "esp32"]
    );
    await db.transaction((client) => audit(client, req, "BEACON_PROVISIONED", "beacon", result.rows[0].id, null, { beaconCode }));
    res.status(201).json({
      ...result.rows[0],
      deviceKey,
      notice: "Copy this device key into the ESP32 firmware now. It cannot be shown again."
    });
  }));

  app.post("/api/admin/beacons/:id/rotate-key", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const deviceKey = randomToken(24);
    const result = await db.query(
      "UPDATE beacons SET device_key_hash=$3, status='provisioned' WHERE id=$1 AND organization_id=$2 RETURNING id,beacon_code",
      [req.params.id, req.user.organization_id, sha256(deviceKey)]
    );
    if (!result.rowCount) return res.status(404).json({ error: "NOT_FOUND" });
    await db.transaction((client) => audit(client, req, "BEACON_KEY_ROTATED", "beacon", req.params.id, null, null));
    res.json({ ...result.rows[0], deviceKey, notice: "Reflash the ESP32 with this key. The old key no longer works." });
  }));

  app.patch("/api/admin/beacons/:id", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    if (req.body.classroomId) {
      const classroom = await db.query("SELECT 1 FROM classrooms WHERE id=$1 AND organization_id=$2", [req.body.classroomId, req.user.organization_id]);
      if (!classroom.rowCount) return res.status(400).json({ error: "INVALID_CLASSROOM" });
    }
    const result = await db.query(
      `UPDATE beacons SET classroom_id=COALESCE($3,classroom_id), label=COALESCE($4,label), enabled=COALESCE($5,enabled)
       WHERE id=$1 AND organization_id=$2 RETURNING id,beacon_code,label,classroom_id,enabled`,
      [req.params.id, req.user.organization_id, req.body.classroomId || null, req.body.label || null,
       req.body.enabled !== undefined ? Boolean(req.body.enabled) : null]
    );
    if (!result.rowCount) return res.status(404).json({ error: "NOT_FOUND" });
    res.json(result.rows[0]);
  }));

  app.get("/api/admin/beacons/:id/events", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const owned = await db.query("SELECT 1 FROM beacons WHERE id=$1 AND organization_id=$2", [req.params.id, req.user.organization_id]);
    if (!owned.rowCount) return res.status(404).json({ error: "NOT_FOUND" });
    const result = await db.query("SELECT event,detail,created_at FROM beacon_events WHERE beacon_id=$1 ORDER BY created_at DESC LIMIT 100", [req.params.id]);
    res.json(result.rows);
  }));

  /* ---- Reports: below threshold ----------------------------------------- */
  app.get("/api/reports/below-threshold", authenticate, roles("teacher", "admin"), asyncRoute(async (req, res) => {
    const threshold = Number.isFinite(Number(req.query.threshold)) ? Number(req.query.threshold) : null;
    const result = await db.query(
      `WITH totals AS (
         SELECT e.student_id, o.id AS offering_id, su.name AS subject, su.code AS subject_code,
                count(DISTINCT a.id) FILTER (WHERE a.status='closed' OR a.ends_at<=now())::int AS conducted,
                count(DISTINCT ar.session_id) FILTER (WHERE ar.status='present')::int AS attended
         FROM student_enrollments e
         JOIN course_offerings o ON o.id=e.offering_id
         JOIN subjects su ON su.id=o.subject_id
         LEFT JOIN attendance_sessions a ON a.offering_id=o.id AND a.status<>'cancelled'
         LEFT JOIN attendance_records ar ON ar.session_id=a.id AND ar.student_id=e.student_id
         WHERE o.organization_id=$1 AND ($3::uuid IS NULL OR o.teacher_id=$3) AND ($4::uuid IS NULL OR o.id=$4)
         GROUP BY e.student_id,o.id,su.name,su.code
       )
       SELECT u.full_name,s.roll_number,b.name AS branch,sc.name AS section,se.number AS semester,
              t.subject,t.subject_code,t.attended,t.conducted,
              CASE WHEN t.conducted=0 THEN 0 ELSE round(t.attended*100.0/t.conducted,1) END AS percentage
       FROM totals t
       JOIN students s ON s.user_id=t.student_id JOIN users u ON u.id=s.user_id
       JOIN branches b ON b.id=s.branch_id JOIN sections sc ON sc.id=s.section_id JOIN semesters se ON se.id=s.semester_id
       WHERE t.conducted>0 AND (t.attended*100.0/t.conducted) < COALESCE($2::numeric,(SELECT attendance_threshold FROM organizations WHERE id=$1))
       ORDER BY percentage, u.full_name`,
      [req.user.organization_id, threshold, req.user.role === "teacher" ? req.user.id : null, req.query.offeringId || null]
    );
    res.json({ threshold, rows: result.rows });
  }));

  /* ---- Admin: bulk import ------------------------------------------------ */
  app.post("/api/admin/import/students", authenticate, roles("admin"), asyncRoute(async (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 1000) : [];
    if (!rows.length) return res.status(400).json({ error: "NO_ROWS", message: "Provide a rows array parsed from your CSV" });
    const outcome = { created: 0, skipped: 0, errors: [] };
    for (const [index, row] of rows.entries()) {
      try {
        const email = cleanEmail(row.college_email || row.email);
        const rollNumber = cleanRoll(row.roll_number || row.rollNumber);
        const fullName = String(row.full_name || row.fullName || "").trim();
        if (!email || !rollNumber || !fullName) throw new Error("full_name, college_email and roll_number are required");
        const section = await db.query(
          `SELECT sc.id AS section_id, b.id AS branch_id, se.id AS semester_id
           FROM sections sc JOIN branches b ON b.id=sc.branch_id JOIN semesters se ON se.id=sc.semester_id
           WHERE b.organization_id=$1 AND lower(b.code)=lower($2) AND se.number=$3 AND lower(sc.name)=lower($4) AND se.active=true`,
          [req.user.organization_id, row.branch_code, Number(row.semester), row.section_name]
        );
        if (!section.rowCount) throw new Error(`No section matches ${row.branch_code}/sem ${row.semester}/${row.section_name}`);
        await db.transaction(async (client) => {
          const user = await client.query(
            `INSERT INTO users(organization_id,email,full_name,role,status) VALUES($1,$2,$3,'student','active')
             ON CONFLICT (organization_id,email) DO NOTHING RETURNING id`,
            [req.user.organization_id, email, fullName]
          );
          if (!user.rowCount) { outcome.skipped += 1; return; }
          await client.query(
            "INSERT INTO students(user_id,roll_number,branch_id,semester_id,section_id,phone) VALUES($1,$2,$3,$4,$5,$6)",
            [user.rows[0].id, rollNumber, section.rows[0].branch_id, section.rows[0].semester_id, section.rows[0].section_id, row.phone || null]
          );
          if (row.barcode) {
            await client.query(
              "INSERT INTO barcode_registrations(student_id,barcode_hash,barcode_last_four,registered_by) VALUES($1,$2,$3,$4)",
              [user.rows[0].id, keyedHash(barcodePepper, `${req.user.organization_id}:${String(row.barcode).trim()}`), String(row.barcode).trim().slice(-4), req.user.id]
            );
          }
          outcome.created += 1;
        });
      } catch (error) {
        outcome.errors.push({ row: index + 1, message: error.message });
      }
    }
    res.json(outcome);
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
    if (['42P01', '42703'].includes(error.code)) return res.status(503).json({ error: 'DATABASE_MIGRATION_REQUIRED', message: 'Database setup is incomplete. The administrator must run npm run migrate against this deployment database.' });
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', '28P01', '3D000'].includes(error.code)) return res.status(503).json({ error: 'DATABASE_UNAVAILABLE', message: 'Cannot connect to the database. Check the hosting DATABASE_URL and database availability.' });
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
