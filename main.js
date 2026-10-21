const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const setupState = require('./setup/state');
const components = require('./setup/components');
const installer = require('./setup/installer');

let mainWindow = null;
let splashWindow = null;
let setupWindow = null;
let pythonProcess = null;
let serverPort = null;

const APP_DIR = __dirname;
const ICON_PATH = path.join(APP_DIR, 'Assets', 'appicon.png');

const fs = require('fs');
const APP_VERSION = require('./package.json').version;
const LICENSE_TXT = app.isPackaged
  ? (fs.existsSync(path.join(process.resourcesPath, 'LICENSE.txt'))
      ? path.join(process.resourcesPath, 'LICENSE.txt')
      : path.join(APP_DIR, 'LICENSE.txt'))
  : path.join(APP_DIR, 'LICENSE.txt');
const LICENSE_VERSION = setupState.readLicenseVersion(path.join(APP_DIR, 'setup', 'license.json'));
const FORCE_SETUP = process.argv.includes('--setup') || process.env.LAUREVINE_FORCE_SETUP === '1';

// Startup cheap check: if setup is complete, verify managed LibreOffice executable existsSync if recorded as managed.
// If deleted, flag PDF unavailable in state without running heavy probe.
let initialSetupState = setupState.load(app.getPath('userData')).state;
if (initialSetupState && initialSetupState.setupComplete) {
  const lo = (initialSetupState.components && initialSetupState.components.libreoffice) || null;
  if (lo && lo.source === 'managed' && lo.path && !fs.existsSync(lo.path)) {
    console.warn('[Startup] Managed LibreOffice was deleted at ' + lo.path + '; marking PDF export unavailable.');
    const updatedLo = Object.assign({}, lo, { status: 'missing', reason: 'Managed LibreOffice installation was deleted or not found.' });
    const updatedState = setupState.setComponent(initialSetupState, 'libreoffice', updatedLo);
    setupState.save(app.getPath('userData'), updatedState);
    initialSetupState = updatedState;
  }
}

// Wizard when forced, setup unfinished, or the accepted license is not the current version.
const SETUP_MODE = FORCE_SETUP || setupState.needsSetup(initialSetupState, LICENSE_VERSION);
let launchPending = false;
const SETUP_W = 960;
const SETUP_H = 600;
const APP_NAME = 'Laurevine Rose';
const gotSetupLock = SETUP_MODE ? app.requestSingleInstanceLock() : true;
if (!gotSetupLock) {
  app.quit();
}

function findFreePort(startPort = 8000) {
  return new Promise((resolve) => {
    const s = require('net').createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function waitForServer(port, timeoutMs = 40000) {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    function ping() {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry();
        }
      });
      req.on('error', () => retry());
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    }

    function retry() {
      if (Date.now() - startTime > timeoutMs) {
        reject(new Error('Server failed to respond within startup timeout'));
      } else {
        setTimeout(ping, 250);
      }
    }

    ping();
  });
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 680,
    height: 404,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    center: true,
    resizable: false,
    movable: true,
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  splashWindow.loadFile(path.join(APP_DIR, 'splash.html'));
  splashWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.show();
    }
  });
}

function createSetupWindow() {
  // Scale (zoom factor) down on small work areas, preserving 16:10.
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const scale = Math.min(1, wa.width / SETUP_W, wa.height / SETUP_H);
  const width = Math.round(SETUP_W * scale);
  const height = Math.round(SETUP_H * scale);

  setupWindow = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    icon: ICON_PATH,
    backgroundColor: '#702D3B',
    webPreferences: {
      preload: path.join(APP_DIR, 'setup', 'setup-preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  });

  const wc = setupWindow.webContents;
  wc.setVisualZoomLevelLimits(1, 1);
  wc.on('dom-ready', () => wc.setZoomFactor(scale));

  // Esc must not close the wizard; keep the layout fixed (no keyboard zoom).
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const zoomKey = (input.control || input.meta) && ['+', '-', '=', '0'].includes(input.key);
    if (input.key === 'Escape' || zoomKey) event.preventDefault();
  });
  wc.on('will-navigate', (event) => event.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));

  setupWindow.loadFile(path.join(APP_DIR, 'setup', 'setup.html'));
  setupWindow.once('ready-to-show', () => {
    if (setupWindow && !setupWindow.isDestroyed()) {
      setupWindow.show();
      setupWindow.focus();
    }
  });
  setupWindow.on('closed', () => {
    setupWindow = null;
  });
}

function isSetupSender(event) {
  return !!(setupWindow && !setupWindow.isDestroyed() &&
    event.sender === setupWindow.webContents &&
    (!event.senderFrame || event.senderFrame === event.sender.mainFrame));
}

