import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createProductionApp } from "../src/production-app.js";
import { issueAccessToken } from "../src/security.js";

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

async function request(path, token, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
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

test("overlapping timetable room allocation is rejected", async () => {
  const token = issueAccessToken(AUTH_SECRET, { sub: ADMIN_ID, org: ORG_ID, role: "admin", clientType: "web" });
  const result = await request("/api/admin/timetable", token, {
    offeringId: "offering-1", dayOfWeek: 1, startsAt: "10:00", endsAt: "11:00", room: "210", validFrom: "2026-01-01", validUntil: "2026-12-31"
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "TIMETABLE_CONFLICT");
});
