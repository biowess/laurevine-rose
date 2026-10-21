'use strict';
/* setup/installer.js — download + integrity layer for the managed LibreOffice archive (setup/libreoffice-manifest.json).
   Pure Node built-ins (no Electron, no dependencies) so it is unit-testable; fs/request/sleep/statfs can be injected.
   Scope: validate the manifest entry, stream the archive to <userData>/downloads/*.part, and verify the EXACT byte size and
   SHA-256 before the file is renamed to its final name. Extraction / post-install is NOT done here and must only ever run on
   the verified file returned by download().
   Nothing here throws into the caller: download() always resolves to {ok:true, ...} or {ok:false, code, error, cancelled?}. */
const fs = require('fs');
const path = require('path');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile: cpExecFile } = require('child_process');
const { pathToFileURL } = require('url');
const setupState = require('./state');

const COMPONENT = 'libreoffice';
const MANIFEST_FILE = path.join(__dirname, 'libreoffice-manifest.json');
const DOWNLOADS_DIR = 'downloads';
const LOCK_NAME = '.install.lock';
const FREE_SPACE_FACTOR = 2.5;                 // free space must be >= expected download size x 2.5
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024; // sanity ceiling for a manifest size_bytes
const MAX_REDIRECTS = 5;
const MAX_ATTEMPTS = 4;                        // first try + 3 retries
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15000;
const IDLE_TIMEOUT_MS = 30000;                 // no socket activity for this long => retryable failure
const PROGRESS_INTERVAL_MS = 250;
const LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const REDIRECT_STATUS = [301, 302, 303, 307, 308];
const ARCHIVE_EXT = { msi: '.msi', dmg: '.dmg', 'tar.gz': '.tar.gz' };
const REQUIRED_FIELDS = ['version', 'fetch_date', 'url', 'size_bytes', 'sha256', 'archive_type', 'extract', 'soffice_rel_path', 'verified'];
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FS_FATAL = ['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'ENOENT', 'EISDIR', 'ENOTDIR'];
const NET_RETRYABLE = ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ERR_STREAM_PREMATURE_CLOSE'];
const PROBE_TIMEOUT_MS = 20000;
const SMOKE_TIMEOUT_MS = 120000;
const MIN_VERSION = [5, 0];
const SAMPLE_DECK_NAME = 'representative_sample_deck.pptx';

let busy = false; // in-process single-install lock; set synchronously so two calls in the same tick cannot both start

class InstallError extends Error {
  constructor(code, message, retryable) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
    this.retryable = !!retryable;
  }
}

function formatBytes(n) {
  return n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.ceil(n / 1048576) + ' MB';
}

function describeFsError(err, dir) {
  const code = err && err.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return "Setup can't save the download because the disk is full. Free some space and try again.";
  if (code === 'EACCES' || code === 'EPERM') return "Setup can't save the download because Laurevine Rose doesn't have permission to use its downloads folder (" + dir + '). Check the folder permissions and try again.';
  if (code === 'EROFS') return "Setup can't save the download because the downloads folder is read-only (" + dir + ').';
  return "Setup couldn't save the download" + (code ? ' (' + code + ')' : '') + '. Please try again.';
}

// ---- manifest ----------------------------------------------------------------------------------------------------------------

// 'win32'/'x64' -> 'win-x64' (manifest key), or null when the platform/arch has no manifest naming.
function platformKey(platform, arch) {
  const p = { win32: 'win', darwin: 'mac', linux: 'linux' }[platform || process.platform];
  const a = { x64: 'x64', arm64: 'arm64' }[arch || process.arch];
  return p && a ? p + '-' + a : null;
}

// -> { ok, manifest } | { ok:false, code, error }
function loadManifest(file, fsImpl) {
  const f = fsImpl || fs;
  try {
    const manifest = JSON.parse(String(f.readFileSync(file || MANIFEST_FILE, 'utf8')).replace(/^\uFEFF/, ''));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('not an object');
    return { ok: true, manifest };
  } catch (e) {
    return { ok: false, code: 'INVALID_MANIFEST', error: 'The LibreOffice download details could not be loaded. Please reinstall Laurevine Rose or contact the publisher.' };
  }
}

function invalid(key, why) {
  return { ok: false, code: 'INVALID_MANIFEST', error: "The LibreOffice download details for this computer (" + key + ") are not valid (" + why + "), so nothing was downloaded. Please reinstall Laurevine Rose or contact the publisher." };
}

function hostList(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const h of v) {
    const s = typeof h === 'string' ? h.trim().toLowerCase() : '';
    if (!HOST_RE.test(s) || net.isIP(s)) return null;
    out.push(s);
  }
  return out;
}

