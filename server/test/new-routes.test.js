/**
 * Route-level smoke tests for everything added in this release.
 *
 * These run against a stub database rather than PostgreSQL, so they prove the
 * routes are wired, authorised and shaped correctly. They do not prove the SQL
 * is valid — run `npm run migrate` against a real database for that.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createProductionApp } from "../src/production-app.js";
import { acceptableRotatingCodes, hashPassword, sha256 } from "../src/security.js";

const AUTH_SECRET = "test-auth-secret-that-is-longer-than-32-characters";
process.env.AUTH_SECRET = AUTH_SECRET;
process.env.OTP_SECRET = "test-otp-secret-that-is-longer-than-32-characters";
process.env.BARCODE_PEPPER = "test-barcode-pepper-that-is-longer-than-32-chars";
process.env.ENFORCE_TIMETABLE = "false";

const ORG = "00000000-0000-4000-8000-000000000001";
const TEACHER = "00000000-0000-4000-8000-000000000002";
const BEACON = "00000000-0000-4000-8000-000000000003";
const SESSION = "00000000-0000-4000-8000-000000000004";
const CLASSROOM = "00000000-0000-4000-8000-000000000005";

const teacherRow = {
  id: TEACHER, organization_id: ORG, email: "alakh@hbtu.ac.in", username: "alakh",
  full_name: "Alakh Kumar Singh", role: "teacher", status: "active",
  password_hash: hashPassword("Alakh7u8")
};

const beaconRow = {
  id: BEACON, organization_id: ORG, classroom_id: CLASSROOM, beacon_code: "ATTENDESK-210",
  label: "Room 210 beacon", device_key_hash: sha256("correct-device-key"), enabled: true
};

const db = {
  async query(sql, params = []) {
    if (sql.includes("FROM organizations ORDER BY created_at")) return { rowCount: 1, rows: [{ id: ORG }] };
    if (sql.includes("FROM organizations WHERE lower(email_domain)")) {
      const hit = String(params[0] || "").toLowerCase() === "hbtu.ac.in";
      return { rowCount: hit ? 1 : 0, rows: hit ? [{ id: ORG, email_domain: "hbtu.ac.in" }] : [] };
    }
    if (sql.includes("FROM users\n       WHERE organization_id=$1") || sql.includes("lower(trim(full_name))=lower(trim($2))")) {
      const needle = String(params[1] || "").toLowerCase();
      const hit = ["alakh", "alakh@hbtu.ac.in", "alakh kumar singh"].includes(needle);
      return { rowCount: hit ? 1 : 0, rows: hit ? [teacherRow] : [] };
    }
    if (sql.includes("FROM users WHERE id=$1")) return { rowCount: 1, rows: [teacherRow] };
    if (sql.startsWith("SELECT * FROM beacons WHERE beacon_code=$1")) {
      const hit = params[0] === "ATTENDESK-210";
      return { rowCount: hit ? 1 : 0, rows: hit ? [beaconRow] : [] };
    }
    if (sql.startsWith("UPDATE beacons SET last_seen_at")) return { rowCount: 1, rows: [] };
    if (sql.includes("FROM attendance_sessions a JOIN course_offerings o ON o.id=a.offering_id JOIN subjects su")) {
      return { rowCount: 1, rows: [{ id: SESSION, ends_at: new Date(Date.now() + 120_000), subject: "Fluid Mechanics" }] };
    }
    if (sql.includes("INSERT INTO refresh_tokens")) return { rowCount: 1, rows: [] };
    if (sql.startsWith("UPDATE users SET last_login_at")) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected query: ${sql.slice(0, 90)}`);
  },
  async transaction(work) { return work({ query: async () => ({ rowCount: 0, rows: [] }) }); }
};

let server;
let origin;

before(async () => {
  const app = createProductionApp({ db, mailer: { sendOtp: async () => ({ delivered: true }) } });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const post = (path, body, headers = {}) =>
  fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("a teacher can sign in with a username or with their full name", async () => {
  for (const identifier of ["alakh", "Alakh Kumar Singh", "alakh@hbtu.ac.in"]) {
    const response = await post("/api/auth/login", { identifier, password: "Alakh7u8" });
    assert.equal(response.status, 200, `${identifier} should sign in`);
    const body = await response.json();
    assert.equal(body.user.role, "teacher");
    assert.ok(body.accessToken && body.refreshToken);
    assert.ok(!("password_hash" in body.user), "the hash must never leave the server");
  }
});

test("a wrong password and an unknown user are refused identically", async () => {
  const wrong = await post("/api/auth/login", { identifier: "alakh", password: "not-the-password" });
  const missing = await post("/api/auth/login", { identifier: "nobody", password: "not-the-password" });
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.deepEqual(await wrong.json(), await missing.json(), "responses must not reveal which accounts exist");
});

test("a beacon with the wrong device key learns nothing", async () => {
  const response = await post("/api/beacon/poll", {}, { "X-Beacon-Code": "ATTENDESK-210", "X-Beacon-Key": "wrong-key" });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.advertise, undefined, "a rejected beacon is never handed a code");
});

test("an authenticated beacon is handed the current rotating code and nothing else", async () => {
  const response = await post(
    "/api/beacon/poll",
    { firmwareVersion: "1.0.0" },
    { "X-Beacon-Code": "ATTENDESK-210", "X-Beacon-Key": "correct-device-key" }
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.advertise, true);
  assert.match(body.code, /^[a-f0-9]{16}$/);
  assert.ok(acceptableRotatingCodes(AUTH_SECRET, SESSION).includes(body.code));
  assert.ok(body.validForSeconds > 0 && body.validForSeconds <= 30);

  // The beacon must not be told who is in the room or what is being taught.
  const leaked = JSON.stringify(body).toLowerCase();
  for (const secret of ["fluid", "roster", "student", "alakh"]) {
    assert.ok(!leaked.includes(secret), `beacon payload leaked "${secret}"`);
  }
});

test("attendance endpoints stay closed to unauthenticated callers", async () => {
  for (const path of ["/api/attendance/sessions", `/api/attendance/sessions/${SESSION}/close`]) {
    assert.equal((await post(path, {})).status, 401, `${path} must require a token`);
  }
  assert.equal((await fetch(`${origin}/api/admin/beacons`)).status, 401);
  assert.equal((await fetch(`${origin}/api/admin/classrooms`)).status, 401);
});

test("the live roster endpoint is teacher-only", async () => {
  const response = await fetch(`${origin}/api/attendance/sessions/${SESSION}/live`);
  assert.equal(response.status, 401);
});
