import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('admin directory supports administrators, grouped student batches and barcode diagnostics', async () => {
  const [app, server, migration] = await Promise.all([
    fs.readFile(new URL('../../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/production-app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../migrations/008_admin_directory_and_batches.sql', import.meta.url), 'utf8')
  ]);
  assert.match(app, /Administrators/);
  assert.match(app, /studentDirectoryMarkup/);
  assert.match(app, /Admission batch/);
  assert.match(app, /data-test-barcode/);
  assert.match(server, /\/api\/admin\/barcodes\/verify/);
  assert.match(server, /LAST_ADMIN_REQUIRED/);
  assert.match(server, /role IN \('admin','teacher','student'\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS batch_year/);
});

test('student Android app checks a stable update manifest and CI produces signed update files', async () => {
  const [activity, client, gradle, workflow, manifest] = await Promise.all([
    fs.readFile(new URL('../../android/app/src/main/java/in/attendesk/app/MainActivity.kt', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../android/app/src/main/java/in/attendesk/app/ApiClient.kt', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../android/app/build.gradle.kts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../.github/workflows/android-apk.yml', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../public/android-update.json', import.meta.url), 'utf8')
  ]);
  assert.match(activity, /checkForAppUpdate/);
  assert.match(client, /\/android-update\.json/);
  assert.match(gradle, /ATTENDESK_VERSION_CODE/);
  assert.match(workflow, /assembleRelease/);
  assert.match(workflow, /ANDROID_KEYSTORE_BASE64/);
  assert.doesNotThrow(() => JSON.parse(manifest));
});
