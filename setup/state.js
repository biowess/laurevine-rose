'use strict';
/* setup/state.js — persistent setup state (userData/setup-state.json). Pure Node (no Electron) so it is unit-testable.
   Nothing here throws into the caller: load() falls back to a fresh state, save() returns {ok, error}. */
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const FILE_NAME = 'setup-state.json';

function defaultState() {
  return { schemaVersion: SCHEMA_VERSION, setupComplete: false, acceptedLicenseVersion: null, acceptedAt: null, appVersion: null, components: {} };
}

function statePath(dir) { return path.join(dir, FILE_NAME); }

function describeError(err, dir, verb) {
  const code = err && err.code;
  const what = verb === 'read' ? "read its saved progress" : "save its progress";
  if (code === 'EACCES' || code === 'EPERM') return "Setup can't " + what + " because Laurevine Rose doesn't have permission to use its settings folder (" + dir + "). Check the folder permissions and try again.";
  if (code === 'ENOSPC') return "Setup can't " + what + " because the disk is full. Free some space and try again.";
  if (code === 'EROFS') return "Setup can't " + what + " because the settings folder is read-only (" + dir + ").";
  return "Setup couldn't " + what + (code ? ' (' + code + ')' : '') + '. Please try again.';
}

// Validate/coerce parsed JSON. Returns null when it cannot be trusted (caller then starts fresh).
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion < 1 || raw.schemaVersion > SCHEMA_VERSION) return null;
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const comps = raw.components && typeof raw.components === 'object' && !Array.isArray(raw.components) ? raw.components : {};
  const out = {
    schemaVersion: SCHEMA_VERSION,
    setupComplete: raw.setupComplete === true,
    acceptedLicenseVersion: str(raw.acceptedLicenseVersion),
    acceptedAt: str(raw.acceptedAt),
    appVersion: str(raw.appVersion),
    components: comps
  };
  if (raw.pdfSkipped === true) out.pdfSkipped = true;
  return out;
}

// -> { state, fresh, corrupt?, error? }. Missing, corrupt or unreadable file => fresh state.
function load(dir, fsImpl) {
  const f = fsImpl || fs;
  let text;
  try {
    text = f.readFileSync(statePath(dir), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: defaultState(), fresh: true };
    return { state: defaultState(), fresh: true, error: describeError(e, dir, 'read') };
  }
  let parsed;
  try { parsed = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch (e) { return { state: defaultState(), fresh: true, corrupt: true }; }
  const state = normalize(parsed);
  if (!state) return { state: defaultState(), fresh: true, corrupt: true };
  return { state, fresh: false };
}

// Atomic write: temp file in the same folder, fsync, rename over the target. -> { ok } | { ok:false, error }.
function save(dir, state, fsImpl) {
  const f = fsImpl || fs;
  const file = statePath(dir);
  const tmp = file + '.' + process.pid + '.tmp';
  let fd = null;
  try {
    const clean = normalize(Object.assign({}, state, { schemaVersion: SCHEMA_VERSION })) || defaultState();
    f.mkdirSync(dir, { recursive: true });
    fd = f.openSync(tmp, 'w');
    f.writeSync(fd, JSON.stringify(clean, null, 2) + '\n');
    f.fsyncSync(fd);
    f.closeSync(fd);
    fd = null;
    f.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    if (fd !== null) { try { f.closeSync(fd); } catch (_) {} }
    try { f.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: describeError(e, dir, 'save') };
  }
}

function isLicenseCurrent(state, licenseVersion) {
  return licenseVersion != null && !!state && state.acceptedLicenseVersion === String(licenseVersion);
}

// Wizard is required until setup is complete AND the accepted license is the current one.
function needsSetup(state, licenseVersion) {
  return !state || state.setupComplete !== true || !isLicenseCurrent(state, licenseVersion);
}

// Accepting the license never sets setupComplete (that happens only at the final wizard step).
function acceptLicense(state, licenseVersion, appVersion, now) {
  return Object.assign({}, state, {
    acceptedLicenseVersion: String(licenseVersion),
    acceptedAt: (now || new Date()).toISOString(),
    appVersion: appVersion || state.appVersion || null
  });
}

// Records one component's detection result under state.components[name] (no downloads; just what was found).
function setComponent(state, name, value) {
  return Object.assign({}, state, { components: Object.assign({}, state.components, { [name]: value }) });
}

function markComplete(state) { return Object.assign({}, state, { setupComplete: true }); }

function setPdfSkipped(state, skipped) {
  const isSkipped = skipped !== false;
  const next = Object.assign({}, state);
  if (isSkipped) next.pdfSkipped = true;
  else delete next.pdfSkipped;
  const comps = Object.assign({}, next.components || {});
  comps.libreoffice = Object.assign({}, comps.libreoffice || {}, { pdfSkipped: isSkipped });
  next.components = comps;
  return next;
}

function readLicenseVersion(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).version;
    return (typeof v === 'string' || typeof v === 'number') && String(v) ? String(v) : null;
  } catch (e) { return null; }
}

function readLicenseText(file) {
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') };
  } catch (e) {
    return { ok: false, error: "The license text could not be loaded. Please reinstall Laurevine Rose or contact the publisher." };
  }
}

function checkManagedLibreOffice(userDataDir, state, fsImpl) {
  const f = fsImpl || fs;
  const lo = (state && state.components && state.components.libreoffice) || null;
  if (!lo || lo.source !== 'managed' || !lo.path) {
    return { managed: false, exists: false, path: null };
  }
  const exists = f.existsSync(lo.path);
  return { managed: true, exists, path: lo.path };
}

module.exports = { SCHEMA_VERSION, FILE_NAME, defaultState, statePath, load, save, isLicenseCurrent, needsSetup, acceptLicense, setComponent, setPdfSkipped, markComplete, readLicenseVersion, readLicenseText, checkManagedLibreOffice };
