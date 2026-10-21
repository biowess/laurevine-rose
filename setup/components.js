'use strict';
/* setup/components.js — backend resolution + Components screen checks. Pure Node (no Electron): callers pass app facts in.
   Nothing here throws into the caller; every check resolves to {id, label, required, status: 'ok'|'fail'|'info', detail}. */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SELFCHECK_TIMEOUT_MS = 60000;
const DETECT_TIMEOUT_MS = 30000; // backend probe allows 20 s for `soffice --version`
const FONT_FILE = /\.(ttf|otf|woff2?)$/i;

// Packaged: the bundled PyInstaller backend in <resources>/backend (never a system Python).
// Unpackaged (dev): system python3 + run.py, or the AppImage python when APPDIR provides one.
// -> { packaged, cmd, args, cwd, missing } (missing = path of the absent bundled binary, else null)
function resolveBackend(o) {
  const f = o.fs || fs;
  if (o.isPackaged) {
    const exe = path.join(o.resourcesPath, 'backend', (o.platform || process.platform) === 'win32' ? 'run.exe' : 'run');
    return { packaged: true, cmd: exe, args: [], cwd: path.dirname(exe), missing: f.existsSync(exe) ? null : exe };
  }
  let py = 'python3';
  const appdir = (o.env || process.env).APPDIR;
  if (appdir) {
    const bundled = path.join(appdir, 'usr', 'bin', 'python3');
    if (f.existsSync(bundled)) py = bundled;
  }
  return { packaged: false, cmd: py, args: [path.join(o.appDir, 'run.py')], cwd: o.appDir, missing: null };
}

// Runs `<backend> --selfcheck-json`. -> { report } | { error }. A non-zero exit still carries a report (missing packages).
function runSelfcheck(be, timeoutMs) {
  return new Promise((resolve) => {
    if (be.missing) { resolve({ error: 'The bundled application engine is missing.' }); return; }
    execFile(be.cmd, be.args.concat(['--selfcheck-json']), {
      cwd: be.cwd, timeout: timeoutMs || SELFCHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' })
    }, (err, stdout) => {
      const lines = String(stdout || '').trim().split(/\r?\n/);
      try {
        const report = JSON.parse(lines[lines.length - 1]);
        if (report && typeof report === 'object') { resolve({ report }); return; }
      } catch (e) { /* fall through to the error text */ }
      if (err && err.killed) resolve({ error: 'The application engine did not respond in time.' });
      else if (err && err.code === 'ENOENT') resolve({ error: be.packaged ? 'The application engine could not be started.' : 'The development engine (python3) could not be started.' });
      else resolve({ error: 'The application engine started but its check failed' + (err && err.code != null ? ' (exit code ' + err.code + ').' : '.') });
    });
  });
}

// Runs `<backend> --detect-soffice-json` (all resolution logic lives in backend/soffice.py). -> { det } | { error }.
// userDataDir is handed over so the backend can find a managed copy under it.
function runDetectSoffice(be, userDataDir, timeoutMs) {
  return new Promise((resolve) => {
    if (be.missing) { resolve({ error: 'The bundled application engine is missing.' }); return; }
    execFile(be.cmd, be.args.concat(['--detect-soffice-json']), {
      cwd: be.cwd, timeout: timeoutMs || DETECT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true,
      env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }, userDataDir ? { LAUREVINE_USER_DATA: userDataDir } : {})
    }, (err, stdout) => {
      const lines = String(stdout || '').trim().split(/\r?\n/);
      try {
        const det = JSON.parse(lines[lines.length - 1]);
        if (det && typeof det === 'object' && !det.error && typeof det.status === 'string') { resolve({ det }); return; }
      } catch (e) { /* fall through */ }
      resolve({ error: err && err.killed ? 'The LibreOffice check did not finish in time.' : 'The LibreOffice check could not run.' });
    });
  });
}

function engineItem(res) {
  const item = { id: 'engine', label: 'Application engine', required: true };
  if (res.error || !res.report) return Object.assign(item, { status: 'fail', detail: res.error || 'The application engine could not be checked.' });
  if (res.report.error) return Object.assign(item, { status: 'fail', detail: String(res.report.error).slice(0, 200) });
  const deps = Object.values(res.report.dependencies || {}).filter((d) => d && d.required);
  const missing = deps.filter((d) => !d.found).map((d) => d.package);
  if (!deps.length) return Object.assign(item, { status: 'fail', detail: 'The engine did not report its required packages.' });
  if (missing.length) return Object.assign(item, { status: 'fail', detail: 'Missing required packages: ' + missing.join(', ') + '.' });
  return Object.assign(item, { status: 'ok', detail: 'Runs; ' + deps.length + ' required packages found.' });
}

// Number of font files one level below `dir` (fonts/<family>/*.ttf), or -1 when the folder cannot be read.
function countFonts(dir, f) {
  let entries;
  try { entries = f.readdirSync(dir, { withFileTypes: true }); } catch (e) { return -1; }
  let n = 0;
  for (const d of entries) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    try { n += f.readdirSync(path.join(dir, d.name)).filter((x) => FONT_FILE.test(x)).length; } catch (e) { /* skip */ }
  }
  return n;
}

