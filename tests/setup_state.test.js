/** tests/setup_state.test.js — setup state persistence + license gating. Run: node --test tests/ */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../setup/state.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lr-setup-'));
const read = (d) => fs.readFileSync(S.statePath(d), 'utf8');

test('fresh: missing file gives default, incomplete state', () => {
  const r = S.load(path.join(tmpDir(), 'does-not-exist'));
  assert.strictEqual(r.fresh, true);
  assert.deepStrictEqual(r.state, S.defaultState());
  assert.strictEqual(r.state.setupComplete, false);
  assert.strictEqual(S.needsSetup(r.state, '1.0'), true);
});

test('corrupt JSON / wrong shape / newer schema => fresh state, no throw', () => {
  const d = tmpDir();
  for (const bad of ['{not json', '', '[]', 'null', '{"schemaVersion":"1"}', '{"schemaVersion":99,"setupComplete":true}']) {
    fs.writeFileSync(S.statePath(d), bad);
    const r = S.load(d);
    assert.strictEqual(r.fresh, true, bad);
    assert.strictEqual(r.state.setupComplete, false, bad);
  }
  fs.writeFileSync(S.statePath(d), '{"schemaVersion":1,"setupComplete":"yes","components":[]}');
  const r = S.load(d);
  assert.strictEqual(r.state.setupComplete, false);
  assert.deepStrictEqual(r.state.components, {});
});

test('atomic write: round-trips, leaves no temp file, creates the folder', () => {
  const d = path.join(tmpDir(), 'nested', 'userData');
  const st = S.acceptLicense(S.defaultState(), '1.0', '1.0.0', new Date('2026-01-02T03:04:05Z'));
  assert.deepStrictEqual(S.save(d, st), { ok: true });
  assert.deepStrictEqual(fs.readdirSync(d), [S.FILE_NAME]);
  const back = S.load(d).state;
  assert.strictEqual(back.acceptedLicenseVersion, '1.0');
  assert.strictEqual(back.acceptedAt, '2026-01-02T03:04:05.000Z');
  assert.strictEqual(back.appVersion, '1.0.0');
  assert.strictEqual(back.schemaVersion, S.SCHEMA_VERSION);
});

test('atomic write: failed rename keeps the old file, cleans the temp file, returns a readable error', () => {
  const d = tmpDir();
  S.save(d, S.acceptLicense(S.defaultState(), '1.0', '1.0.0'));
  const before = read(d);
  const failing = Object.assign({}, fs, { renameSync() { const e = new Error('denied'); e.code = 'EACCES'; throw e; } });
  const res = S.save(d, S.markComplete(S.defaultState()), failing);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /permission/i);
  assert.strictEqual(read(d), before);
  assert.deepStrictEqual(fs.readdirSync(d), [S.FILE_NAME]);
  const disk = Object.assign({}, fs, { writeSync() { const e = new Error('full'); e.code = 'ENOSPC'; throw e; } });
  assert.match(S.save(d, S.defaultState(), disk).error, /disk is full/i);
  assert.strictEqual(read(d), before);
});

test('unreadable state file is reported as a message, not thrown', () => {
  const failing = Object.assign({}, fs, { readFileSync() { const e = new Error('x'); e.code = 'EACCES'; throw e; } });
  const r = S.load(tmpDir(), failing);
  assert.strictEqual(r.fresh, true);
  assert.match(r.error, /permission/i);
});

test('accepting stores version/time but never sets setupComplete', () => {
  const st = S.acceptLicense(S.defaultState(), '1.0', '1.0.0');
  assert.strictEqual(st.acceptedLicenseVersion, '1.0');
  assert.ok(!Number.isNaN(Date.parse(st.acceptedAt)));
  assert.strictEqual(st.setupComplete, false);
  assert.strictEqual(S.needsSetup(st, '1.0'), true);          // still incomplete until the final step
  assert.strictEqual(S.needsSetup(S.markComplete(st), '1.0'), false);
});

test('license version bump re-prompts even when setup was complete', () => {
  const done = S.markComplete(S.acceptLicense(S.defaultState(), '1.0', '1.0.0'));
  assert.strictEqual(S.needsSetup(done, '1.0'), false);
  assert.strictEqual(S.isLicenseCurrent(done, '1.0'), true);
  assert.strictEqual(S.needsSetup(done, '1.1'), true);
  assert.strictEqual(S.isLicenseCurrent(done, '1.1'), false);
  assert.strictEqual(S.needsSetup(done, null), true);          // unreadable license.json => wizard
});

