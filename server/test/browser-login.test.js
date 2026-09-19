import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('login UI boots, switches roles and submits both credential forms', async () => {
  const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://attendesk.test', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  const calls = [];
  w.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { status: 401, ok: false, headers: { get: () => 'application/json' }, json: async () => ({ error: 'INVALID_CREDENTIALS', message: 'Test rejection' }) };
  };
  w.sessionStorage.setItem('attendesk_user', 'broken json');
  w.eval(js);
  w.document.querySelector('[data-login-mode="admin"]').click();
  assert.equal(w.document.querySelector('#staff-login-form').classList.contains('hidden'), false);
  w.document.querySelector('#staff-identifier').value = 'melonix';
  w.document.querySelector('#staff-password').value = 'ExamplePass99';
  w.document.querySelector('#staff-login-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls[0].url, '/api/auth/login');
  assert.equal(calls[0].body.identifier, 'melonix');
  assert.equal(w.document.querySelector('#auth-message').textContent, 'Test rejection');
  w.document.querySelector('[data-login-mode="student"]').click();
  w.document.querySelector('#student-name').value = 'Test Student';
  w.document.querySelector('#student-roll').value = '123456';
  w.document.querySelector('#student-password').value = 'StudentPass99';
  w.document.querySelector('#student-login-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls[1].url, '/api/auth/student-login');
  assert.equal(calls[1].body.password, 'StudentPass99');
  assert.ok(calls[1].body.installationId);
  w.close();
});