function backendOpts() {
  return { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appDir: APP_DIR, platform: process.platform, env: process.env };
}

function startPythonBackend(port) {
  // Packaged: <resources>/backend/run(.exe). Dev: python3 run.py. Users never need to install Python.
  const be = components.resolveBackend(backendOpts());
  if (be.missing) {
    throw new Error('The application engine is missing (' + be.missing + '). Please reinstall Laurevine Rose.');
  }
  const userDataDir = app.getPath('userData');
  const env = Object.assign({}, process.env, {
    PYTHONUNBUFFERED: '1',
    HOST: '127.0.0.1',
    PORT: String(port),
    LAUREVINE_USER_DATA: userDataDir
  });

  // Pass LAUREVINE_SOFFICE and LAUREVINE_STATE_FILE so soffice.py can re-read the setup state
  // on each export (path lookup) without restarting the backend after wizard changes.
  try {
    const stateFilePath = setupState.statePath(userDataDir);
    env.LAUREVINE_STATE_FILE = stateFilePath;
    const st = setupState.load(userDataDir).state;
    const lo = (st && st.components && st.components.libreoffice) || null;
    if (lo && lo.path && (lo.status === 'installed' || lo.status === 'found')) {
      if (fs.existsSync(lo.path)) {
        env.LAUREVINE_SOFFICE = lo.path;
      }
    }
  } catch (_) {}

  pythonProcess = spawn(be.cmd, be.args.concat(['--port', String(port), '--host', '127.0.0.1']), {
    cwd: be.cwd,
    env: env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  pythonProcess.on('error', (err) => {
    console.error(`[Backend] Could not start: ${err.message}`);
  });

  pythonProcess.stdout.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[Backend] ${msg}`);
  });

  pythonProcess.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[Backend] ${msg}`);
  });

  pythonProcess.on('exit', (code, sig) => {
    console.log(`[Backend] Exited with code ${code}, signal ${sig}`);
    if (mainWindow && !mainWindow.isDestroyed() && code !== 0 && code !== null) {
      dialog.showErrorBox('Backend Error', `The application backend stopped unexpectedly (exit code ${code}).`);
    }
  });
}

async function launchApp() {
  createSplashWindow();
  try {
    serverPort = await findFreePort(8000);
    startPythonBackend(serverPort);
    await waitForServer(serverPort);
    createMainWindow(serverPort);
  } catch (err) {
    console.error('Startup failed:', err);
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy();
    }
    dialog.showErrorBox(
      'Startup Failure',
      `Failed to launch the application backend: ${err.message}\nPlease verify that the application has permissions to bind loopback ports.`
    );
    cleanup();
    app.quit();
  }
}


function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 500,
    frame: false,
    icon: ICON_PATH,
    show: false,
    backgroundColor: '#F7F6F3',
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy();
      splashWindow = null;
    }
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-maximize-changed', true);
    }
  });

  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-maximize-changed', false);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    cleanup();
    app.quit();
  });
}

function cleanup() {
  if (pythonProcess) {
    try {
      pythonProcess.kill('SIGTERM');
    } catch (e) {}
    pythonProcess = null;
  }
}

ipcMain.on('window-control', (_event, action) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (action === 'minimize') {
    mainWindow.minimize();
  } else if (action === 'maximize') {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  } else if (action === 'close') {
    mainWindow.close();
  }
});

ipcMain.handle('window-is-maximized', () => {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow.isMaximized() : false;
});

function getSetupMockArg() {
  if (app.isPackaged) return null;
  for (const a of process.argv) {
    if (a.startsWith('--setup-mock=')) {
      return a.slice('--setup-mock='.length).toLowerCase().trim();
    }
  }
  const idx = process.argv.indexOf('--setup-mock');
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1].toLowerCase().trim();
  }
  return null;
}

function friendlyInstallError(code, message) {
  if (code === 'UNSUPPORTED_PLATFORM') {
    return {
      friendlyText: 'Automatic LibreOffice setup is not available for this computer.',
      officialUrl: 'https://www.libreoffice.org/download/download-libreoffice/'
    };
  }
  if (code === 'NETWORK' || code === 'HTTP_STATUS' || code === 'TLS' || code === 'REDIRECT_BLOCKED') {
    return { friendlyText: "Setup couldn't finish downloading LibreOffice. Check your internet connection and try again." };
  }
  if (code === 'HASH_MISMATCH' || code === 'SIZE_MISMATCH') {
    return { friendlyText: 'The downloaded file could not be verified (checksum mismatch). The download may be corrupted.' };
  }
  if (code === 'DISK_SPACE') {
    return { friendlyText: 'Not enough free disk space for LibreOffice. Free some space and try again.' };
  }
  if (code === 'IO' && /permission|eacces|eperm/i.test(message || '')) {
    return { friendlyText: "Setup doesn't have permission to write to the destination folder. Check folder permissions and try again." };
  }
  if (code === 'EXTRACTION_FAILED' || /corrupt|damaged|extraction/i.test(message || '')) {
    return { friendlyText: 'The LibreOffice archive is damaged or corrupt and could not be extracted.' };
  }
  return { friendlyText: message || 'An error occurred during LibreOffice installation. Please try again.' };
}

