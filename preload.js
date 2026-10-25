const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  minimize: () => ipcRenderer.send('window-control', 'minimize'),
  maximize: () => ipcRenderer.send('window-control', 'maximize'),
  close: (force) => ipcRenderer.send('window-control', force ? 'force-close' : 'close'),
  forceClose: () => ipcRenderer.send('window-control', 'force-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onMaximizeChange: (callback) => {
    ipcRenderer.on('window-maximize-changed', (_event, isMax) => {
      if (typeof callback === 'function') {
        callback(isMax);
      }
    });
  },
  onRequestClose: (callback) => {
    ipcRenderer.on('app:request-close', () => {
      if (typeof callback === 'function') {
        callback();
      }
    });
  },
  openSetup: (mode) => ipcRenderer.invoke('app:open-setup', mode),
  getLegalDoc: (key) => ipcRenderer.invoke('app:get-legal-doc', key)
});