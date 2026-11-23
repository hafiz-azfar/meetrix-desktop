const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const statusChannel = 'meetrix:speech-result';
const timeoutMessage = 'Automatic captions stopped because local recognition did not respond.';
const required = ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll',
  'encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'];

function bindSpeech({ ipcMain, utilityProcess, runtime, authorize }) {
  const directory = join(runtime, 'speech');
  let active;

  function available() {
    return process.platform === 'win32' && process.arch === 'x64' && required.every(name => existsSync(join(directory, name)));
  }

  function cancel(state, message) {
    if (state.closing) return;
    state.closing = true;
    clearTimeout(state.timer);
    clearTimeout(state.lifetime);
    const problem = new Error(message || 'Automatic captions stopped.');
    state.rejectStart(problem);
    state.pending?.reject(problem);
    state.pending = null;
    if (message && !state.frame.detached && !state.sender.isDestroyed()) {
      state.frame.send(statusChannel, { id: state.id, error: message });
    }
    state.child.kill();
  }

  function resetTimeout(state, time, message) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => cancel(state, message), time);
  }

  async function start(event) {
    if (!authorize(event) || !available()) throw new Error('Offline captions are unavailable in this workspace.');
    if (active?.closing) await active.exited;
    if (!authorize(event)) throw new Error('This workspace changed while automatic captions were starting.');
    if (active) throw new Error('A speech recognition session is already starting or running.');
    const frame = event.senderFrame;
    const sender = event.sender;
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP']
      .filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const child = utilityProcess.fork(join(__dirname, 'speech-worker.cjs'), [directory], {
      cwd: directory, env, stdio: 'ignore', serviceName: 'Meetrix offline speech recognition',
    });
    const state = { child, frame, sender, id: randomUUID(), credit: 0.6, latest: performance.now() };
    active = state;
    const onNavigation = options => {
      if (options.isMainFrame && !options.isSameDocument) cancel(state);
    };
    const onGone = () => cancel(state);
    sender.on('did-start-navigation', onNavigation);
    sender.once('render-process-gone', onGone);
    sender.once('destroyed', onGone);
    child.on('spawn', () => { if (state.closing) child.kill(); });
    state.exited = new Promise(resolve => child.once('exit', () => {
      cancel(state, 'Offline speech recognition exited.');
      sender.removeListener('did-start-navigation', onNavigation);
      sender.removeListener('render-process-gone', onGone);
      sender.removeListener('destroyed', onGone);
      if (active === state) active = null;
      resolve();
    }));
    state.lifetime = setTimeout(() => cancel(state, 'Restart automatic captions to continue.'), 2 * 60 * 60 * 1000);
    resetTimeout(state, 20000, 'Offline speech recognition could not start.');
    return new Promise((resolve, reject) => {
      state.rejectStart = reject;
      child.on('message', event => {
        if (active !== state || state.closing) return;
        if (event?.kind === 'ready') {
          state.ready = true;
          resetTimeout(state, 30000, timeoutMessage);
          resolve(state.id);
        } else if (event?.kind === 'processed' && state.pending) {
          const { result } = event;
          if (result && typeof result.text === 'string' && result.text.length <= 240 && typeof result.final === 'boolean' &&
              !frame.detached && !sender.isDestroyed()) {
            frame.send(statusChannel, { id: state.id, text: result.text, final: result.final });
          }
          state.pending.resolve();
          state.pending = null;
          resetTimeout(state, 30000, timeoutMessage);
        } else if (event?.kind === 'error') cancel(state, 'Offline speech recognition could not process audio.');
      });
    });
  }

  function ownSession(event, id) {
    return authorize(event) && active && !active.closing && active.id === id && event.senderFrame === active.frame
      ? active : null;
  }

  function push(event, id, samples, sampleRate) {
    const state = ownSession(event, id);
    if (!state?.ready) throw new Error('Automatic captions are inactive.');
    if (state.pending) throw new Error('The recognizer is processing a previous audio packet.');
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000 ||
        !(samples instanceof Float32Array) || !samples.length || samples.length > sampleRate / 2 ||
        !samples.every(value => value >= -1 && value <= 1)) throw new Error('The caption audio packet is invalid.');
    const now = performance.now();
    state.credit = Math.min(0.8, state.credit + (now - state.latest) / 1000 * 1.15);
    state.latest = now;
    const seconds = samples.length / sampleRate;
    if (seconds > state.credit) throw new Error('Caption audio exceeded the real-time input limit.');
    state.credit -= seconds;
    resetTimeout(state, 10000, timeoutMessage);
    return new Promise((resolve, reject) => {
      state.pending = { resolve, reject };
      try { state.child.postMessage({ samples, sampleRate }); }
      catch { cancel(state, timeoutMessage); }
    });
  }

  ipcMain.handle('meetrix:speech-available', event => authorize(event) && available());
  ipcMain.handle('meetrix:speech-start', start);
  ipcMain.handle('meetrix:speech-push', push);
  ipcMain.handle('meetrix:speech-stop', async (event, id) => {
    const state = ownSession(event, id);
    if (!state) return;
    cancel(state);
    await state.exited;
  });

  return () => { if (active) cancel(active); };
}

module.exports = { bindSpeech };
