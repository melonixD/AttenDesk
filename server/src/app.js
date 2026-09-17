import crypto from "node:crypto";
import fs from "node:fs";
import { seed } from "./data.js";

const prototypeRoot = new URL("../../public/demo/", import.meta.url);

const servePrototype = (res, pathname) => {
  const files = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json; charset=utf-8"]
  };
  const target = files[pathname];
  if (!target) return false;
  const body = fs.readFileSync(new URL(target[0], prototypeRoot));
  res.writeHead(200, { "Content-Type": target[1], "Content-Length": body.length, "Cache-Control": "no-store" });
  res.end(body);
  return true;
};

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(payload);
};

const readBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
};

const b64url = (value) => Buffer.from(value).toString("base64url");

export function createAttendanceApp(options = {}) {
  const secret = options.secret || process.env.APP_SECRET || "attendesk-local-development-secret";
  const now = options.now || (() => Date.now());
  const teachers = structuredClone(seed.teachers);
  const students = structuredClone(seed.students).map((student) => ({
    ...student,
    barcodeHash: crypto.createHash("sha256").update(student.barcode).digest("hex")
  }));
  const offerings = structuredClone(seed.offerings);
  const historical = structuredClone(seed.historical);
  const sessions = new Map();
  const attendance = new Map();
  const auditLog = [];

  const sign = (payload) => {
    const encoded = b64url(JSON.stringify(payload));
    const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  };

  const verify = (token) => {
    if (!token || !token.includes(".")) return null;
    const [encoded, signature] = token.split(".");
    const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      return payload.exp > now() ? payload : null;
    } catch {
      return null;
    }
  };

  const actorFor = (req) => {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const payload = verify(token);
    if (!payload) return null;
    if (payload.role === "teacher") return teachers.find((item) => item.id === payload.sub) ? payload : null;
    if (payload.role === "student") return students.find((item) => item.id === payload.sub) ? payload : null;
    return null;
  };

  const activeSession = (session) => session && session.status === "active" && session.endsAt > now();
  const attendanceKey = (sessionId, studentId) => `${sessionId}:${studentId}`;
  const median = (values = []) => {
    const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!clean.length) return null;
    const middle = Math.floor(clean.length / 2);
    return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
  };

  const sessionView = (session, includeRoster = false) => {
    const offering = offerings.find((item) => item.id === session.offeringId);
    const teacher = teachers.find((item) => item.id === session.teacherId);
    const base = {
      id: session.id,
      beaconToken: session.beaconToken,
      status: activeSession(session) ? "active" : session.status === "active" ? "expired" : session.status,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      roomId: session.roomId,
      subject: offering.subject,
      subjectCode: offering.code,
      branch: offering.branch,
      section: offering.section,
      teacher: teacher.name
    };
    if (!includeRoster) return base;
    return {
      ...base,
      roster: students
        .filter((student) => student.offeringIds.includes(session.offeringId))
        .map((student) => {
          const record = attendance.get(attendanceKey(session.id, student.id));
          return {
            id: student.id,
            name: student.name,
            rollNumber: student.rollNumber,
            status: record?.status || "absent",
            method: record?.method || null,
            markedAt: record?.markedAt || null,
            reason: record?.reason || null
          };
        })
    };
  };

  const requireRole = (req, res, role) => {
    const actor = actorFor(req);
    if (!actor || actor.role !== role) {
      json(res, 401, { error: "UNAUTHORISED", message: `${role} authentication required` });
      return null;
    }
    return actor;
  };

  return async function app(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (req.method === "GET" && servePrototype(res, url.pathname)) return;

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true, service: "attendesk", time: now() });
      }

      if (req.method === "POST" && url.pathname === "/api/login") {
        const body = await readBody(req);
        if (!['teacher', 'student'].includes(body.role)) return json(res, 400, { error: "BAD_ROLE" });
        const list = body.role === "teacher" ? teachers : students;
        const user = list.find((item) => item.id === body.userId);
        if (!user) return json(res, 404, { error: "USER_NOT_FOUND" });
        if (body.role === "student" && body.deviceId !== user.deviceId) {
          return json(res, 403, { error: "DEVICE_MISMATCH", message: "This account is registered to another phone" });
        }
        const token = sign({ sub: user.id, role: body.role, exp: now() + 12 * 60 * 60 * 1000 });
        return json(res, 200, { token, user: { id: user.id, name: user.name, role: body.role } });
      }

      if (req.method === "GET" && url.pathname === "/api/teacher/classes") {
        const actor = requireRole(req, res, "teacher");
        if (!actor) return;
        const teacher = teachers.find((item) => item.id === actor.sub);
        return json(res, 200, offerings.filter((item) => teacher.assignedOfferingIds.includes(item.id)));
      }

      if (req.method === "POST" && url.pathname === "/api/sessions") {
        const actor = requireRole(req, res, "teacher");
        if (!actor) return;
        const body = await readBody(req);
        const offering = offerings.find((item) => item.id === body.offeringId && item.teacherId === actor.sub);
        if (!offering) return json(res, 403, { error: "CLASS_NOT_ASSIGNED" });
        const durationSeconds = Math.max(30, Math.min(600, Number(body.durationSeconds) || 180));
        const openSession = [...sessions.values()].find((item) => item.teacherId === actor.sub && activeSession(item));
        if (openSession) return json(res, 409, { error: "SESSION_ALREADY_ACTIVE", session: sessionView(openSession) });
        const session = {
          id: crypto.randomUUID(),
          beaconToken: crypto.randomBytes(8).toString("hex"),
          teacherId: actor.sub,
          offeringId: offering.id,
          roomId: String(body.roomId || offering.defaultRoom),
          startsAt: now(),
          endsAt: now() + durationSeconds * 1000,
          status: "active"
        };
        sessions.set(session.id, session);
        auditLog.push({ action: "SESSION_STARTED", actorId: actor.sub, sessionId: session.id, at: now() });
        return json(res, 201, sessionView(session, true));
      }

      const beaconMatch = url.pathname.match(/^\/api\/sessions\/by-beacon\/([a-f0-9]{16})$/);
      if (req.method === "GET" && beaconMatch) {
        const actor = requireRole(req, res, "student");
        if (!actor) return;
        const student = students.find((item) => item.id === actor.sub);
        const session = [...sessions.values()].find((item) => item.beaconToken === beaconMatch[1]);
        if (!activeSession(session)) return json(res, 404, { error: "SESSION_NOT_ACTIVE" });
        if (!student.offeringIds.includes(session.offeringId)) return json(res, 403, { error: "NOT_ON_ROSTER" });
        return json(res, 200, sessionView(session));
      }

      const attendanceMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/attendance$/);
      if (req.method === "POST" && attendanceMatch) {
        const actor = requireRole(req, res, "student");
        if (!actor) return;
        const body = await readBody(req);
        const session = sessions.get(attendanceMatch[1]);
        const student = students.find((item) => item.id === actor.sub);
        if (!activeSession(session)) return json(res, 410, { error: "SESSION_CLOSED" });
        if (!student.offeringIds.includes(session.offeringId)) return json(res, 403, { error: "NOT_ON_ROSTER" });
        if (body.deviceId !== student.deviceId) return json(res, 403, { error: "DEVICE_MISMATCH" });
        const suppliedHash = crypto.createHash("sha256").update(String(body.barcode || "")).digest("hex");
        if (suppliedHash !== student.barcodeHash) return json(res, 403, { error: "BARCODE_MISMATCH" });
        const signal = median(body.rssiSamples);
        if (signal === null || signal < -92) return json(res, 422, { error: "WEAK_OR_MISSING_SIGNAL", medianRssi: signal });
        const key = attendanceKey(session.id, student.id);
        if (attendance.has(key)) return json(res, 200, { ok: true, duplicate: true, attendance: attendance.get(key) });
        const overlapping = [...attendance.values()].find((item) => item.studentId === student.id && item.status === "present" && item.sessionId !== session.id && sessions.get(item.sessionId)?.endsAt > session.startsAt);
        if (overlapping) return json(res, 409, { error: "OVERLAPPING_ATTENDANCE" });
        const record = { sessionId: session.id, studentId: student.id, status: "present", method: "barcode+ble", markedAt: now(), medianRssi: signal };
        attendance.set(key, record);
        auditLog.push({ action: "SELF_MARKED_PRESENT", actorId: student.id, sessionId: session.id, at: now() });
        return json(res, 201, { ok: true, duplicate: false, attendance: record });
      }

      const manualMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/manual$/);
      if (req.method === "POST" && manualMatch) {
        const actor = requireRole(req, res, "teacher");
        if (!actor) return;
        const body = await readBody(req);
        const session = sessions.get(manualMatch[1]);
        if (!session || session.teacherId !== actor.sub) return json(res, 404, { error: "SESSION_NOT_FOUND" });
        const student = students.find((item) => item.id === body.studentId && item.offeringIds.includes(session.offeringId));
        if (!student) return json(res, 404, { error: "STUDENT_NOT_ON_ROSTER" });
        if (!String(body.reason || "").trim()) return json(res, 400, { error: "REASON_REQUIRED" });
        const status = body.status === "absent" ? "absent" : "present";
        const record = { sessionId: session.id, studentId: student.id, status, method: "manual", reason: String(body.reason).trim(), markedAt: now() };
        attendance.set(attendanceKey(session.id, student.id), record);
        auditLog.push({ action: "MANUAL_ATTENDANCE_CHANGED", actorId: actor.sub, studentId: student.id, sessionId: session.id, status, reason: record.reason, at: now() });
        return json(res, 200, { ok: true, attendance: record });
      }

      const closeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/close$/);
      if (req.method === "POST" && closeMatch) {
        const actor = requireRole(req, res, "teacher");
        if (!actor) return;
        const session = sessions.get(closeMatch[1]);
        if (!session || session.teacherId !== actor.sub) return json(res, 404, { error: "SESSION_NOT_FOUND" });
        session.status = "closed";
        session.endsAt = Math.min(session.endsAt, now());
        auditLog.push({ action: "SESSION_CLOSED", actorId: actor.sub, sessionId: session.id, at: now() });
        return json(res, 200, sessionView(session, true));
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (req.method === "GET" && sessionMatch) {
        const actor = actorFor(req);
        if (!actor) return json(res, 401, { error: "UNAUTHORISED" });
        const session = sessions.get(sessionMatch[1]);
        if (!session) return json(res, 404, { error: "SESSION_NOT_FOUND" });
        if (actor.role === "teacher" && session.teacherId !== actor.sub) return json(res, 403, { error: "FORBIDDEN" });
        return json(res, 200, sessionView(session, actor.role === "teacher"));
      }

      const reportMatch = url.pathname.match(/^\/api\/reports\/class-offerings\/([^/]+)$/);
      if (req.method === "GET" && reportMatch) {
        const actor = requireRole(req, res, "teacher");
        if (!actor) return;
        const offering = offerings.find((item) => item.id === reportMatch[1] && item.teacherId === actor.sub);
        if (!offering) return json(res, 404, { error: "CLASS_NOT_FOUND" });
        const rows = students.filter((student) => student.offeringIds.includes(offering.id)).map((student) => {
          const base = historical.find((item) => item.offeringId === offering.id && item.studentId === student.id) || { attended: 0, conducted: 0 };
          const completedSessions = [...sessions.values()].filter((item) => item.offeringId === offering.id && (item.status === "closed" || item.endsAt <= now()));
          const attendedNow = completedSessions.filter((item) => attendance.get(attendanceKey(item.id, student.id))?.status === "present").length;
          const conducted = base.conducted + completedSessions.length;
          const attended = base.attended + attendedNow;
          const percentage = conducted ? Math.round((attended / conducted) * 1000) / 10 : 0;
          return { studentId: student.id, name: student.name, rollNumber: student.rollNumber, attended, conducted, percentage, below75: percentage < 75 };
        });
        return json(res, 200, { offering, below75Count: rows.filter((row) => row.below75).length, students: rows });
      }

      if (req.method === "GET" && url.pathname === "/api/audit") {
        const actor = requireRole(req, res, "teacher");
        if (!actor) return;
        return json(res, 200, auditLog.filter((item) => item.actorId === actor.sub || sessions.get(item.sessionId)?.teacherId === actor.sub));
      }

      return json(res, 404, { error: "NOT_FOUND" });
    } catch (error) {
      return json(res, 400, { error: "BAD_REQUEST", message: error.message });
    }
  };
}
