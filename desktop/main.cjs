const { app, BrowserWindow, Menu, desktopCapturer, dialog, ipcMain, session } = require('electron');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const { startLocal } = require('./local.cjs');

let window;
let settingsWindow;
let local;
let activeOrigin;
let startupNotice = '';
let changing = false;
const settingsFile = join(__dirname, 'connect.html');
const localOrigin = 'http://127.0.0.1:4317';
let configPath;

function originOf(value) {
  try { return new URL(value).origin; } catch { return null; }
}

function serverOrigin(value) {
  if (typeof value !== 'string' || value.length > 300) throw new Error('Enter an HTTPS server address.');
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.href !== url.origin + '/' || url.username || url.password) {
    throw new Error('Enter a server origin such as https://meet.example.com');
  }
  return url.origin;
}

function readServer() {
  try { return serverOrigin(JSON.parse(readFileSync(configPath, 'utf8')).server); }
  catch { return null; }
}

function sameOrigin(value, origin) {
  return originOf(value) === origin;
}

function configureSession(browserSession, origin) {
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    details.isMainFrame && ['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission)
      && sameOrigin(requestingOrigin, origin) && sameOrigin(contents?.getURL(), origin));
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const fromWorkspace = details.isMainFrame && sameOrigin(details.requestingUrl, origin) && sameOrigin(contents.getURL(), origin);
    const media = permission === 'media' && details.mediaTypes?.every(type => type === 'audio' || type === 'video');
    const allowed = fromWorkspace && (media || permission === 'display-capture' || permission === 'clipboard-sanitized-write');
    callback(Boolean(allowed));
  });
  browserSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.userGesture || !sameOrigin(request.securityOrigin, origin)
      || !request.frame || request.frame.parent || !sameOrigin(request.frame.url, origin)) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const choices = sources.slice(0, 12);
      if (!choices.length || !window || window.isDestroyed()) return callback({});
      const cancel = choices.length;
      const result = await dialog.showMessageBox(window, {
        title: 'Share your screen', message: 'Choose a display or window to share',
        detail: 'Everyone in the meeting can see the source you choose.',
        buttons: [...choices.map(choice => choice.name), 'Cancel'],
        defaultId: cancel, cancelId: cancel, noLink: true,
      });
      callback(result.response === cancel ? {} : { video: choices[result.response] });
    } catch { callback({}); }
  });
}

function guardNavigation(contents, origin) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const event of ['will-navigate', 'will-redirect']) {
    contents.on(event, (navigationEvent, url) => {
      if (!sameOrigin(url, origin)) navigationEvent.preventDefault();
    });
  }
}

function settings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    title: 'Connect Meetrix', width: 565, height: 495, minWidth: 480, minHeight: 430,
    backgroundColor: '#111817',
    webPreferences: { preload: join(__dirname, 'connect-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
  });
  settingsWindow.removeMenu();
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
  settingsWindow.webContents.on('will-redirect', event => event.preventDefault());
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.loadFile(settingsFile);
}

async function open(origin) {
  const partition = 'persist:meetrix-' + createHash('sha256').update(origin).digest('hex').slice(0, 20);
  const browserSession = session.fromPartition(partition);
  configureSession(browserSession, origin);
  const previous = window;
  const next = new BrowserWindow({
    title: 'Meetrix', width: 1220, height: 820, minWidth: 700, minHeight: 560,
    backgroundColor: '#111817', show: false, icon: join(__dirname, 'icon.ico'),
    webPreferences: { session: browserSession, nodeIntegration: false, contextIsolation: true, sandbox: true,
      devTools: !app.isPackaged, spellcheck: false },
  });
  guardNavigation(next.webContents, origin);
  next.on('closed', () => { if (window === next) window = null; });
  try {
    await next.loadURL(origin);
  } catch (error) {
    next.destroy();
    throw error;
  }
  window = next;
  activeOrigin = origin;
  next.show();
  previous?.destroy();
}

function requireSettings(event) {
  if (!settingsWindow || event.sender !== settingsWindow.webContents
    || event.senderFrame?.url !== pathToFileURL(settingsFile).href) throw new Error('Settings window required.');
}

function bindSettings() {
  ipcMain.handle('meetrix:settings', event => {
    requireSettings(event);
    return { server: activeOrigin === localOrigin ? readServer() : activeOrigin || readServer(), local: Boolean(local), notice: startupNotice };
  });
  ipcMain.handle('meetrix:connect', async (event, value) => {
    requireSettings(event);
    if (changing) return { error: 'A connection is already in progress.' };
    changing = true;
    try {
      const origin = value === 'local' && local ? local.origin : serverOrigin(value);
      if (origin !== localOrigin) {
        const result = await fetch(origin + '/api/config', { redirect: 'error', signal: AbortSignal.timeout(8000) });
        if (!result.ok || !result.headers.get('content-type')?.includes('application/json')
          || !(await result.json()).clerkPublishableKey) throw new Error('That address did not return a Meetrix configuration.');
      }
      await open(origin);
      writeFileSync(configPath, JSON.stringify({ server: origin === localOrigin ? null : origin }), { mode: 0o600 });
      settingsWindow?.close();
      return {};
    } catch (error) {
      return { error: error.message || 'Could not connect to this server.' };
    } finally { changing = false; }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) window.focus(); else settings(); });
  app.on('window-all-closed', () => { if (!changing) app.quit(); });
  app.on('before-quit', () => local?.stop());
  app.whenReady().then(async () => {
    app.setAppUserModelId('dev.meetrix.desktop');
    configPath = join(app.getPath('userData'), 'server.json');
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Meetrix', submenu: [
      { label: 'Connect to a server…', click: settings }, { type: 'separator' }, { role: 'quit' },
    ] }, { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]));
    bindSettings();
    try {
      local = await startLocal({
        directory: join(app.getPath('userData'), 'local'),
        runtime: app.isPackaged ? join(process.resourcesPath, 'runtime') : join(__dirname, '..', 'vendor', 'runtime'),
      });
    } catch { startupNotice = 'The local meeting server could not start. You can still connect to a hosted Meetrix server.'; }
    try {
      const origin = readServer() || local?.origin;
      if (origin) await open(origin);
      else settings();
    } catch {
      startupNotice = 'The saved server could not be reached. Check the address, or open the local workspace.';
      settings();
    }
  });
}