// Validates one manifest entry. Allowed hosts = host of manifest.source + optional manifest/entry `allowed_redirect_hosts`
// (exact hostnames). The entry url itself must be on that list (so the allowlist is not derived from the url it protects).
// -> { ok, key, entry (normalized copy), allowedHosts:Set, fileName } | { ok:false, code, error }
function validateEntry(manifest, key) {
  if (!manifest || typeof manifest !== 'object') return invalid(key, 'no manifest');
  if (!/^(win|mac|linux)-(x64|arm64)$/.test(String(key))) return { ok: false, code: 'UNSUPPORTED_PLATFORM', error: 'Automatic LibreOffice setup is not available for this computer (' + key + ').' };
  if (!Object.prototype.hasOwnProperty.call(manifest, key) || !manifest[key] || typeof manifest[key] !== 'object' || Array.isArray(manifest[key])) {
    return { ok: false, code: 'UNSUPPORTED_PLATFORM', error: 'Automatic LibreOffice setup is not available for this computer (' + key + ').' };
  }
  const e = manifest[key];
  const missing = REQUIRED_FIELDS.filter((k) => !(k in e));
  if (missing.length) return invalid(key, 'missing ' + missing.join(', '));
  if (e.verified !== true) return { ok: false, code: 'UNVERIFIED_ENTRY', error: 'The LibreOffice download for this computer (' + key + ') is not marked as verified, so it will not be downloaded.' };
  if (typeof e.version !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(e.version)) return invalid(key, 'version');
  if (typeof e.fetch_date !== 'string' || !e.fetch_date) return invalid(key, 'fetch_date');
  if (!Number.isSafeInteger(e.size_bytes) || e.size_bytes <= 0 || e.size_bytes > MAX_DOWNLOAD_BYTES) return invalid(key, 'size');
  if (typeof e.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(e.sha256)) return invalid(key, 'sha256');
  const ext = Object.prototype.hasOwnProperty.call(ARCHIVE_EXT, e.archive_type) ? ARCHIVE_EXT[e.archive_type] : null;
  if (!ext) return invalid(key, 'archive type');
  if (!e.extract || typeof e.extract !== 'object' || Array.isArray(e.extract)) return invalid(key, 'extract');
  const rel = e.soffice_rel_path;
  if (typeof rel !== 'string' || !rel || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.split(/[\\/]+/).includes('..')) return invalid(key, 'executable path');

  let source;
  try { source = new URL(manifest.source); } catch (_) { return invalid(key, 'source'); }
  const extraTop = hostList(manifest.allowed_redirect_hosts);
  const extraEntry = hostList(e.allowed_redirect_hosts);
  if (source.protocol !== 'https:' || extraTop === null || extraEntry === null) return invalid(key, 'allowed hosts');
  const allowedHosts = new Set([source.hostname.toLowerCase().replace(/\.$/, '')].concat(extraTop, extraEntry));

  let url;
  try { url = new URL(e.url); } catch (_) { return invalid(key, 'url'); }
  if (url.protocol !== 'https:') return { ok: false, code: 'INSECURE_URL', error: 'The LibreOffice download address is not a secure (https) address, so nothing was downloaded.' };
  const bad = urlProblem(url, allowedHosts);
  if (bad) return invalid(key, 'url host');
  if (!url.pathname.toLowerCase().endsWith(ext)) return invalid(key, 'url does not match archive type');

  const entry = Object.assign({}, e, { sha256: e.sha256.toLowerCase(), url: url.href });
  return { ok: true, key, entry, allowedHosts, fileName: COMPONENT + '-' + e.version + '-' + key + ext };
}

// Returns a reason string when `u` may not be requested (non-https, credentials, odd port, host not allowlisted), else null.
function urlProblem(u, allowedHosts) {
  if (u.protocol !== 'https:') return 'not https';
  if (u.username || u.password) return 'credentials in url';
  if (u.port && u.port !== '443') return 'port';
  if (!allowedHosts.has(u.hostname.toLowerCase().replace(/\.$/, ''))) return 'host not allowed';
  return null;
}

// Free space required before downloading: expected size x 2.5 (rounded up).
function requiredFreeBytes(sizeBytes) { return Math.ceil(sizeBytes * FREE_SPACE_FACTOR); }

function downloadsDir(userDataDir) { return path.join(userDataDir, DOWNLOADS_DIR); }

// ---- helpers -----------------------------------------------------------------------------------------------------------------

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function backoffMs(attempt) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 250);
}

function hexEqual(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

// Cross-process guard (the in-process flag above covers the normal case). A stale lock (dead pid, our own pid, unreadable or
// older than LOCK_MAX_AGE_MS) is reclaimed. -> true when acquired, false when another install is genuinely running.
async function acquireFileLock(f, lockPath) {
  for (let i = 0; i < 2; i++) {
    try {
      const fh = await f.promises.open(lockPath, 'wx', 0o600);
      try { await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); } finally { await fh.close(); }
      return true;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let info = null;
      try { info = JSON.parse(await f.promises.readFile(lockPath, 'utf8')); } catch (_) { /* unreadable => stale */ }
      const started = info ? Date.parse(info.startedAt) : NaN;
      const live = info && Number.isInteger(info.pid) && info.pid !== process.pid && pidAlive(info.pid) && Number.isFinite(started) && Date.now() - started < LOCK_MAX_AGE_MS;
      if (live) return false;
      try { await f.promises.unlink(lockPath); } catch (_) {}
    }
  }
  return false;
}