// UI copy: <appDir>/fonts. Packaged builds also need the engine's own copy (PyInstaller 6 keeps it in _internal, 5 beside the binary).
function fontsItem(o, be) {
  const f = o.fs || fs;
  const item = { id: 'fonts', label: 'Bundled fonts', required: true };
  const dirs = [path.join(o.appDir, 'fonts')];
  if (be.packaged) {
    const root = path.dirname(be.cmd);
    const found = [path.join(root, '_internal', 'fonts'), path.join(root, 'fonts')].find((d) => f.existsSync(d));
    if (!found) return Object.assign(item, { status: 'fail', detail: 'The font folder is missing from the application engine.' });
    dirs.push(found);
  }
  let total = 0;
  for (const dir of dirs) {
    const n = countFonts(dir, f);
    if (n < 1 || !f.existsSync(path.join(dir, 'fonts.css'))) {
      return Object.assign(item, { status: 'fail', detail: n < 0 ? 'The font folder is missing.' : n < 1 ? 'The font folder contains no font files.' : 'The font stylesheet (fonts.css) is missing.' });
    }
    total = n;
  }
  return Object.assign(item, { status: 'ok', detail: total + ' font files found.' });
}

function userDataItem(o) {
  const f = o.fs || fs;
  const item = { id: 'userdata', label: 'User-data folder writable', required: true };
  const probe = path.join(o.userDataDir, '.write-test-' + process.pid);
  try {
    f.mkdirSync(o.userDataDir, { recursive: true });
    f.writeFileSync(probe, 'ok');
    f.unlinkSync(probe);
    return Object.assign(item, { status: 'ok', detail: 'Settings and progress can be saved.' });
  } catch (e) {
    try { f.unlinkSync(probe); } catch (_) { /* nothing to clean */ }
    return Object.assign(item, { status: 'fail', detail: "Laurevine Rose can't write to its settings folder" + (e && e.code ? ' (' + e.code + ').' : '.') });
  }
}

// Optional tools: informational only (never required, never blocking, nothing to download here).
const SOURCE_NOTE = { managed: 'Using the copy Laurevine Rose manages.' };

// LibreOffice row from a detection result ({status: found|incompatible|missing, path, version, reason, source}).
function officeItem(res) {
  const item = { id: 'office', label: 'LibreOffice (optional)', required: false };
  const det = res && res.det;
  if (!det) return Object.assign(item, { status: 'info', statusText: 'Not checked', detail: (res && res.error) || 'It could not be checked. PowerPoint export works normally.' });
  const ver = det.version ? ', version ' + det.version : '';
  if (det.status === 'found') {
    return Object.assign(item, { status: 'ok', statusText: 'Found', detail: det.path + ver + '. ' + (SOURCE_NOTE[det.source] || 'Using your installation.') });
  }
  if (det.status === 'incompatible') {
    return Object.assign(item, { status: 'info', statusText: 'Found, not compatible', detail: det.path + ver + '. ' + (det.reason || 'This version cannot be used.') + ' Presentation PDF export is unavailable; PowerPoint export works normally.' });
  }
  return Object.assign(item, { status: 'info', statusText: 'Not found', detail: 'Presentation PDF export is unavailable; PowerPoint export works normally.' });
}

// libreoffice record persisted in setup-state.json -> components.libreoffice
function officeRecord(res) {
  const det = res && res.det;
  const found = !!(det && det.path);
  return {
    source: found ? det.source || null : null,
    path: found ? det.path : null,
    version: found ? det.version || null : null,
    checkedAt: (det && det.checkedAt) || new Date().toISOString()
  };
}

function optionalItems(report, office) {
  if (!report || report.error) return [];
  const tex = (report.runtime && report.runtime.tex) || {};
  const texOk = !!tex.pgfplots && Object.keys(tex.engines || {}).length > 0;
  return [
    { id: 'tex', label: 'LaTeX / PGFPlots (optional)', required: false, status: texOk ? 'ok' : 'info', detail: texOk ? 'Found.' : 'Not found. LaTeX figure editing is unavailable.' },
    officeItem(office)
  ];
}

// o: { isPackaged, resourcesPath, appDir, platform?, env?, userDataDir, fs? } -> { items, requiredOk, libreoffice }
async function check(o) {
  const be = resolveBackend(o);
  const [res, office] = await Promise.all([runSelfcheck(be), runDetectSoffice(be, o.userDataDir)]);
  const items = [engineItem(res), fontsItem(o, be), userDataItem(o)].concat(optionalItems(res.report, office));
  return { items, requiredOk: items.every((i) => !i.required || i.status === 'ok'), libreoffice: officeRecord(office) };
}

module.exports = { resolveBackend, runSelfcheck, runDetectSoffice, officeItem, officeRecord, check, engineItem, fontsItem, userDataItem, optionalItems, countFonts };
