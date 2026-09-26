import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createProductionApp } from "../src/production-app.js";
import { hashPassword, issueAccessToken } from "../src/security.js";

const AUTH_SECRET = "test-auth-secret-that-is-longer-than-32-characters";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const STUDENT_ID = "00000000-0000-4000-8000-000000000003";

process.env.AUTH_SECRET = AUTH_SECRET;
process.env.OTP_SECRET = "test-otp-secret-that-is-longer-than-32-characters";
process.env.BARCODE_PEPPER = "test-barcode-pepper-that-is-longer-than-32-chars";
process.env.ENFORCE_TIMETABLE = "false";

const users = {
  [ADMIN_ID]: { id: ADMIN_ID, organization_id: ORG_ID, email: "admin@college.edu", full_name: "Admin", role: "admin", status: "active" },
  [STUDENT_ID]: { id: STUDENT_ID, organization_id: ORG_ID, email: "student@college.edu", full_name: "Student", role: "student", status: "active" }
};

const db = {
  async query(sql, params = []) {
    if (sql.includes("FROM users WHERE id=$1")) {
      const user = users[params[0]];
      return { rowCount: user ? 1 : 0, rows: user ? [user] : [] };
    }
    if (sql.includes("FROM course_offerings o JOIN students s ON s.user_id=$2")) return { rowCount: 0, rows: [] };
    throw new Error(`Unexpected test query: ${sql}`);
  },
  async transaction(work) {
    return work({
      async query(sql) {
        if (sql.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [{}] };
        if (sql.startsWith("SELECT id FROM course_offerings")) return { rowCount: 1, rows: [{ id: "offering-1" }] };
        if (sql.includes("FROM timetable_entries t")) {
          return { rowCount: 1, rows: [{ id: "period-1", subject: "Microbiology", conflict_type: "room", room: "210" }] };
        }
        throw new Error(`Unexpected transaction query: ${sql}`);
      }
    });
  }
};

let server;
let baseUrl;

before(async () => {
  server = http.createServer(createProductionApp({ db, mailer: { sendOtp: async () => ({}) } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function request(path, token, body, method = "POST") {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test("device-change token cannot authenticate as the underlying student", async () => {
  const token = issueAccessToken(AUTH_SECRET, { sub: STUDENT_ID, org: ORG_ID, role: "device_change" });
  const response = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "UNAUTHORISED");
});

for (const [code, expected] of [['42P01', 'DATABASE_MIGRATION_REQUIRED'], ['ECONNREFUSED', 'DATABASE_UNAVAILABLE']]) {
  test(`database ${code} produces actionable login error`, async () => {
    const brokenDb = { query: async () => { throw Object.assign(new Error('test database failure'), { code }); } };
    const instance = http.createServer(createProductionApp({ db: brokenDb, mailer: { sendOtp: async () => ({}) } }));
    await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${instance.address().port}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'admin@college.edu', password: 'TestPassword99' })
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, expected);
    } finally { await new Promise(resolve => instance.close(resolve)); }
  });
}

test("invalid enrollment is not reported as successful", async () => {
  const token = issueAccessToken(AUTH_SECRET, { sub: ADMIN_ID, org: ORG_ID, role: "admin", clientType: "web" });
  const result = await request("/api/admin/enrollments", token, { offeringId: "missing", studentId: "missing" });
  assert.equal(result.status, 404);
  assert.equal(result.body.error, "STUDENT_OR_OFFERING_NOT_FOUND");
});

test("mobile attendance token is bound to its installation", async () => {
  const token = issueAccessToken(AUTH_SECRET, { sub: STUDENT_ID, org: ORG_ID, role: "student", clientType: "mobile", installationId: "phone-a" });
  const result = await request("/api/attendance/sessions/session-1/mark", token, { installationId: "phone-b", barcode: "CARD1234", rssiSamples: [-60, -61, -62] });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "DEVICE_TOKEN_MISMATCH");
});