async function freeBytes(f, dir, statfsImpl) {
  const fn = statfsImpl || (f.promises && f.promises.statfs ? (d) => f.promises.statfs(d) : null);
  if (!fn) throw new InstallError('DISK_CHECK_UNAVAILABLE', "Setup couldn't check how much free disk space is available, so it did not start the download.", false);
  let st;
  try { st = await fn(dir); } catch (e) {
    throw new InstallError('DISK_CHECK_UNAVAILABLE', "Setup couldn't check how much free disk space is available, so it did not start the download.", false);
  }
  const free = Number(st && st.bavail) * Number(st && st.bsize);
  if (!Number.isFinite(free) || free < 0) throw new InstallError('DISK_CHECK_UNAVAILABLE', "Setup couldn't check how much free disk space is available, so it did not start the download.", false);
  return free;
}

async function removeQuiet(f, file) {
  try { await f.promises.unlink(file); } catch (_) {}
}

// Maps any thrown value to an InstallError (retryable only for network-type failures).
function toInstallError(e, dir) {
  if (e instanceof InstallError) return e;
  const code = e && e.code;
  if (typeof code === 'string' && /^(CERT_|ERR_TLS_|ERR_SSL|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH)/.test(code)) {
    return new InstallError('TLS', "Setup couldn't confirm a secure connection to the download server, so it stopped. Check the computer's date and time and any security software, then try again.", false);
  }
  if (FS_FATAL.includes(code)) return new InstallError('IO', describeFsError(e, dir), false);
  const detail = NET_RETRYABLE.includes(code) ? ' (' + code + ')' : '';
  return new InstallError('NETWORK', "Setup couldn't finish downloading LibreOffice" + detail + '. Check the internet connection and try again.', true);
}

// ---- HTTP --------------------------------------------------------------------------------------------------------------------

function requestOnce(ctx, url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = ctx.request(url, { method: 'GET', headers: ctx.headers, signal: ctx.signal }, (res) => { settled = true; resolve(res); });
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => { if (!settled) reject(e); }); // after the response starts, failures surface through the response stream
    req.end();
  });
}

// Follows redirects by hand: https only (never downgrade), host must be allowlisted, at most MAX_REDIRECTS hops.
async function openResponse(ctx) {
  let url = ctx.url;
  for (let hop = 0; ; hop++) {
    const res = await requestOnce(ctx, url);
    const status = res.statusCode;
    if (REDIRECT_STATUS.includes(status)) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new InstallError('REDIRECT_BLOCKED', 'The download server redirected too many times, so Setup stopped.', false);
      let next;
      try { next = new URL(String(res.headers.location || ''), url); } catch (_) {
        throw new InstallError('REDIRECT_BLOCKED', 'The download server sent an invalid redirect, so Setup stopped.', false);
      }
      if (next.protocol !== 'https:') throw new InstallError('REDIRECT_BLOCKED', 'The download server tried to switch to an insecure connection, so Setup stopped.', false);
      if (urlProblem(next, ctx.allowedHosts)) throw new InstallError('REDIRECT_BLOCKED', 'The download server redirected to an address that is not approved (' + next.hostname + '), so Setup stopped.', false);
      url = next;
      continue;
    }
    if (status !== 200) {
      res.resume();
      const retry = status === 408 || status === 429 || status >= 500;
      throw new InstallError('HTTP_STATUS', 'The download server answered with an error (HTTP ' + status + ').' + (retry ? ' Setup will retry.' : ''), retry);
    }
    const enc = String(res.headers['content-encoding'] || 'identity').toLowerCase();
    if (enc !== 'identity') { res.resume(); throw new InstallError('HTTP_STATUS', 'The download server sent the file in an unexpected format, so Setup stopped.', false); }
    const len = res.headers['content-length'];
    if (len !== undefined && !(/^\d+$/.test(String(len)) && Number(len) === ctx.entry.size_bytes)) {
      res.resume();
      throw new InstallError('SIZE_MISMATCH', "The download server reports a file size that doesn't match the expected LibreOffice package, so Setup stopped.", false);
    }
    return res;
  }
}