let activeInstallCancel = null;
let activeMockCancel = null;

async function runMockInstall(scenario, webContents, totalBytes, userDataDir) {
  let isCancelled = false;
  activeMockCancel = () => { isCancelled = true; };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const emit = (phase, percent, receivedBytes, speedText, mbText) => {
    if (isCancelled) return;
    webContents.send('setup:install-progress', {
      phase,
      percent,
      receivedBytes,
      totalBytes,
      speedText,
      mbText
    });
  };

  const formattedTotal = totalBytes >= 1073741824 ? (totalBytes / 1073741824).toFixed(1) + ' GB' : Math.ceil(totalBytes / 1048576) + ' MB';

  if (scenario === 'disk') {
    await sleep(150);
    if (isCancelled) return { ok: false, cancelled: true };
    return {
      ok: false,
      code: 'DISK_SPACE',
      error: 'Not enough free disk space.',
      friendlyText: 'Not enough free disk space for LibreOffice. Free some space and try again.'
    };
  }

  if (scenario === 'unsupported') {
    await sleep(150);
    return {
      ok: false,
      code: 'UNSUPPORTED_PLATFORM',
      error: 'Unsupported platform.',
      friendlyText: 'Automatic LibreOffice setup is not available for this computer.',
      officialUrl: 'https://www.libreoffice.org/download/download-libreoffice/'
    };
  }

  // Downloading phase
  emit('downloading', 0, 0, '0 MB/s', '0 MB / ' + formattedTotal);
  await sleep(250);
  if (isCancelled) return { ok: false, cancelled: true };

  const p1Bytes = Math.round(totalBytes * 0.25);
  const p1MB = Math.ceil(p1Bytes / 1048576) + ' MB / ' + formattedTotal;
  emit('downloading', 25, p1Bytes, '14.2 MB/s', p1MB);
  await sleep(250);
  if (isCancelled) return { ok: false, cancelled: true };

  if (scenario === 'cancel') {
    await sleep(400);
    if (isCancelled) return { ok: false, cancelled: true };
  }

  if (scenario === 'network') {
    const pNetBytes = Math.round(totalBytes * 0.35);
    const pNetMB = Math.ceil(pNetBytes / 1048576) + ' MB / ' + formattedTotal;
    emit('downloading', 35, pNetBytes, '8.4 MB/s', pNetMB);
    await sleep(300);
    if (isCancelled) return { ok: false, cancelled: true };
    return {
      ok: false,
      code: 'NETWORK',
      error: 'Network connection lost.',
      friendlyText: "Setup couldn't finish downloading LibreOffice. Check your internet connection and try again."
    };
  }

  const p2Bytes = Math.round(totalBytes * 0.65);
  const p2MB = Math.ceil(p2Bytes / 1048576) + ' MB / ' + formattedTotal;
  emit('downloading', 65, p2Bytes, '15.1 MB/s', p2MB);
  await sleep(250);
  if (isCancelled) return { ok: false, cancelled: true };

  emit('downloading', 100, totalBytes, '14.8 MB/s', formattedTotal + ' / ' + formattedTotal);
  await sleep(200);
  if (isCancelled) return { ok: false, cancelled: true };

  // Verifying phase
  emit('verifying', 100, totalBytes, '', formattedTotal + ' / ' + formattedTotal);
  await sleep(300);
  if (isCancelled) return { ok: false, cancelled: true };

  if (scenario === 'checksum') {
    return {
      ok: false,
      code: 'HASH_MISMATCH',
      error: 'Checksum mismatch.',
      friendlyText: 'The downloaded file could not be verified (checksum mismatch). The download may be corrupted.'
    };
  }

  // Extracting phase
  emit('extracting', 100, totalBytes, '', formattedTotal + ' / ' + formattedTotal);
  await sleep(300);
  if (isCancelled) return { ok: false, cancelled: true };

  if (scenario === 'permission') {
    return {
      ok: false,
      code: 'IO',
      error: 'Permission denied.',
      friendlyText: "Setup doesn't have permission to write to the destination folder. Check folder permissions and try again."
    };
  }

  if (scenario === 'corrupt') {
    return {
      ok: false,
      code: 'EXTRACTION_FAILED',
      error: 'Corrupt archive.',
      friendlyText: 'The LibreOffice archive is damaged or corrupt and could not be extracted.'
    };
  }

  // Testing phase
  emit('testing', 100, totalBytes, '', formattedTotal + ' / ' + formattedTotal);
  await sleep(300);
  if (isCancelled) return { ok: false, cancelled: true };

  // Done phase
  emit('done', 100, totalBytes, '', formattedTotal + ' / ' + formattedTotal);

  // Persist mock install record
  const r = setupState.load(userDataDir);
  const record = {
    status: 'installed',
    source: 'managed',
    path: '/mock/path/soffice',
    version: '26.2.6',
    installedAt: new Date().toISOString(),
    checkedAt: new Date().toISOString()
  };
  setupState.save(userDataDir, setupState.setComponent(r.state, 'libreoffice', record));

  return {
    ok: true,
    version: '26.2.6',
    path: '/mock/path/soffice'
  };
}

