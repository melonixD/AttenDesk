import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { issueAccessToken, keyedHash, otpHash, verifyAccessToken } from "../src/security.js";

test("signed access tokens reject tampering and expiry", () => {
  const secret = "a-production-length-secret-used-only-in-tests";
  const token = issueAccessToken(secret, { sub: "student-1", role: "student", clientType: "mobile" }, 60);
  assert.equal(verifyAccessToken(secret, token).sub, "student-1");
  assert.equal(verifyAccessToken(secret, `${token.slice(0, -1)}x`), null);
  assert.equal(verifyAccessToken(secret, issueAccessToken(secret, { sub: "student-1" }, -1)), null);
});

test("OTP and barcode hashes are scoped and do not reveal raw values", () => {
  const first = otpHash("otp-secret", "college-a", "student@college.edu", "123456");
  assert.notEqual(first, otpHash("otp-secret", "college-b", "student@college.edu", "123456"));
  assert.notEqual(first, "123456");
  assert.notEqual(keyedHash("pepper", "CARD1234"), keyedHash("pepper", "CARD5678"));
});

test("production schema and API contain the required persistent controls", async () => {
  const schema = await fs.readFile(new URL("../migrations/001_production_schema.sql", import.meta.url), "utf8");
  const api = await fs.readFile(new URL("../src/production-app.js", import.meta.url), "utf8");
  const migrationRunner = await fs.readFile(new URL("../scripts/migrate.js", import.meta.url), "utf8");
  for (const table of ["users", "registration_requests", "otp_challenges", "student_devices", "device_change_requests", "course_offerings", "timetable_entries", "barcode_registrations", "attendance_sessions", "attendance_records", "audit_logs", "backup_runs"]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schema, /UNIQUE \(session_id, student_id\)/);
  assert.match(schema, /one_active_device_per_student/);
  for (const route of ["/api/auth/register", "/api/admin/sections", "/api/admin/offerings", "/api/admin/timetable", "/api/admin/users/:id/status", "/api/student/dashboard", "/api/student/history", ".xlsx", ".pdf"]) {
    assert.ok(api.includes(route), `missing ${route}`);
  }
  assert.match(api, /TIMETABLE_CONFLICT/);
  assert.match(api, /ROOM_ALREADY_ACTIVE/);
  assert.match(api, /DEVICE_TOKEN_MISMATCH/);
  assert.match(migrationRunner, /schema_migrations/);
  assert.match(migrationRunner, /checksum/);
});

test("production UI includes resilient loading and accessibility states", async () => {
  const [webApp, styles, html, android] = await Promise.all([
    fs.readFile(new URL("../../public/app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../../public/styles.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../../public/index.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../../android/app/src/main/java/in/attendesk/app/MainActivity.kt", import.meta.url), "utf8")
  ]);
  assert.match(webApp, /function pageSkeleton/);
  assert.match(webApp, /function setButtonBusy/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /\.skeleton-metrics/);
  assert.match(html, /aria-live="polite"/);
  assert.match(android, /private fun loadingPanel/);
});

test("Vercel has a root Express export and CDN-ready public assets", async () => {
  const [entry, packageJson, vercelConfig, html] = await Promise.all([
    fs.readFile(new URL("../../index.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../../package.json", import.meta.url), "utf8"),
    fs.readFile(new URL("../../vercel.json", import.meta.url), "utf8"),
    fs.readFile(new URL("../../public/index.html", import.meta.url), "utf8")
  ]);
  assert.match(entry, /import express from "express"/);
  assert.match(entry, /export default app/);
  assert.equal(JSON.parse(packageJson).dependencies.express, "^4.21.2");
  assert.ok(Array.isArray(JSON.parse(vercelConfig).headers));
  assert.match(html, /AttenDesk/);
});