test('decline leaves state incomplete and untouched', () => {
  const d = tmpDir();
  // Previously accepted an older license; declining the new one must not write anything.
  S.save(d, S.markComplete(S.acceptLicense(S.defaultState(), '0.9', '1.0.0')));
  const before = read(d);
  const loaded = S.load(d).state;   // wizard opens; user declines => no save() call
  assert.strictEqual(read(d), before);
  assert.strictEqual(S.isLicenseCurrent(loaded, '1.0'), false);
  // Fresh install + decline: no file is ever created.
  const d2 = tmpDir();
  S.load(d2);
  assert.strictEqual(fs.existsSync(S.statePath(d2)), false);
  // The decline IPC handler in main.js must not write state or mark completion.
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const i = main.indexOf("ipcMain.handle('setup:decline'");
  const block = main.slice(i, main.indexOf('\nipcMain.', i + 10));
  assert.ok(i > 0 && block.length > 50);
  assert.ok(!/save\(|acceptLicense|markComplete|setupComplete|writeFile/.test(block));
});

test('license text and version come from files; text ends with the end marker', () => {
  const root = path.join(__dirname, '..');
  const v = S.readLicenseVersion(path.join(root, 'setup', 'license.json'));
  assert.ok(v && typeof v === 'string');
  const t = S.readLicenseText(path.join(root, 'LICENSE.txt'));
  assert.strictEqual(t.ok, true);
  assert.ok(t.text.trimEnd().endsWith('End of License Agreement'));
  assert.strictEqual(S.readLicenseText(path.join(root, 'nope.txt')).ok, false);
  assert.strictEqual(S.readLicenseVersion(path.join(root, 'nope.json')), null);
  assert.ok(!/End of License Agreement/.test(fs.readFileSync(path.join(root, 'setup', 'setup.html'), 'utf8')), 'license must not be hard-coded in HTML');
});

test('pdfSkipped is persisted and normalized', () => {
  const d = tmpDir();
  const st = S.setPdfSkipped(S.defaultState(), true);
  assert.strictEqual(st.pdfSkipped, true);
  assert.strictEqual(st.components.libreoffice.pdfSkipped, true);
  S.save(d, st);
  const loaded = S.load(d).state;
  assert.strictEqual(loaded.pdfSkipped, true);
  assert.strictEqual(loaded.components.libreoffice.pdfSkipped, true);
});

test('checkManagedLibreOffice: cheap exists check on managed install', () => {
  const d = tmpDir();
  const fakeSoffice = path.join(d, 'soffice');
  
  // Unmanaged / not installed
  assert.deepStrictEqual(S.checkManagedLibreOffice(d, S.defaultState()), { managed: false, exists: false, path: null });
  
  // Path install (system / external)
  const pathState = S.setComponent(S.defaultState(), 'libreoffice', { source: 'path', path: '/usr/bin/soffice' });
  assert.deepStrictEqual(S.checkManagedLibreOffice(d, pathState), { managed: false, exists: false, path: null });

  // Managed install recorded, file exists
  fs.writeFileSync(fakeSoffice, 'binary');
  const managedState = S.setComponent(S.defaultState(), 'libreoffice', { source: 'managed', path: fakeSoffice });
  assert.deepStrictEqual(S.checkManagedLibreOffice(d, managedState), { managed: true, exists: true, path: fakeSoffice });

  // Managed install deleted
  fs.unlinkSync(fakeSoffice);
  assert.deepStrictEqual(S.checkManagedLibreOffice(d, managedState), { managed: true, exists: false, path: fakeSoffice });
});

test('markComplete atomic persistence: marks setupComplete without mutating other state', () => {
  const d = tmpDir();
  const initial = S.acceptLicense(S.defaultState(), '1.0', '1.0.0');
  const withComp = S.setComponent(initial, 'libreoffice', { source: 'managed', path: '/path/to/soffice', status: 'installed' });
  
  assert.strictEqual(withComp.setupComplete, false);
  const completed = S.markComplete(withComp);
  assert.strictEqual(completed.setupComplete, true);
  assert.strictEqual(completed.acceptedLicenseVersion, '1.0');
  assert.strictEqual(completed.components.libreoffice.path, '/path/to/soffice');

  // Verify save and reload
  const saveRes = S.save(d, completed);
  assert.strictEqual(saveRes.ok, true);
  const reloaded = S.load(d).state;
  assert.strictEqual(reloaded.setupComplete, true);
  assert.strictEqual(S.needsSetup(reloaded, '1.0'), false);
});

test('early close never marks complete: closing window before completion leaves setupComplete false', () => {
  const d = tmpDir();
  const state = S.acceptLicense(S.defaultState(), '1.0', '1.0.0');
  S.save(d, state);

  // In main.js, window close without setup:complete never invokes markComplete
  const loaded = S.load(d).state;
  assert.strictEqual(loaded.setupComplete, false);
  assert.strictEqual(S.needsSetup(loaded, '1.0'), true);

  // Verify main.js close window control does not call markComplete or save
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const i = main.indexOf("ipcMain.on('setup:window-control'");
  const block = main.slice(i, main.indexOf('app.on', i));
  assert.ok(!/markComplete|setupComplete|save\(/.test(block));
});