ipcMain.handle('setup:get-info', (event) => {
  if (!isSetupSender(event)) return null;
  return { name: APP_NAME, version: require('./package.json').version, setupMock: getSetupMockArg() };
});

ipcMain.handle('setup:get-license', (event) => {
  if (!isSetupSender(event)) return null;
  return setupState.readLicenseText(LICENSE_TXT);
});

ipcMain.handle('setup:get-state', (event) => {
  if (!isSetupSender(event)) return null;
  const r = setupState.load(app.getPath('userData'));
  return {
    licenseVersion: LICENSE_VERSION,
    licenseCurrent: setupState.isLicenseCurrent(r.state, LICENSE_VERSION),
    acceptedAt: r.state.acceptedAt,
    pdfSkipped: r.state.pdfSkipped === true,
    libreoffice: (r.state.components && r.state.components.libreoffice) || null,
    error: r.error || null
  };
});

ipcMain.handle('setup:accept-license', (event) => {
  if (!isSetupSender(event)) return { ok: false, error: 'Request not allowed.' };
  if (LICENSE_VERSION == null) return { ok: false, error: 'The license version could not be determined, so your acceptance cannot be recorded.' };
  const dir = app.getPath('userData');
  const r = setupState.load(dir);
  if (setupState.isLicenseCurrent(r.state, LICENSE_VERSION)) return { ok: true };
  return setupState.save(dir, setupState.acceptLicense(r.state, LICENSE_VERSION, APP_VERSION));
});

