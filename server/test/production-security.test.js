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
  const [webApp, styles, html, android, bleManager, androidManifest, webBluetoothMigration, demoApp, demoStyles, demoHtml] = await Promise.all([
    fs.readFile(new URL("../../public/app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../../public/styles.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../../public/index.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../../android/app/src/main/java/in/attendesk/app/MainActivity.kt", import.meta.url), "utf8"),
    fs.readFile(new URL("../../android/app/src/main/java/in/attendesk/app/BleSessionManager.kt", import.meta.url), "utf8"),
    fs.readFile(new URL("../../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8"),
    fs.readFile(new URL("../migrations/004_web_bluetooth.sql", import.meta.url), "utf8"),
    fs.readFile(new URL("../../public/demo/app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../../public/demo/styles.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../../public/demo/index.html", import.meta.url), "utf8")
  ]);
  assert.match(webApp, /function pageSkeleton/);
  assert.match(webApp, /function setButtonBusy/);
  assert.match(webApp, /function icon/);
  assert.match(webApp, /function animatePageElements/);
  assert.match(webApp, /press-ripple/);
  assert.match(webApp, /function bindInteractiveDepth/);
  assert.match(webApp, /function animateMetricValues/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /\.skeleton-metrics/);
  assert.match(styles, /\.system-list/);
  assert.match(styles, /--primary: #2563eb/);
  assert.doesNotMatch(styles, /#2ad696/i);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /class="auth-proof"/);
  assert.match(html, /class="motion-scene"/);
  assert.match(html, /name="theme-color" content="#2563eb"/);
  assert.match(html, /id="android-app-download"/);
  assert.match(html, /\/downloads\/AttenDesk-student\.apk/);
  assert.match(webApp, /APK_NOT_PUBLISHED/);
  assert.match(android, /private fun loadingPanel/);
  assert.match(android, /private fun setAnimatedContent/);
  assert.match(android, /0xFF2563EB/);
  assert.doesNotMatch(android, /Continue as teacher|showTeacher|startTeacher/);
  assert.match(webApp, /navigator\.bluetooth\.requestDevice/);
  assert.match(webApp, /BarcodeDetector/);
  assert.match(bleManager, /ScanFilter/);
  assert.match(bleManager, /startScan\(filters, settings/);
  assert.doesNotMatch(bleManager, /BluetoothGattServer|AdvertiseCallback|startTeacherBroadcast/);
  assert.doesNotMatch(androidManifest, /BLUETOOTH_ADVERTISE|BLUETOOTH_CONNECT/);
  assert.match(webBluetoothMigration, /barcode_web_ble/);
  assert.match(demoApp, /startViewTransition/);
  assert.match(demoStyles, /\.depth-surface/);
  assert.match(demoHtml, /class="hero-orbit"/);
});

test("Vercel routes every request to an /api function, which is what fixes the 404", async () => {
  const [entry, vercelConfig, html] = await Promise.all([
    fs.readFile(new URL("../../api/index.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../../vercel.json", import.meta.url), "utf8"),
    fs.readFile(new URL("../../public/index.html", import.meta.url), "utf8")
  ]);
  const config = JSON.parse(vercelConfig);
  // Vercel only turns files under /api into Functions. A root-level export is
  // never picked up, which is exactly why the previous release 404'd.
  assert.match(entry, /createProductionApp/);
  assert.match(entry, /export default/);
  assert.ok(config.functions["api/index.js"], "api/index.js must be declared as a Function");
  assert.match(config.functions["api/index.js"].includeFiles, /public/, "the static site must be bundled into the Function");
  assert.ok(config.rewrites.some((rule) => rule.destination === "/api/index"), "traffic must be rewritten to the Function");
  assert.ok(Array.isArray(config.headers));
  assert.match(html, /AttenDesk/);
});

test("the service worker never caches attendance traffic", async () => {
  const worker = await fs.readFile(new URL("../../public/sw.js", import.meta.url), "utf8");
  assert.match(worker, /pathname\.startsWith\('\/api\/'\)/);
  assert.doesNotMatch(worker, /cache\.addAll\(\[[^\]]*\/api/);
});

test("no inline script survives the Content-Security-Policy", async () => {
  const html = await fs.readFile(new URL("../../public/index.html", import.meta.url), "utf8");
  // security.js sends script-src 'self', so an inline <script> would be blocked.
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/);
});
