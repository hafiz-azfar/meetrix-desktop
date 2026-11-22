const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('meetrix', Object.freeze({
  settings: () => ipcRenderer.invoke('meetrix:settings'),
  connect: value => ipcRenderer.invoke('meetrix:connect', value),
}));