// Decline: confirm, then quit. Deliberately writes nothing, so setup stays incomplete.
ipcMain.handle('setup:decline', async (event) => {
  if (!isSetupSender(event)) return { quit: false };
  const { response } = await dialog.showMessageBox(setupWindow, {
    type: 'question',
    buttons: ['Cancel', 'Decline and Quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: APP_NAME + ' Setup',
    message: 'Decline the license agreement?',
    detail: APP_NAME + ' cannot be installed or used unless you accept the license agreement. Setup will close.'
  });
  if (response !== 1) return { quit: false };
  app.quit();
  return { quit: true };
});

ipcMain.handle('setup:get-manifest-info', (event) => {
  if (!isSetupSender(event)) return null;
  const key = installer.platformKey(process.platform, process.arch);
  const m = installer.loadManifest(installer.MANIFEST_FILE);
  const mock = getSetupMockArg();
  if (mock === 'unsupported' || !key || !m.ok) {
    return {
      supported: false,
      code: 'UNSUPPORTED_PLATFORM',
      officialUrl: 'https://www.libreoffice.org/download/download-libreoffice/',
      setupMock: mock
    };
  }
  const v = installer.validateEntry(m.manifest, key);
  if (!v.ok) {
    return {
      supported: false,
      code: v.code || 'UNSUPPORTED_PLATFORM',
      officialUrl: 'https://www.libreoffice.org/download/download-libreoffice/',
      setupMock: mock
    };
  }
  const totalBytes = v.entry.size_bytes;
  const formattedSize = totalBytes >= 1073741824 ? (totalBytes / 1073741824).toFixed(1) + ' GB' : Math.ceil(totalBytes / 1048576) + ' MB';
  let domain = 'download.documentfoundation.org';
  try {
    domain = new URL(v.entry.url).hostname;
  } catch (_) {}
  return {
    supported: true,
    platformKey: key,
    version: v.entry.version,
    sizeBytes: totalBytes,
    formattedSize,
    sourceDomain: domain,
    url: v.entry.url,
    officialUrl: 'https://www.libreoffice.org/download/download-libreoffice/',
    setupMock: mock
  };
});

ipcMain.handle('setup:check-components', async (event) => {
  if (!isSetupSender(event)) return null;
  const dir = app.getPath('userData');
  const res = await components.check(Object.assign(backendOpts(), { userDataDir: dir }));
  const mock = getSetupMockArg();
  if (mock) {
    // Under dev mock: pretend LibreOffice was not detected so card is tested
    return {
      items: res.items.map(it => it.id === 'office' ? { id: 'office', label: 'LibreOffice (optional)', required: false, status: 'info', statusText: 'Not found', detail: 'Presentation PDF export is unavailable; PowerPoint export works normally.' } : it),
      requiredOk: res.requiredOk,
      libreoffice: null
    };
  }
  const alreadyFound = !!(res && res.libreoffice && res.libreoffice.path);
  if (res && res.items) {
    res.items = res.items.map(it => {
      if (it.id === 'office' && alreadyFound) {
        return Object.assign({}, it, { status: 'ok', statusText: 'Already available' });
      }
      return it;
    });
  }
  // Persist what was detected (components.libreoffice {source, path, version, checkedAt}); a save failure never blocks the screen.
  if (res && res.libreoffice) {
    const r = setupState.load(dir);
    setupState.save(dir, setupState.setComponent(r.state, 'libreoffice', res.libreoffice));
  }
  return res ? { items: res.items, requiredOk: res.requiredOk, libreoffice: res.libreoffice } : res;
});

ipcMain.handle('setup:install-libreoffice', async (event) => {
  if (!isSetupSender(event)) return { ok: false, error: 'Unauthorized sender' };
  const dir = app.getPath('userData');
  const mock = getSetupMockArg();
  const key = installer.platformKey(process.platform, process.arch);
  const m = installer.loadManifest(installer.MANIFEST_FILE);
  const v = m.ok && key ? installer.validateEntry(m.manifest, key) : null;
  const totalBytes = v && v.ok ? v.entry.size_bytes : 217285735;

  if (mock) {
    return runMockInstall(mock, event.sender, totalBytes, dir);
  }

  const controller = new AbortController();
  activeInstallCancel = () => controller.abort();
  let lastBytes = 0;
  let lastTime = Date.now();
  let speedText = '0 MB/s';
  const formattedTotal = totalBytes >= 1073741824 ? (totalBytes / 1073741824).toFixed(1) + ' GB' : Math.ceil(totalBytes / 1048576) + ' MB';

  try {
    const res = await installer.install({
      userDataDir: dir,
      signal: controller.signal,
      onProgress: (p) => {
        const now = Date.now();
        const dt = (now - lastTime) / 1000;
        if (dt >= 0.4) {
          const speed = (p.receivedBytes - lastBytes) / dt;
          speedText = speed >= 1048576 ? (speed / 1048576).toFixed(1) + ' MB/s' : Math.round(speed / 1024) + ' KB/s';
          lastBytes = p.receivedBytes;
          lastTime = now;
        }
        const recMB = p.receivedBytes ? Math.ceil(p.receivedBytes / 1048576) : 0;
        const mbText = recMB + ' MB / ' + formattedTotal;
        event.sender.send('setup:install-progress', {
          phase: p.phase || 'downloading',
          percent: p.percent != null ? p.percent : 0,
          receivedBytes: p.receivedBytes || 0,
          totalBytes: p.totalBytes || totalBytes,
          speedText,
          mbText,
          message: p.message
        });
      }
    });
    activeInstallCancel = null;
    if (!res.ok) {
      if (res.cancelled) return { ok: false, cancelled: true };
      const mapped = friendlyInstallError(res.code, res.error);
      return Object.assign({ ok: false, code: res.code, error: res.error }, mapped);
    }
    return { ok: true, version: res.version, path: res.path };
  } catch (e) {
    activeInstallCancel = null;
    const mapped = friendlyInstallError(e.code, e.message);
    return Object.assign({ ok: false, code: e.code, error: e.message }, mapped);
  }
});

ipcMain.handle('setup:cancel-install', (event) => {
  if (!isSetupSender(event)) return { ok: false };
  if (activeInstallCancel) {
    try { activeInstallCancel(); } catch (_) {}
    activeInstallCancel = null;
  }
  if (activeMockCancel) {
    try { activeMockCancel(); } catch (_) {}
    activeMockCancel = null;
  }
  return { ok: true };
});

ipcMain.handle('setup:skip-libreoffice', (event) => {
  if (!isSetupSender(event)) return { ok: false };
  const dir = app.getPath('userData');
  const r = setupState.load(dir);
  const updated = setupState.setPdfSkipped(r.state, true);
  return setupState.save(dir, updated);
});

ipcMain.handle('setup:open-external', (event, url) => {
  if (!isSetupSender(event)) return false;
  if (typeof url === 'string' && /^https:\/\//.test(url)) {
    shell.openExternal(url);
    return true;
  }
  return false;
});

ipcMain.handle('setup:get-ready-validation', async (event) => {
  if (!isSetupSender(event)) return null;
  const dir = app.getPath('userData');
  const mock = getSetupMockArg();

  // 1. Check license current
  const r = setupState.load(dir);
  const licenseOk = setupState.isLicenseCurrent(r.state, LICENSE_VERSION);

  // 2. Check backend selfcheck OK
  let backendOk = false;
  let backendDetail = null;
  try {
    const be = components.resolveBackend(backendOpts());
    const sc = await components.runSelfcheck(be);
    const eng = components.engineItem(sc);
    backendOk = eng.status === 'ok';
    backendDetail = eng.detail;
  } catch (e) {
    backendOk = false;
    backendDetail = e && e.message;
  }

  // 3. Check state writable
  const testFile = path.join(dir, '.ready-write-test-' + process.pid);
  let stateWritable = false;
  let stateDetail = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    stateWritable = true;
  } catch (e) {
    try { fs.unlinkSync(testFile); } catch (_) {}
    stateWritable = false;
    stateDetail = e && e.message;
  }

  // 4. Managed LibreOffice re-probed if installed (or check detected/skipped)
  let pdfStatus = 'skipped'; // 'ready' | 'skipped'
  let pdfDetail = 'Export to PowerPoint works normally.';
  let loProbeOk = true;
  let loProbeDetail = null;

  if (mock) {
    if (r.state.pdfSkipped) {
      pdfStatus = 'skipped';
    } else {
      pdfStatus = 'ready';
    }
  } else {
    const lo = (r.state.components && r.state.components.libreoffice) || null;
    if (lo && lo.source === 'managed' && lo.path) {
      if (!fs.existsSync(lo.path)) {
        loProbeOk = false;
        loProbeDetail = 'Managed LibreOffice binary was deleted at ' + lo.path;
        pdfStatus = 'skipped';
        // Persist missing state
        const updatedLo = Object.assign({}, lo, { status: 'missing', reason: loProbeDetail });
        setupState.save(dir, setupState.setComponent(r.state, 'libreoffice', updatedLo));
      } else {
        // Re-probe managed installation
        try {
          const be = components.resolveBackend(backendOpts());
          const detectRes = await components.runDetectSoffice(be, dir);
          if (detectRes && detectRes.det && detectRes.det.status === 'found') {
            loProbeOk = true;
            pdfStatus = 'ready';
            pdfDetail = 'Version ' + (detectRes.det.version || lo.version || '') + ' ready.';
          } else {
            loProbeOk = false;
            loProbeDetail = (detectRes && detectRes.det && detectRes.det.reason) || (detectRes && detectRes.error) || 'LibreOffice verification failed.';
            pdfStatus = 'skipped';
          }
        } catch (e) {
          loProbeOk = false;
          loProbeDetail = e && e.message;
          pdfStatus = 'skipped';
        }
      }
    } else if (lo && lo.path && (lo.status === 'found' || lo.status === 'installed')) {
      if (fs.existsSync(lo.path)) {
        pdfStatus = 'ready';
        pdfDetail = (lo.version ? 'Version ' + lo.version + ' ' : '') + 'ready.';
      } else {
        pdfStatus = 'skipped';
      }
    } else {
      pdfStatus = 'skipped';
    }
  }

  const allPassed = licenseOk && backendOk && stateWritable && loProbeOk;

  return {
    allPassed,
    checks: {
      license: { ok: licenseOk, detail: licenseOk ? 'License accepted.' : 'License agreement has not been accepted.' },
      backend: { ok: backendOk, detail: backendDetail || (backendOk ? 'Application engine is healthy.' : 'Backend self-check failed.') },
      state: { ok: stateWritable, detail: stateWritable ? 'Settings folder is writable.' : (stateDetail || 'Cannot write to settings folder.') },
      libreoffice: { ok: loProbeOk, detail: loProbeDetail || 'Managed installation verified.' }
    },
    pdfExport: {
      status: pdfStatus, // 'ready' or 'skipped'
      detail: pdfDetail
    }
  };
});

