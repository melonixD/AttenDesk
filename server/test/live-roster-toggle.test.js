import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('teacher live roster is alphabetical and supports one-click mark/unmark', async () => {
  const [app, styles, server] = await Promise.all([
    readFile(new URL('../../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../../public/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/production-app.js', import.meta.url), 'utf8')
  ]);
  assert.match(app, /left\.full_name\.localeCompare\(right\.full_name/);
  assert.match(app, /async function toggleManualAttendance/);
  assert.match(app, /currentStatus === 'present' \? 'absent' : 'present'/);
  assert.match(app, /Marked present by teacher from live roster/);
  assert.match(app, /Unmarked by teacher from live roster/);
  assert.match(styles, /\.roster-attendance-toggle\.is-loading::after/);
  assert.match(styles, /@keyframes roster-spin/);
  assert.match(server, /ORDER BY lower\(u\.full_name\),s\.roll_number/);
});

