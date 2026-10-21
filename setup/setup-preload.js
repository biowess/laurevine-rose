const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupAPI', {
  getInfo: () => ipcRenderer.invoke('setup:get-info'),
  getLicense: () => ipcRenderer.invoke('setup:get-license'),
  getState: () => ipcRenderer.invoke('setup:get-state'),
  acceptLicense: () => ipcRenderer.invoke('setup:accept-license'),
  decline: () => ipcRenderer.invoke('setup:decline'),
  checkComponents: () => ipcRenderer.invoke('setup:check-components'),
  getManifestInfo: () => ipcRenderer.invoke('setup:get-manifest-info'),
  installLibreOffice: () => ipcRenderer.invoke('setup:install-libreoffice'),
  cancelInstall: () => ipcRenderer.invoke('setup:cancel-install'),
  skipLibreOffice: () => ipcRenderer.invoke('setup:skip-libreoffice'),
  openExternal: (url) => ipcRenderer.invoke('setup:open-external', url),
  getReadyValidation: () => ipcRenderer.invoke('setup:get-ready-validation'),
  complete: () => ipcRenderer.invoke('setup:complete'),
  onInstallProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('setup:install-progress', handler);
    return () => ipcRenderer.removeListener('setup:install-progress', handler);
  },
  exit: () => ipcRenderer.send('setup:exit'),
  minimize: () => ipcRenderer.send('setup:window-control', 'minimize'),
  close: () => ipcRenderer.send('setup:window-control', 'close')
});

// repairAPI — same capabilities but wired to the repair:* channels (used when the
// wizard is opened as a modal child of the running app, not during initial setup).
contextBridge.exposeInMainWorld('repairAPI', {
  getInfo: () => ipcRenderer.invoke('repair:get-info'),
  getLicense: () => ipcRenderer.invoke('repair:get-license'),
  checkComponents: () => ipcRenderer.invoke('repair:check-components'),
  getManifestInfo: () => ipcRenderer.invoke('repair:get-manifest-info'),
  installLibreOffice: () => ipcRenderer.invoke('repair:install-libreoffice'),
  cancelInstall: () => ipcRenderer.invoke('repair:cancel-install'),
  skipLibreOffice: () => ipcRenderer.invoke('repair:skip-libreoffice'),
  removeManaged: () => ipcRenderer.invoke('repair:remove-managed'),
  openExternal: (url) => ipcRenderer.invoke('repair:open-external', url),
  onInstallProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('repair:install-progress', handler);
    return () => ipcRenderer.removeListener('repair:install-progress', handler);
  },
  close: () => ipcRenderer.send('repair:window-control', 'close'),
  minimize: () => ipcRenderer.send('repair:window-control', 'minimize'),
  // Tells the wizard whether it is in repair mode (query param set by main.js)
  isRepairMode: () => {
    try { return new URLSearchParams(window.location.search).get('repair') === 'repair'; } catch (_) { return false; }
  }
});