// One full attempt: request -> stream to .part (hashing as bytes arrive) -> fsync -> check exact size + SHA-256 -> rename.
async function attempt(ctx, n) {
  const f = ctx.f;
  const total = ctx.entry.size_bytes;
  ctx.emit({ phase: 'downloading', attempt: n, receivedBytes: 0, totalBytes: total });
  const res = await openResponse(ctx);

  const hash = crypto.createHash('sha256');
  let received = 0;
  let lastEmit = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > total) return cb(new InstallError('SIZE_MISMATCH', 'The downloaded file is larger than expected, so Setup stopped.', false));
      hash.update(chunk);
      const now = Date.now();
      if (now - lastEmit >= PROGRESS_INTERVAL_MS) { lastEmit = now; ctx.emit({ phase: 'downloading', attempt: n, receivedBytes: received, totalBytes: total }); }
      cb(null, chunk);
    }
  });

  let onDisk = -1;
  const fh = await f.promises.open(ctx.partPath, 'wx', 0o600);
  try {
    await pipeline(res, meter, fh.createWriteStream({ autoClose: false }), { signal: ctx.signal });
    await fh.sync();
    onDisk = (await fh.stat()).size;
  } finally {
    try { await fh.close(); } catch (_) {}
  }

  ctx.emit({ phase: 'verifying', attempt: n, receivedBytes: received, totalBytes: total });
  if (received !== total || onDisk !== total) {
    throw new InstallError('SIZE_MISMATCH', 'The download ended before the whole file arrived (' + formatBytes(Math.min(received, onDisk < 0 ? received : onDisk)) + ' of ' + formatBytes(total) + '). Setup will retry.', true);
  }
  if (!hexEqual(hash.digest('hex'), ctx.entry.sha256)) {
    throw new InstallError('HASH_MISMATCH', "The downloaded LibreOffice file failed its integrity check (SHA-256 doesn't match), so it was deleted and will not be used.", false);
  }
  await f.promises.rename(ctx.partPath, ctx.finalPath); // only a verified file ever gets its final name
  return { sizeBytes: onDisk, sha256: ctx.entry.sha256 };
}

// ---- public API --------------------------------------------------------------------------------------------------------------

/* download(opts) -> Promise<{ ok:true, key, version, filePath, sizeBytes, sha256, entry } | { ok:false, code, error, cancelled? }>
   opts: { userDataDir (required), signal?:AbortSignal, onProgress?:fn, key?, manifest?|manifestPath?,
           fs?, request?, sleep?, statfs?, platform?, arch?, maxAttempts? }  (the last group exists for tests)
   onProgress({ component, key, phase:'preparing'|'downloading'|'retrying'|'verifying'|'done', attempt, maxAttempts,
                receivedBytes, totalBytes, percent, retryInMs?, message? }) — throttled; a throwing listener is ignored.
   Error codes: INVALID_MANIFEST UNSUPPORTED_PLATFORM UNVERIFIED_ENTRY INSECURE_URL BUSY DISK_SPACE DISK_CHECK_UNAVAILABLE
                REDIRECT_BLOCKED HTTP_STATUS TLS NETWORK SIZE_MISMATCH HASH_MISMATCH IO CANCELLED. */
async function download(opts) {
  const o = opts || {};
  const f = o.fs || fs;
  const fail = (code, error, extra) => Object.assign({ ok: false, code, error }, extra);
  const cancelled = () => fail('CANCELLED', 'The download was cancelled.', { cancelled: true });
  if (typeof o.userDataDir !== 'string' || !o.userDataDir) return fail('IO', "Setup couldn't find its settings folder, so it did not start the download.");
  const signal = o.signal || new AbortController().signal;
  if (signal.aborted) return cancelled();

  const key = o.key || platformKey(o.platform, o.arch);
  let manifest = o.manifest;
  if (!manifest) {
    const m = loadManifest(o.manifestPath, f);
    if (!m.ok) return fail(m.code, m.error);
    manifest = m.manifest;
  }
  const v = validateEntry(manifest, key);
  if (!v.ok) return fail(v.code, v.error);
  const entry = v.entry;
  const total = entry.size_bytes;
  const maxAttempts = Number.isInteger(o.maxAttempts) && o.maxAttempts > 0 ? o.maxAttempts : MAX_ATTEMPTS;

  if (!o._skipBusyCheck && busy) return fail('BUSY', 'LibreOffice is already being set up. Wait for it to finish, or cancel it first.');
  if (!o._skipBusyCheck) busy = true; // synchronous with the check above: no await in between
  const dir = downloadsDir(o.userDataDir);
  const lockPath = path.join(dir, LOCK_NAME);
  let haveFileLock = false;
  const ctx = {
    f, key, entry, signal, allowedHosts: v.allowedHosts, url: new URL(entry.url),
    request: o.request || https.request,
    headers: { 'User-Agent': 'LaurevineRose-Setup', 'Accept-Encoding': 'identity', Accept: '*/*' },
    partPath: path.join(dir, v.fileName + '.part'), finalPath: path.join(dir, v.fileName),
    emit(p) {
      if (typeof o.onProgress !== 'function') return;
      const received = p.receivedBytes || 0;
      try {
        o.onProgress(Object.assign({ component: COMPONENT, key, attempt: 1, maxAttempts, receivedBytes: received, totalBytes: total, percent: Math.min(100, Math.floor((received / total) * 100)) }, p));
      } catch (_) { /* a UI listener must never break the download */ }
    }
  };

  try {
    ctx.emit({ phase: 'preparing' });
    try {
      await f.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      haveFileLock = await acquireFileLock(f, lockPath);
    } catch (e) { return fail('IO', describeFsError(e, dir)); }
    if (!haveFileLock) return fail('BUSY', 'LibreOffice is already being set up by another Laurevine Rose window. Wait for it to finish.');

    // Under the lock: leftovers from an earlier crashed/cancelled run (and a stale final file) must not count or survive.
    try {
      for (const name of await f.promises.readdir(dir)) {
        if (name.startsWith(COMPONENT + '-') && name.endsWith('.part')) await removeQuiet(f, path.join(dir, name));
      }
    } catch (_) {}
    await removeQuiet(f, ctx.finalPath);

    const need = requiredFreeBytes(total);
    const free = await freeBytes(f, dir, o.statfs);
    if (free < need) {
      return fail('DISK_SPACE', 'Not enough free disk space for LibreOffice: about ' + formatBytes(need) + ' is needed (' + formatBytes(total) + ' download plus room to unpack) and ' + formatBytes(free) + ' is available. Free some space and try again.');
    }

    for (let n = 1; n <= maxAttempts; n++) {
      if (signal.aborted) return cancelled();
      try {
        await removeQuiet(f, ctx.partPath);
        const r = await attempt(ctx, n);
        ctx.emit({ phase: 'done', attempt: n, receivedBytes: total });
        return { ok: true, key, version: entry.version, filePath: ctx.finalPath, sizeBytes: r.sizeBytes, sha256: r.sha256, entry, haveFileLock, lockPath };
      } catch (e) {
        await removeQuiet(f, ctx.partPath); // never leave a partial or unverified file behind
        if (signal.aborted) return cancelled();
        const err = toInstallError(e, dir);
        if (!err.retryable || n >= maxAttempts) return fail(err.code, err.error || err.message);
        const delay = backoffMs(n);
        ctx.emit({ phase: 'retrying', attempt: n, retryInMs: delay, message: err.message });
        await (o.sleep || sleep)(delay, signal);
      }
    }
    return fail('NETWORK', "Setup couldn't finish downloading LibreOffice. Check the internet connection and try again.");
  } catch (e) {
    if (signal.aborted) return cancelled();
    const err = toInstallError(e, dir);
    return fail(err.code, err.message);
  } finally {
    await removeQuiet(f, ctx.partPath);
    if (!o._leaveBusy) {
      if (haveFileLock) await removeQuiet(f, lockPath);
      busy = false;
    }
  }
}