ipcMain.handle('setup:complete', (event) => {
  if (!isSetupSender(event)) return { ok: false };
  const dir = app.getPath('userData');
  const r = setupState.load(dir);
  const saveRes = setupState.save(dir, setupState.markComplete(r.state));
  if (!saveRes.ok) {
    return { ok: false, error: saveRes.error || 'Failed to save completion state.' };
  }
  launchPending = true;
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.close();
  }
  launchApp();
  return { ok: true };
});

ipcMain.on('setup:exit', (event) => {
  if (!isSetupSender(event)) return;
  app.quit();
});

ipcMain.on('setup:window-control', (event, action) => {
  if (!isSetupSender(event)) return;
  if (action === 'minimize') {
    setupWindow.minimize();
  } else if (action === 'close') {
    setupWindow.close();
  }
});

// ---- Repair / re-setup wizard opened from the running app ----
let repairWindow = null;

function isRepairSender(event) {
  return !!(repairWindow && !repairWindow.isDestroyed() &&
    event.sender === repairWindow.webContents &&
    (!event.senderFrame || event.senderFrame === event.sender.mainFrame));
}

function openRepairWizard(mode) {
  // Only one repair window at a time.
  if (repairWindow && !repairWindow.isDestroyed()) {
    repairWindow.focus();
    return;
  }
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const scale = Math.min(1, wa.width / SETUP_W, wa.height / SETUP_H);
  const width = Math.round(SETUP_W * scale);
  const height = Math.round(SETUP_H * scale);

  repairWindow = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    modal: true,
    parent: mainWindow || undefined,
    icon: ICON_PATH,
    backgroundColor: '#702D3B',
    webPreferences: {
      preload: path.join(APP_DIR, 'setup', 'setup-preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
      additionalArguments: ['--repair-mode=' + (mode || 'repair')]
    }
  });

  const wc = repairWindow.webContents;
  wc.setVisualZoomLevelLimits(1, 1);
  wc.on('dom-ready', () => wc.setZoomFactor(scale));
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const zoomKey = (input.control || input.meta) && ['+', '-', '=', '0'].includes(input.key);
    if (input.key === 'Escape' || zoomKey) event.preventDefault();
  });
  wc.on('will-navigate', (event) => event.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));

  repairWindow.loadFile(path.join(APP_DIR, 'setup', 'setup.html'), {
    query: { repair: mode || 'repair' }
  });
  repairWindow.once('ready-to-show', () => {
    if (repairWindow && !repairWindow.isDestroyed()) {
      repairWindow.show();
      repairWindow.focus();
    }
  });
  repairWindow.on('closed', () => {
    repairWindow = null;
    // After repair wizard closes, notify the main window so it can refresh its state
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:setup-closed');
    }
  });
}