test("web Bluetooth attendance requires a session beacon proof", async () => {
  const token = issueAccessToken(AUTH_SECRET, { sub: STUDENT_ID, org: ORG_ID, role: "student", clientType: "web_ble", installationId: "browser-a" });
  const result = await request("/api/attendance/sessions/session-1/mark", token, { installationId: "browser-a", barcode: "CARD1234" });
  assert.equal(result.status, 422);
  assert.equal(result.body.error, "INVALID_BLUETOOTH_PROOF");
});

test("overlapping timetable room allocation is rejected", async () => {
  const token = issueAccessToken(AUTH_SECRET, { sub: ADMIN_ID, org: ORG_ID, role: "admin", clientType: "web" });
  const result = await request("/api/admin/timetable", token, {
    offeringId: "offering-1", dayOfWeek: 1, startsAt: "10:00", endsAt: "11:00", room: "210", validFrom: "2026-01-01", validUntil: "2026-12-31"
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "TIMETABLE_CONFLICT");
});

test("mobile student login requires and verifies an assigned password", async () => {
  const mobileUser = {
    id: STUDENT_ID,
    organization_id: ORG_ID,
    email: "student@college.edu",
    username: null,
    full_name: "Test Student",
    role: "student",
    status: "active",
    password_hash: null
  };
  const mobileDb = {
    async query(sql) {
      if (sql.includes("FROM students s JOIN users u")) return { rowCount: 1, rows: [mobileUser] };
      if (sql.includes("FROM student_devices")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("INSERT INTO student_devices")) return { rowCount: 1, rows: [] };
      if (sql.startsWith("UPDATE student_devices")) return { rowCount: 1, rows: [] };
      if (sql.startsWith("INSERT INTO refresh_tokens")) return { rowCount: 1, rows: [] };
      if (sql.startsWith("UPDATE users SET last_login_at")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected mobile-login query: ${sql}`);
    },
    async transaction(work) { return work(this); }
  };
  const instance = http.createServer(createProductionApp({ db: mobileDb, mailer: { sendOtp: async () => ({}) } }));
  await new Promise(resolve => instance.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${instance.address().port}/api/auth/student-login`;
  const signIn = async (password) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Test Student", rollNumber: "250107010", password, clientType: "mobile", installationId: "phone-a", deviceName: "Test Android", platform: "android" })
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const missing = await signIn("StudentPass99");
    assert.equal(missing.status, 403);
    assert.equal(missing.body.error, "PASSWORD_NOT_SET");

    mobileUser.password_hash = hashPassword("StudentPass99");
    const wrong = await signIn("WrongPass99");
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, "INVALID_CREDENTIALS");

    const correct = await signIn("StudentPass99");
    assert.equal(correct.status, 200);
    assert.equal(correct.body.user.role, "student");
    assert.ok(correct.body.accessToken);
  } finally {
    await new Promise(resolve => instance.close(resolve));
  }
});

test("post-session corrections require an audit reason", async () => {
  const token = issueAccessToken(AUTH_SECRET, { sub: ADMIN_ID, org: ORG_ID, role: "admin", clientType: "web" });
  const result = await request(`/api/admin/attendance/sessions/session-1/students/${STUDENT_ID}`, token, { status: "present", reason: "" }, "PATCH");
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "REASON_REQUIRED");
});

test("student attendance appeals require an explanation", async () => {
  const token = issueAccessToken(AUTH_SECRET, { sub: STUDENT_ID, org: ORG_ID, role: "student", clientType: "web" });
  const result = await request("/api/student/attendance/record-1/appeals", token, { requestedStatus: "present", reason: "" });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "REASON_REQUIRED");
});

test("bulk import rejects empty CSV payloads", async () => {
  const token = issueAccessToken(AUTH_SECRET, { sub: ADMIN_ID, org: ORG_ID, role: "admin", clientType: "web" });
  const result = await request("/api/admin/import/teachers", token, { rows: [] });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "NO_ROWS");
});