function runTool(execFileFn, cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFileFn(cmd, args, opts || {}, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function removeDirRecursive(f, dir) {
  if (f.promises && f.promises.rm) {
    try {
      await f.promises.rm(dir, { recursive: true, force: true });
      return;
    } catch (_) {}
  }
  try {
    const entries = await f.promises.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await removeDirRecursive(f, full);
      } else {
        try { await f.promises.unlink(full); } catch (_) {}
      }
    }
    try { await f.promises.rmdir(dir); } catch (_) {}
  } catch (_) {}
}

async function fileOrDirExists(f, p) {
  try {
    await f.promises.stat(p);
    return true;
  } catch (_) {
    return false;
  }
}

async function extractArchive(execFileFn, f, archiveType, archivePath, stagingDir, signal) {
  if (archiveType === 'tar.gz') {
    let listOut;
    try {
      const res = await runTool(execFileFn, 'tar', ['-tf', archivePath], { signal });
      listOut = res.stdout;
    } catch (e) {
      throw new InstallError('ARCHIVE_CORRUPT', 'Failed to inspect tar archive: ' + (e.message || String(e)), false);
    }
    const lines = listOut.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const segments = line.split(/[\\/]+/);
      if (segments.includes('..') || path.isAbsolute(line) || /^[a-zA-Z]:/.test(line)) {
        throw new InstallError('ARCHIVE_TRAVERSAL', 'Archive contains unsafe path: ' + line, false);
      }
    }

    const unpackDir = path.join(stagingDir, '.unpack');
    await f.promises.mkdir(unpackDir, { recursive: true, mode: 0o700 });
    try {
      await runTool(execFileFn, 'tar', ['-xzf', archivePath, '-C', unpackDir], { signal });
    } catch (e) {
      throw new InstallError('ARCHIVE_CORRUPT', 'Failed to extract tar archive: ' + (e.message || String(e)), false);
    }

    const debs = [];
    async function findDebs(dir) {
      const entries = await f.promises.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          await findDebs(full);
        } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.deb')) {
          debs.push(full);
        }
      }
    }
    await findDebs(unpackDir);

    if (debs.length > 0) {
      debs.sort();
      for (const deb of debs) {
        try {
          await runTool(execFileFn, 'dpkg-deb', ['-x', deb, stagingDir], { signal });
        } catch (e) {
          throw new InstallError('ARCHIVE_CORRUPT', 'Failed to unpack deb package (' + path.basename(deb) + '): ' + (e.message || String(e)), false);
        }
      }
      await removeDirRecursive(f, unpackDir);
    } else {
      const ents = await f.promises.readdir(unpackDir);
      for (const name of ents) {
        await f.promises.rename(path.join(unpackDir, name), path.join(stagingDir, name));
      }
      await removeDirRecursive(f, unpackDir);
    }
  } else if (archiveType === 'msi') {
    const targetArg = 'TARGETDIR=' + path.resolve(stagingDir);
    try {
      await runTool(execFileFn, 'msiexec', ['/a', path.resolve(archivePath), '/qb', targetArg], { signal });
    } catch (e) {
      throw new InstallError('ARCHIVE_CORRUPT', 'msiexec failed: ' + (e.message || String(e)), false);
    }
  } else if (archiveType === 'dmg') {
    let attachRes;
    try {
      attachRes = await runTool(execFileFn, 'hdiutil', ['attach', archivePath, '-nobrowse', '-readonly'], { signal });
    } catch (e) {
      throw new InstallError('ARCHIVE_CORRUPT', 'Failed to attach DMG: ' + (e.message || String(e)), false);
    }
    const lines = (attachRes.stdout || '').split(/\r?\n/);
    let mountPoint = null;
    for (const l of lines) {
      const idx = l.indexOf('/Volumes/');
      if (idx !== -1) {
        mountPoint = l.slice(idx).trim();
        break;
      }
    }
    if (!mountPoint) {
      throw new InstallError('EXTRACTION_FAILED', 'Could not locate DMG mount point in hdiutil output.', false);
    }
    try {
      const appSrc = path.join(mountPoint, 'LibreOffice.app');
      await runTool(execFileFn, 'cp', ['-R', appSrc, stagingDir], { signal });
    } catch (e) {
      throw new InstallError('EXTRACTION_FAILED', 'Failed to copy LibreOffice.app from DMG: ' + (e.message || String(e)), false);
    } finally {
      try {
        await runTool(execFileFn, 'hdiutil', ['detach', mountPoint], { signal });
      } catch (_) {}
    }
  } else {
    throw new InstallError('INVALID_MANIFEST', 'Unsupported archive type: ' + archiveType, false);
  }
}