ipcMain.handle('app:open-setup', (event, mode) => {
  // Only allowed from the main app window
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { ok: false };
  openRepairWizard(mode || 'repair');
  return { ok: true };
});

// Repair wizard needs read-only access to most setup IPC channels.
// Re-use the existing handlers but expand the sender check to include repairWindow.
const _origIsSetupSender = isSetupSender;
// Patch isSetupSender to also accept repairWindow (done inline via a second helper used below).

ipcMain.handle('repair:get-info', (event) => {
  if (!isRepairSender(event)) return null;
  const r = setupState.load(app.getPath('userData'));
  return {
    name: APP_NAME,
    version: require('./package.json').version,
    licenseCurrent: setupState.isLicenseCurrent(r.state, LICENSE_VERSION),
    libreoffice: (r.state.components && r.state.components.libreoffice) || null,
    pdfSkipped: r.state.pdfSkipped === true
  };
});

ipcMain.handle('repair:check-components', async (event) => {
  if (!isRepairSender(event)) return null;
  const dir = app.getPath('userData');
  const res = await components.check(Object.assign(backendOpts(), { userDataDir: dir }));
  if (res && res.libreoffice) {
    const r = setupState.load(dir);
    setupState.save(dir, setupState.setComponent(r.state, 'libreoffice', res.libreoffice));
  }
  return res ? { items: res.items, requiredOk: res.requiredOk, libreoffice: res.libreoffice } : res;
});

ipcMain.handle('repair:install-libreoffice', async (event) => {
  if (!isRepairSender(event)) return { ok: false, error: 'Unauthorized sender' };
  // Delegate to the same install handler
  const fakeEvent = { sender: setupWindow ? setupWindow.webContents : event.sender, senderFrame: null };
  // Directly replicate logic (we cannot call the ipcMain handler directly)
  const dir = app.getPath('userData');
  const key = installer.platformKey(process.platform, process.arch);
  const m = installer.loadManifest(installer.MANIFEST_FILE);
  const v = m.ok && key ? installer.validateEntry(m.manifest, key) : null;
  const totalBytes = v && v.ok ? v.entry.size_bytes : 217285735;
  const controller = new AbortController();
  activeInstallCancel = () => controller.abort();
  let lastBytes = 0, lastTime = Date.now(), speedText = '0 MB/s';
  const formattedTotal = totalBytes >= 1073741824 ? (totalBytes / 1073741824).toFixed(1) + ' GB' : Math.ceil(totalBytes / 1048576) + ' MB';
  try {
    const res = await installer.install({
      userDataDir: dir,
      signal: controller.signal,
      onProgress: (p) => {
        const now = Date.now(), dt = (now - lastTime) / 1000;
        if (dt >= 0.4) {
          const speed = (p.receivedBytes - lastBytes) / dt;
          speedText = speed >= 1048576 ? (speed / 1048576).toFixed(1) + ' MB/s' : Math.round(speed / 1024) + ' KB/s';
          lastBytes = p.receivedBytes; lastTime = now;
        }
        const recMB = p.receivedBytes ? Math.ceil(p.receivedBytes / 1048576) : 0;
        event.sender.send('repair:install-progress', {
          phase: p.phase || 'downloading', percent: p.percent != null ? p.percent : 0,
          receivedBytes: p.receivedBytes || 0, totalBytes: p.totalBytes || totalBytes,
          speedText, mbText: recMB + ' MB / ' + formattedTotal, message: p.message
        });
      }
    });
    activeInstallCancel = null;
    if (!res.ok) { if (res.cancelled) return { ok: false, cancelled: true }; return { ok: false, code: res.code, error: res.error }; }
    return { ok: true, version: res.version, path: res.path };
  } catch (e) { activeInstallCancel = null; return { ok: false, code: e.code, error: e.message }; }
});

