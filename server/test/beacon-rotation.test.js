import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ROTATION_SECONDS,
  acceptableRotatingCodes,
  hashPassword,
  passwordProblem,
  rotatingCode,
  verifyPassword
} from "../src/security.js";

const SECRET = "test-auth-secret-that-is-longer-than-32-characters";
const SESSION = "11111111-1111-4111-8111-111111111111";

test("a rotating beacon code changes every window and is session-specific", () => {
  const now = Date.now();
  const window = Math.floor(now / 1000 / ROTATION_SECONDS);

  const code = rotatingCode(SECRET, SESSION, window);
  assert.match(code, /^[a-f0-9]{16}$/, "must fit in 8 bytes of BLE service data");
  assert.notEqual(code, rotatingCode(SECRET, SESSION, window + 1), "code must change between windows");
  assert.notEqual(code, rotatingCode(SECRET, "22222222-2222-4222-8222-222222222222", window));
  assert.notEqual(code, rotatingCode("a-different-secret-of-at-least-32-chars!", SESSION, window));
});

test("a code from two windows ago is rejected, which is what stops forwarding", () => {
  const now = Date.now();
  const accepted = acceptableRotatingCodes(SECRET, SESSION, now);
  const window = Math.floor(now / 1000 / ROTATION_SECONDS);

  assert.equal(accepted.length, 2, "current plus one grace window");
  assert.ok(accepted.includes(rotatingCode(SECRET, SESSION, window)));
  assert.ok(accepted.includes(rotatingCode(SECRET, SESSION, window - 1)));
  assert.ok(!accepted.includes(rotatingCode(SECRET, SESSION, window - 2)),
    "a code older than the grace window must not mark attendance");
});

test("passwords are salted, never stored in the clear, and compared safely", () => {
  const stored = hashPassword("Alakh7u8");
  assert.ok(!stored.includes("Alakh7u8"));
  assert.match(stored, /^scrypt\$/);
  assert.ok(verifyPassword("Alakh7u8", stored));
  assert.ok(!verifyPassword("alakh7u8", stored), "comparison is case-sensitive");
  assert.ok(!verifyPassword("", stored));
  assert.ok(!verifyPassword("Alakh7u8", "not-a-real-hash"));
  assert.notEqual(hashPassword("Alakh7u8"), stored, "each hash uses a fresh salt");
});

test("weak passwords are refused before they are ever hashed", () => {
  assert.ok(passwordProblem("short1"));
  assert.ok(passwordProblem("allletters"));
  assert.ok(passwordProblem("12345678"));
  assert.equal(passwordProblem("Alakh7u8"), null);
  assert.equal(passwordProblem("7u87u87u8x"), null);
});