async function validateStagingSafety(f, stagingDir) {
  const root = path.resolve(stagingDir);
  async function scan(current) {
    let entries;
    try {
      entries = await f.promises.readdir(current, { withFileTypes: true });
    } catch (e) {
      throw new InstallError('IO', 'Failed to read staging directory during safety check: ' + (e.message || String(e)), false);
    }
    for (const ent of entries) {
      const name = ent.name;
      if (name === '..' || name === '.' || name.includes('/') || name.includes('\\') || /^[a-zA-Z]:/.test(name)) {
        throw new InstallError('ARCHIVE_TRAVERSAL', 'Staging contains invalid filename: ' + name, false);
      }
      const full = path.join(current, name);
      const rel = path.relative(root, full);
      if (rel.startsWith('..') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
        throw new InstallError('ARCHIVE_TRAVERSAL', 'File path escapes staging root: ' + name, false);
      }
      if (ent.isSymbolicLink()) {
        let target;
        try {
          target = await f.promises.readlink(full);
        } catch (e) {
          throw new InstallError('IO', 'Failed to read symlink target: ' + name, false);
        }
        if (path.isAbsolute(target) || /^[a-zA-Z]:/.test(target) || target.startsWith('/') || target.startsWith('\\')) {
          throw new InstallError('ARCHIVE_TRAVERSAL', 'Staging contains absolute symlink: ' + target, false);
        }
        const resolved = path.resolve(current, target);
        const relTarget = path.relative(root, resolved);
        if (relTarget.startsWith('..') || path.isAbsolute(relTarget) || /^[a-zA-Z]:/.test(relTarget)) {
          throw new InstallError('ARCHIVE_TRAVERSAL', 'Symlink escapes staging root: ' + target, false);
        }
      } else if (ent.isDirectory()) {
        await scan(full);
      }
    }
  }
  await scan(root);
}

function parseVersion(text) {
  const m = (text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10), m[3] ? parseInt(m[3], 10) : 0, m[4] ? parseInt(m[4], 10) : 0] : null;
}

async function runProbe(execFileFn, sofficePath, signal) {
  try {
    const res = await runTool(execFileFn, sofficePath, ['--version'], { timeout: PROBE_TIMEOUT_MS, signal });
    const out = (res.stdout || '').trim() || (res.stderr || '').trim();
    const ver = parseVersion(out);
    if (!ver) {
      throw new InstallError('PROBE_FAILED', "LibreOffice version could not be parsed from '--version'.", false);
    }
    if (ver[0] < MIN_VERSION[0] || (ver[0] === MIN_VERSION[0] && ver[1] < MIN_VERSION[1])) {
      const verStr = ver.slice(0, 3).join('.');
      throw new InstallError('PROBE_FAILED', `LibreOffice version ${verStr} is older than the minimum supported version ${MIN_VERSION.join('.')}.`, false);
    }
    return { compatible: true, version: ver.slice(0, 3).join('.') };
  } catch (e) {
    if (e instanceof InstallError) throw e;
    throw new InstallError('PROBE_FAILED', `LibreOffice probe failed: ${e.message || String(e)}`, false);
  }
}

