import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { createProductionApp } from '../src/production-app.js';
import { acceptableRotatingCodes, issueAccessToken } from '../src/security.js';

const AUTH_SECRET = 'dual-beacon-test-auth-secret-longer-than-thirty-two';
const ORG = '20000000-0000-4000-8000-000000000001';
const TEACHER = '20000000-0000-4000-8000-000000000002';
const CLASSROOM = '20000000-0000-4000-8000-000000000003';
const BEACON = '20000000-0000-4000-8000-000000000004';
const SESSION = '20000000-0000-4000-8000-000000000005';

process.env.AUTH_SECRET = AUTH_SECRET;
process.env.OTP_SECRET = 'dual-beacon-test-otp-secret-longer-than-thirty-two';
process.env.BARCODE_PEPPER = 'dual-beacon-test-barcode-secret-longer-than-32';
process.env.REQUIRE_ESP32 = 'true';
process.env.ENFORCE_TIMETABLE = 'false';

const teacher = { id: TEACHER, organization_id: ORG, email: 'teacher@hbtu.ac.in', full_name: 'Teacher', role: 'teacher', status: 'active' };

function testDb() {
  return {
    async query(sql, params = []) {
      if (sql.startsWith('SELECT id, organization_id, email')) return { rowCount: 1, rows: [teacher] };
      if (sql.startsWith('SELECT * FROM course_offerings')) return { rowCount: 1, rows: [{ id: 'offering-1', teacher_id: TEACHER, organization_id: ORG, default_room: '210' }] };
      if (sql.startsWith('SELECT id, room_number, min_rssi FROM classrooms')) return { rowCount: 1, rows: [{ id: CLASSROOM, room_number: '210', min_rssi: -92 }] };
      if (sql.startsWith('SELECT id, beacon_code, label, last_seen_at')) return { rowCount: 1, rows: [{ id: BEACON, beacon_code: 'ATTENDESK-210', label: 'Room 210 beacon', last_seen_at: null, status: 'provisioned' }] };
      if (sql.includes('FROM attendance_sessions a JOIN course_offerings o ON o.id=a.offering_id JOIN subjects su')) {
        return { rowCount: 1, rows: [{ id: SESSION, teacher_id: TEACHER, starts_at: new Date(), ends_at: new Date(Date.now() + 180_000), status: 'active', room: '210', beacon_transport: 'bluetooth', offering_id: 'offering-1', organization_id: ORG, subject: 'Fluid Mechanics', subject_code: 'FT-201', branch: 'Food Technology', section: 'A', teacher: 'Teacher' }] };
      }
      if (sql.includes('FROM student_enrollments e JOIN students')) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected outer query: ${sql.slice(0, 100)} ${JSON.stringify(params)}`);
    },
    async transaction(work) {
      return work({
        async query(sql, params = []) {
          if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
          if (sql.startsWith('SELECT id FROM attendance_sessions WHERE teacher_id')) return { rowCount: 0, rows: [] };
          if (sql.includes("WHERE o.organization_id=$1 AND a.status='active'")) return { rowCount: 0, rows: [] };
          if (sql.startsWith('INSERT INTO attendance_sessions')) {
            assert.equal(params[8], 'bluetooth');
            return { rowCount: 1, rows: [{ id: SESSION }] };
          }
          if (sql.startsWith('INSERT INTO audit_logs')) return { rowCount: 1, rows: [] };
          throw new Error(`Unexpected transaction query: ${sql.slice(0, 100)}`);
        }
      });
    }
  };
}

test('direct Bluetooth starts with an offline ESP32 and returns rotating codes', async () => {
  const app = createProductionApp({ db: testDb(), mailer: { sendOtp: async () => ({}) } });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const token = issueAccessToken(AUTH_SECRET, { sub: TEACHER, org: ORG, role: 'teacher', clientType: 'web' });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/attendance/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ offeringId: 'offering-1', room: '210', durationSeconds: 180, beaconTransport: 'bluetooth', beaconCode: 'ATTENDESK-210' })
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.beaconTransport, 'bluetooth');
    assert.equal(body.directProvisioning.version, 1);
    assert.ok(body.directProvisioning.codes.length >= 6);
    assert.ok(acceptableRotatingCodes(AUTH_SECRET, SESSION).includes(body.directProvisioning.codes[0]));
    assert.equal(body.beaconWarning, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('dual-mode firmware and teacher UI expose direct provisioning controls', async () => {
  const [firmware, ui, migration] = await Promise.all([
    readFile(new URL('../../firmware/attendesk_beacon/attendesk_beacon.ino', import.meta.url), 'utf8'),
    readFile(new URL('../../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/007_dual_beacon_transport.sql', import.meta.url), 'utf8')
  ]);
  assert.match(firmware, /NIMBLE_PROPERTY::READ \| NIMBLE_PROPERTY::WRITE/);
  assert.match(firmware, /directNextRotation/);
  assert.match(firmware, /IDENTITY_UUID/);
  assert.match(ui, /Direct Bluetooth/);
  assert.match(ui, /writeValueWithResponse/);
  assert.match(migration, /beacon_transport IN \('wifi', 'bluetooth'\)/);
});

