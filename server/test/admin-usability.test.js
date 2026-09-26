import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const jsonResponse = (payload, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => 'application/json' },
  json: async () => payload
});

test('a fresh admin can open People and create the first student directly', async () => {
  const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://attendesk.test', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.confirm = () => true;
  w.sessionStorage.setItem('attendesk_access', 'admin-token');
  w.sessionStorage.setItem('attendesk_refresh', 'refresh-token');
  w.sessionStorage.setItem('attendesk_user', JSON.stringify({
    id: 'admin-1', role: 'admin', full_name: 'Akshat Admin', email: 'admin@hbtu.ac.in'
  }));

  const branch = { id: 'branch-1', code: 'FT', name: 'Food Technology', active: true };
  const semester = { id: 'semester-1', number: 1, academic_year: '2026-27', active: true };
  const section = { id: 'section-1', name: 'A', branch_id: branch.id, semester_id: semester.id, branch_code: 'FT', semester_number: 1, active: true };
  let createdBody;
  w.fetch = async (url, options = {}) => {
    if (url === '/api/admin/overview') return jsonResponse({ students: 0, teachers: 0, registrations: 0, device_requests: 0, sessions_today: 0, branches: 1, semesters: 1, sections: 1, subjects: 0, offerings: 0, classrooms: 0, beacons: 0 });
    if (url === '/api/admin/people?role=student') return jsonResponse([]);
    if (url === '/api/admin/academic/branches') return jsonResponse([branch]);
    if (url === '/api/admin/academic/semesters') return jsonResponse([semester]);
    if (url === '/api/admin/sections') return jsonResponse([section]);
    if (url === '/api/admin/people' && options.method === 'POST') {
      createdBody = JSON.parse(options.body);
      return jsonResponse({ user: { id: 'student-1' }, loginIdentifier: '250107001' }, 201);
    }
    throw new Error(`Unexpected request ${options.method || 'GET'} ${url}`);
  };

  w.eval(js);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(w.document.querySelector('#page-content').textContent, /First-time setup/);

  w.document.querySelector('[data-page="people"]').click();
  await new Promise(resolve => setTimeout(resolve, 40));
  const add = w.document.querySelector('[data-add-person="student"]');
  assert.ok(add, 'student creation must be available on an empty database');
  add.click();
  await new Promise(resolve => setTimeout(resolve, 40));

  const form = w.document.querySelector('#person-form');
  assert.ok(form, 'student creation form should open');
  form.querySelector('[name="fullName"]').value = 'Test Student';
  form.querySelector('[name="email"]').value = 'student@hbtu.ac.in';
  form.querySelector('[name="rollNumber"]').value = '250107001';
  form.querySelector('[name="barcode"]').value = '1234567890';
  form.querySelector('[name="password"]').value = 'Student99';
  form.dispatchEvent(new w.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: form.querySelector('button[type="submit"]') }));
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(createdBody.role, 'student');
  assert.equal(createdBody.branchId, undefined);
  assert.equal(createdBody.semesterId, undefined);
  assert.equal(createdBody.sectionId, section.id);
  assert.equal(createdBody.barcode, '1234567890');
  w.close();
});