async function runSmokeConvert(execFileFn, f, sofficePath, sampleDeckPath, userDataDir, signal) {
  const tmpDir = path.join(userDataDir, '.smoke-' + Date.now() + '-' + process.pid);
  const userDir = path.join(tmpDir, 'lo_profile');
  const outDir = path.join(tmpDir, 'out');
  await f.promises.mkdir(userDir, { recursive: true, mode: 0o700 });
  await f.promises.mkdir(outDir, { recursive: true, mode: 0o700 });

  const userUri = pathToFileURL(userDir).href;

  try {
    await runTool(execFileFn, sofficePath, [
      `-env:UserInstallation=${userUri}`,
      '--headless',
      '--convert-to', 'pdf',
      sampleDeckPath,
      '--outdir', outDir
    ], { timeout: SMOKE_TIMEOUT_MS, signal });

    const deckBase = path.basename(sampleDeckPath, path.extname(sampleDeckPath));
    const pdfPath = path.join(outDir, deckBase + '.pdf');
    let st;
    try {
      st = await f.promises.stat(pdfPath);
    } catch (_) {
      throw new InstallError('SMOKE_TEST_FAILED', 'Converted PDF file was not generated.', false);
    }
    if (!st || st.size === 0) {
      throw new InstallError('SMOKE_TEST_FAILED', 'Converted PDF file is empty.', false);
    }
    return true;
  } catch (e) {
    if (e instanceof InstallError) throw e;
    throw new InstallError('SMOKE_TEST_FAILED', `LibreOffice PDF export smoke test failed: ${e.message || String(e)}`, false);
  } finally {
    try { await removeDirRecursive(f, tmpDir); } catch (_) {}
  }
}

