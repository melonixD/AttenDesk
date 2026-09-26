import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const response = payload => ({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => payload });
const wait = () => new Promise(resolve => setTimeout(resolve, 45));

test('admin can open bulk imports, corrections and filtered reports', async () => {
  const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://attendesk.test', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: true, addEventListener() {} });
  w.sessionStorage.setItem('attendesk_access', 'admin-token');
  w.sessionStorage.setItem('attendesk_user', JSON.stringify({ id: 'admin-1', role: 'admin', full_name: 'Admin User', email: 'admin@hbtu.ac.in' }));
  const branch = { id: 'b1', code: 'CSE', name: 'Computer Science', active: true };
  const semester = { id: 'sem1', number: 1, academic_year: '2026-27', active: true };
  const section = { id: 'sec1', name: 'A', branch_id: 'b1', branch_code: 'CSE', semester_id: 'sem1', semester_number: 1, active: true };
  const subject = { id: 'sub1', code: 'CS101', name: 'Programming', credits: 4, active: true };
  w.fetch = async url => {
    if (url === '/api/admin/overview') return response({ students: 1, teachers: 1, registrations: 0, device_requests: 0, sessions_today: 0, branches: 1, semesters: 1, sections: 1, subjects: 1, offerings: 0, classrooms: 0, beacons: 0 });
    if (url === '/api/admin/attendance/sessions') return response([]);
    if (url === '/api/admin/attendance/appeals?status=pending') return response([]);
    if (url === '/api/admin/academic/branches') return response([branch]);
    if (url === '/api/admin/academic/semesters') return response([semester]);
    if (url === '/api/admin/sections') return response([section]);
    if (url === '/api/admin/academic/subjects') return response([subject]);
    if (url === '/api/admin/offerings') return response([]);
    throw new Error(`Unexpected request ${url}`);
  };

  w.eval(js);
  await wait();
  w.document.querySelector('[data-page="bulk-import"]').click();
  await wait();
  assert.equal(w.document.querySelectorAll('[data-open-import]').length, 6);
  w.document.querySelector('[data-open-import="subjects"]').click();
  assert.ok(w.document.querySelector('#bulk-import-form'));
  assert.match(w.document.querySelector('#modal-content').textContent, /subject_code,subject_name,credits/);
  w.document.querySelector('[data-action="close-modal"]').click();

  w.document.querySelector('[data-page="corrections"]').click();
  await wait();
  assert.ok(w.document.querySelector('#correction-filter-form'));
  assert.match(w.document.querySelector('#page-content').textContent, /No attendance appeals are waiting/);

  w.document.querySelector('[data-page="reports"]').click();
  await wait();
  assert.ok(w.document.querySelector('#report-filter-form'));
  assert.equal(w.document.querySelector('#report-filter-form [name="branchId"]').options.length, 2);
  w.close();
});
