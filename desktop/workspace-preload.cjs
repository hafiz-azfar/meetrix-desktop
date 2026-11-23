const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetrixDesktop', Object.freeze({
  openSignIn: request => ipcRenderer.invoke('meetrix:browser-sign-in', request),
}));