async function install(opts) {
  const o = opts || {};
  const f = o.fs || fs;
  const execFileFn = o.execFile || cpExecFile;
  const fail = (code, error, extra) => Object.assign({ ok: false, code, error }, extra);
  const cancelled = () => fail('CANCELLED', 'The installation was cancelled.', { cancelled: true });

  if (typeof o.userDataDir !== 'string' || !o.userDataDir) {
    return fail('IO', "Setup couldn't find its settings folder, so it did not start the installation.");
  }
  const signal = o.signal || new AbortController().signal;
  if (signal.aborted) return cancelled();

  const key = o.key || platformKey(o.platform, o.arch);
  let manifest = o.manifest;
  if (!manifest) {
    const m = loadManifest(o.manifestPath, f);
    if (!m.ok) return fail(m.code, m.error);
    manifest = m.manifest;
  }
  const v = validateEntry(manifest, key);
  if (!v.ok) return fail(v.code, v.error);
  const entry = v.entry;
  const version = entry.version;

  if (busy) return fail('BUSY', 'LibreOffice is already being set up. Wait for it to finish, or cancel it first.');
  busy = true;

  const dir = downloadsDir(o.userDataDir);
  const lockPath = path.join(dir, LOCK_NAME);
  let haveFileLock = false;

  const emit = (p) => {
    if (typeof o.onProgress !== 'function') return;
    try {
      o.onProgress(Object.assign({ component: COMPONENT, key, version }, p));
    } catch (_) {}
  };

  const componentsDir = path.join(o.userDataDir, 'components', COMPONENT);
  const versionDir = path.join(componentsDir, version);
  const stagingDir = path.join(componentsDir, '.staging-' + version + '-' + Date.now() + '-' + process.pid);
  let activated = false;
  let backupDir = null;

  try {
    let archivePath = o.archivePath || o.filePath;
    let sizeBytes = 0;
    let sha256 = entry.sha256;

    if (!archivePath) {
      emit({ phase: 'downloading', percent: 0 });
      const dlRes = await download(Object.assign({}, o, {
        _skipBusyCheck: true,
        _leaveBusy: true
      }));
      if (!dlRes.ok) {
        return fail(dlRes.code, dlRes.error, dlRes.cancelled ? { cancelled: true } : {});
      }
      archivePath = dlRes.filePath;
      sizeBytes = dlRes.sizeBytes;
      sha256 = dlRes.sha256;
      haveFileLock = !!dlRes.haveFileLock;
    } else {
      await f.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      haveFileLock = await acquireFileLock(f, lockPath);
      if (!haveFileLock) return fail('BUSY', 'LibreOffice is already being set up by another Laurevine Rose window.');
      emit({ phase: 'verifying' });
      const st = await f.promises.stat(archivePath);
      sizeBytes = st.size;
      if (entry.size_bytes && sizeBytes !== entry.size_bytes) {
        throw new InstallError('SIZE_MISMATCH', `Archive size (${sizeBytes}) does not match expected size (${entry.size_bytes}).`, false);
      }
      if (entry.sha256) {
        const fileHash = crypto.createHash('sha256');
        const content = await f.promises.readFile(archivePath);
        fileHash.update(content);
        const digest = fileHash.digest('hex');
        if (!hexEqual(digest, entry.sha256)) {
          throw new InstallError('HASH_MISMATCH', 'Archive SHA-256 does not match manifest.', false);
        }
      }
    }

    if (signal.aborted) return cancelled();

    await f.promises.mkdir(componentsDir, { recursive: true, mode: 0o700 });
    await f.promises.mkdir(stagingDir, { recursive: true, mode: 0o700 });

    emit({ phase: 'extracting', percent: 50 });
    const extractFn = o.extract || extractArchive;
    await extractFn(execFileFn, f, entry.archive_type, archivePath, stagingDir, signal);

    if (signal.aborted) return cancelled();

    emit({ phase: 'staging', percent: 70 });
    await validateStagingSafety(f, stagingDir);

    const stagingSoffice = path.join(stagingDir, entry.soffice_rel_path);
    if (!(await fileOrDirExists(f, stagingSoffice))) {
      throw new InstallError('EXTRACTION_FAILED', `LibreOffice executable not found at expected path: ${entry.soffice_rel_path}`, false);
    }

    if (signal.aborted) return cancelled();

    emit({ phase: 'activating', percent: 80 });
    if (await fileOrDirExists(f, versionDir)) {
      backupDir = path.join(componentsDir, '.backup-' + version + '-' + Date.now() + '-' + process.pid);
      await f.promises.rename(versionDir, backupDir);
    }
    await f.promises.rename(stagingDir, versionDir);
    activated = true;
    if (backupDir) {
      await removeDirRecursive(f, backupDir);
      backupDir = null;
    }

    const finalSoffice = path.join(versionDir, entry.soffice_rel_path);
    try { await f.promises.chmod(finalSoffice, 0o755); } catch (_) {}

    if (signal.aborted) return cancelled();

    emit({ phase: 'probing', percent: 85 });
    const probeFn = o.probe || runProbe;
    await probeFn(execFileFn, finalSoffice, signal);

    if (signal.aborted) return cancelled();

    emit({ phase: 'testing', percent: 90 });
    const sampleDeck = o.sampleDeckPath || path.join(__dirname, '..', SAMPLE_DECK_NAME);
    const smokeFn = o.smokeConvert || runSmokeConvert;
    await smokeFn(execFileFn, f, finalSoffice, sampleDeck, o.userDataDir, signal);

    if (signal.aborted) return cancelled();

    emit({ phase: 'persisting', percent: 98 });
    const stateMod = o.stateImpl || setupState;
    const cur = stateMod.load(o.userDataDir, f);
    const record = {
      status: 'installed',
      source: 'managed',
      path: finalSoffice,
      version: entry.version,
      installedAt: new Date().toISOString(),
      checkedAt: new Date().toISOString()
    };
    const nextState = stateMod.setComponent(cur.state, COMPONENT, record);
    const saveRes = stateMod.save(o.userDataDir, nextState, f);
    if (!saveRes.ok) {
      throw new InstallError('IO', saveRes.error || "Setup couldn't save installation state.", false);
    }

    emit({ phase: 'done', percent: 100 });
    return {
      ok: true,
      component: COMPONENT,
      key,
      version: entry.version,
      path: finalSoffice,
      sizeBytes,
      sha256
    };

  } catch (e) {
    if (backupDir && !activated) {
      try { await f.promises.rename(backupDir, versionDir); } catch (_) {}
    }
    if (activated) {
      try { await removeDirRecursive(f, versionDir); } catch (_) {}
      if (backupDir) {
        try { await f.promises.rename(backupDir, versionDir); } catch (_) {}
      }
    }
    try { await removeDirRecursive(f, stagingDir); } catch (_) {}

    if (signal.aborted) return cancelled();
    const err = toInstallError(e, o.userDataDir);
    return fail(err.code, err.error || err.message, err.cancelled ? { cancelled: true } : {});
  } finally {
    try { await removeDirRecursive(f, stagingDir); } catch (_) {}
    if (haveFileLock) await removeQuiet(f, lockPath);
    busy = false;
  }
}

// Convenience wrapper that owns the AbortController: -> { promise, cancel() }. cancel() is a no-op once finished.
function start(opts) {
  const controller = new AbortController();
  const outer = opts && opts.signal;
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const promise = install(Object.assign({}, opts, { signal: controller.signal }));
  return { promise, cancel: () => controller.abort() };
}

function startDownload(opts) {
  const controller = new AbortController();
  const outer = opts && opts.signal;
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const promise = download(Object.assign({}, opts, { signal: controller.signal }));
  return { promise, cancel: () => controller.abort() };
}

function isBusy() { return busy; }

module.exports = {
  COMPONENT, MANIFEST_FILE, DOWNLOADS_DIR, FREE_SPACE_FACTOR, MAX_REDIRECTS, MAX_ATTEMPTS,
  platformKey, loadManifest, validateEntry, urlProblem, requiredFreeBytes, downloadsDir,
  download, install, start, startDownload, isBusy,
  runProbe, runSmokeConvert, validateStagingSafety, extractArchive, parseVersion
};
