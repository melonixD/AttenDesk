import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createAttendanceApp } from "../src/app.js";

let server;
let baseUrl;

before(async () => {
  server = http.createServer(createAttendanceApp({ secret: "test-secret" }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function request(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

async function login(role, userId, deviceId) {
  const result = await request("/api/login", { method: "POST", body: { role, userId, deviceId } });
  assert.equal(result.status, 200);
  return result.body.token;
}

test("teacher starts a timed session and student marks attendance once", async () => {
  const teacher = await login("teacher", "teacher-1");
  const student = await login("student", "student-1", "demo-phone-1");
  const started = await request("/api/sessions", {
    token: teacher,
    method: "POST",
    body: { offeringId: "fluid-food-a", roomId: "210", durationSeconds: 180 }
  });
  assert.equal(started.status, 201);
  assert.match(started.body.beaconToken, /^[a-f0-9]{16}$/);

  const discovered = await request(`/api/sessions/by-beacon/${started.body.beaconToken}`, { token: student });
  assert.equal(discovered.status, 200);
  assert.equal(discovered.body.subject, "Fluid Mechanics");

  const first = await request(`/api/sessions/${started.body.id}/attendance`, {
    token: student,
    method: "POST",
    body: { barcode: "HBTU240101", deviceId: "demo-phone-1", rssiSamples: [-61, -64, -60] }
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.attendance.method, "barcode+ble");

  const duplicate = await request(`/api/sessions/${started.body.id}/attendance`, {
    token: student,
    method: "POST",
    body: { barcode: "HBTU240101", deviceId: "demo-phone-1", rssiSamples: [-62] }
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);

  const closed = await request(`/api/sessions/${started.body.id}/close`, { token: teacher, method: "POST" });
  assert.equal(closed.status, 200);
});

test("wrong phone, wrong barcode and weak BLE signal are rejected", async () => {
  const wrongPhone = await request("/api/login", { method: "POST", body: { role: "student", userId: "student-2", deviceId: "someone-elses-phone" } });
  assert.equal(wrongPhone.status, 403);

  const teacher = await login("teacher", "teacher-1");
  const student = await login("student", "student-2", "demo-phone-2");
  const started = await request("/api/sessions", { token: teacher, method: "POST", body: { offeringId: "micro-food-a", roomId: "211", durationSeconds: 120 } });
  assert.equal(started.status, 201);

  const badBarcode = await request(`/api/sessions/${started.body.id}/attendance`, {
    token: student,
    method: "POST",
    body: { barcode: "HBTU240999", deviceId: "demo-phone-2", rssiSamples: [-55] }
  });
  assert.equal(badBarcode.status, 403);

  const weak = await request(`/api/sessions/${started.body.id}/attendance`, {
    token: student,
    method: "POST",
    body: { barcode: "HBTU240102", deviceId: "demo-phone-2", rssiSamples: [-101, -98, -96] }
  });
  assert.equal(weak.status, 422);

  const noReason = await request(`/api/sessions/${started.body.id}/manual`, {
    token: teacher,
    method: "POST",
    body: { studentId: "student-2", status: "present", reason: "" }
  });
  assert.equal(noReason.status, 400);

  const manual = await request(`/api/sessions/${started.body.id}/manual`, {
    token: teacher,
    method: "POST",
    body: { studentId: "student-2", status: "present", reason: "ID card forgotten" }
  });
  assert.equal(manual.status, 200);
  assert.equal(manual.body.attendance.method, "manual");

  await request(`/api/sessions/${started.body.id}/close`, { token: teacher, method: "POST" });
  const report = await request("/api/reports/class-offerings/fluid-food-a", { token: teacher });
  assert.equal(report.status, 200);
  assert.equal(report.body.students.length, 8);
});

test("interactive prototype is served from the API process", async () => {
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /AttenDesk/);
  assert.match(html, /Continue as teacher/);
});
