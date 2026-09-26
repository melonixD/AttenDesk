import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProductionApp } from '../src/production-app.js';
import { issueAccessToken, verifyPassword } from '../src/security.js';

const AUTH_SECRET = 'admin-api-test-auth-secret-longer-than-thirty-two';
process.env.AUTH_SECRET = AUTH_SECRET;
process.env.OTP_SECRET = 'admin-api-test-otp-secret-longer-than-thirty-two';
process.env.BARCODE_PEPPER = 'admin-api-test-barcode-secret-longer-than-thirty-two';

const ORG = '10000000-0000-4000-8000-000000000001';
const ADMIN = '10000000-0000-4000-8000-000000000002';
const STUDENT = '10000000-0000-4000-8000-000000000003';
let storedPasswordHash;
let storedBarcodeHash;
let storedAcademicAssignment;
let assignmentLookupSql;

const admin = { id: ADMIN, organization_id: ORG, email: 'admin@hbtu.ac.in', full_name: 'Admin User', role: 'admin', status: 'active' };
const db = {
  async query(sql, params = []) {
    if (sql.startsWith('SELECT id, organization_id, email')) return { rowCount: 1, rows: [admin] };
    if (sql.startsWith('SELECT id,email_domain FROM organizations')) return { rowCount: 1, rows: [{ id: ORG, email_domain: 'hbtu.ac.in' }] };
    if (sql.includes('FROM sections sc JOIN branches')) {
      assignmentLookupSql = sql;
      return { rowCount: 1, rows: [{ section_id: params[0], branch_id: 'branch-1', semester_id: 'semester-1' }] };
    }
    throw new Error(`Unexpected outer query: ${sql.slice(0, 100)}`);
  },
  async transaction(work) {
    return work({
      async query(sql, params = []) {
        if (sql.startsWith('INSERT INTO users')) {
          storedPasswordHash = params[5];
          return { rowCount: 1, rows: [{ id: STUDENT, organization_id: ORG, email: params[1], username: params[2], full_name: params[3], role: params[4], status: 'active' }] };
        }
        if (sql.startsWith('INSERT INTO students')) {
          storedAcademicAssignment = { branchId: params[2], semesterId: params[3], sectionId: params[4] };
          return { rowCount: 1, rows: [] };
        }
        if (sql.startsWith('INSERT INTO barcode_registrations')) { storedBarcodeHash = params[1]; return { rowCount: 1, rows: [] }; }
        if (sql.startsWith('INSERT INTO audit_logs')) return { rowCount: 1, rows: [] };
        throw new Error(`Unexpected transaction query: ${sql.slice(0, 100)}`);
      }
    });
  }
};

test('admin can directly create a usable student account with a protected barcode', async () => {
  const app = createProductionApp({ db, mailer: { sendOtp: async () => ({ delivered: true }) } });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const token = issueAccessToken(AUTH_SECRET, { sub: ADMIN, org: ORG, role: 'admin' });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/people`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        role: 'student', fullName: 'Test Student', email: 'student@hbtu.ac.in', rollNumber: '250107001',
        branchId: 'stale-branch', semesterId: 'stale-semester', sectionId: 'section-1', password: 'Student99', barcode: '1234567890'
      })
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.loginIdentifier, '250107001');
    assert.ok(verifyPassword('Student99', storedPasswordHash));
    assert.ok(storedBarcodeHash && !storedBarcodeHash.includes('1234567890'));
    assert.deepEqual(storedAcademicAssignment, { branchId: 'branch-1', semesterId: 'semester-1', sectionId: 'section-1' });
    assert.doesNotMatch(assignmentLookupSql, /b\.active=true/, 'direct admin creation must tolerate an accidentally archived parent record');
    assert.equal('password_hash' in body.user, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
