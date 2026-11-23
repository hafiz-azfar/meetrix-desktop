const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('meetrix', Object.freeze({
  settings: () => ipcRenderer.invoke('meetrix:settings'),
  connect: value => ipcRenderer.invoke('meetrix:connect', value),
  configureInsForge: (url, key) => ipcRenderer.invoke('meetrix:configure-insforge', url, key),
}));
