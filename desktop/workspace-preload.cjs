const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetrixDesktop', Object.freeze({
  openSignIn: request => ipcRenderer.invoke('meetrix:browser-sign-in', request),
  speech: Object.freeze({
    available: () => ipcRenderer.invoke('meetrix:speech-available'),
    start: () => ipcRenderer.invoke('meetrix:speech-start'),
    push(id, samples, sampleRate) {
      if (typeof id !== 'string' || id.length !== 36 || !(samples instanceof Float32Array) || samples.length > 48000) {
        return Promise.reject(new Error('The caption audio packet is invalid.'));
      }
      return ipcRenderer.invoke('meetrix:speech-push', id, samples, sampleRate);
    },
    stop: id => typeof id === 'string' && id.length === 36 ? ipcRenderer.invoke('meetrix:speech-stop', id) : Promise.resolve(),
    onResult(callback) {
      if (typeof callback !== 'function') throw new TypeError('A caption callback is required.');
      const listener = (_event, result) => callback(result);
      ipcRenderer.on('meetrix:speech-result', listener);
      return () => ipcRenderer.removeListener('meetrix:speech-result', listener);
    },
  }),
}));