ipcMain.handle('repair:cancel-install', (event) => {
  if (!isRepairSender(event)) return { ok: false };
  if (activeInstallCancel) { try { activeInstallCancel(); } catch (_) {} activeInstallCancel = null; }
  return { ok: true };
});

ipcMain.handle('repair:remove-managed', async (event) => {
  if (!isRepairSender(event)) return { ok: false, error: 'Unauthorized sender' };
  const dir = app.getPath('userData');
  const r = setupState.load(dir);
  const lo = (r.state.components && r.state.components.libreoffice) || null;
  if (!lo || lo.source !== 'managed') return { ok: false, error: 'No managed LibreOffice to remove.' };
  // Only delete the app-managed folder: <userData>/components/libreoffice
  const managedDir = path.join(dir, 'components', 'libreoffice');
  try {
    if (fs.existsSync(managedDir)) {
      fs.rmSync(managedDir, { recursive: true, force: true });
    }
    const updated = setupState.setComponent(r.state, 'libreoffice', { status: 'missing', source: null, path: null, removedAt: new Date().toISOString() });
    setupState.save(dir, updated);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('repair:skip-libreoffice', (event) => {
  if (!isRepairSender(event)) return { ok: false };
  const dir = app.getPath('userData');
  const r = setupState.load(dir);
  return setupState.save(dir, setupState.setPdfSkipped(r.state, true));
});

ipcMain.handle('repair:get-license', (event) => {
  if (!isRepairSender(event)) return null;
  return setupState.readLicenseText(LICENSE_TXT);
});

ipcMain.handle('repair:get-manifest-info', (event) => {
  if (!isRepairSender(event)) return null;
  const key = installer.platformKey(process.platform, process.arch);
  const m = installer.loadManifest(installer.MANIFEST_FILE);
  if (!key || !m.ok) return { supported: false, code: 'UNSUPPORTED_PLATFORM', officialUrl: 'https://www.libreoffice.org/download/download-libreoffice/' };
  const v = installer.validateEntry(m.manifest, key);
  if (!v.ok) return { supported: false, code: v.code || 'UNSUPPORTED_PLATFORM', officialUrl: 'https://www.libreoffice.org/download/download-libreoffice/' };
  const totalBytes = v.entry.size_bytes;
  const formattedSize = totalBytes >= 1073741824 ? (totalBytes / 1073741824).toFixed(1) + ' GB' : Math.ceil(totalBytes / 1048576) + ' MB';
  let domain = 'download.documentfoundation.org';
  try { domain = new URL(v.entry.url).hostname; } catch (_) {}
  return { supported: true, platformKey: key, version: v.entry.version, sizeBytes: totalBytes, formattedSize, sourceDomain: domain, url: v.entry.url, officialUrl: 'https://www.libreoffice.org/download/download-libreoffice/' };
});

ipcMain.handle('repair:open-external', (event, url) => {
  if (!isRepairSender(event)) return false;
  if (typeof url === 'string' && /^https:\/\//.test(url)) { shell.openExternal(url); return true; }
  return false;
});

ipcMain.on('repair:window-control', (event, action) => {
  if (!isRepairSender(event)) return;
  if (repairWindow && !repairWindow.isDestroyed()) {
    if (action === 'close') repairWindow.close();
    else if (action === 'minimize') repairWindow.minimize();
  }
});

app.on('second-instance', () => {
  if (setupWindow && !setupWindow.isDestroyed()) {
    if (setupWindow.isMinimized()) setupWindow.restore();
    setupWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (launchPending) return;
  cleanup();
  app.quit();
});

app.on('before-quit', () => {
  cleanup();
});

app.whenReady().then(async () => {
  if (!gotSetupLock) return;
  if (SETUP_MODE) {
    createSetupWindow();
    return;
  }
  launchApp();
});
