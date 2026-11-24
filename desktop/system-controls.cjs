const { Menu, Notification, Tray } = require('electron');

const hour = 60 * 60 * 1000;
const timeToNotify = 5 * 60_000;
const meetingId = /^[A-Za-z0-9_-]{16}$/;

function desktopControls({ app, icon, currentWindow, ipcMain, authorize }) {
  let tray;
  let minimize = false;
  let alerts = false;
  let scheduled = [];
  const notified = new Map();
  let notice;

  function reveal() {
    const window = currentWindow();
    if (!window || window.isDestroyed()) return false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return true;
  }
  function clearReminders() {
    scheduled = [];
    notice?.close();
    notice = null;
  }
  function reset() {
    scheduled = [];
    notified.clear();
    notice?.close();
    notice = null;
    minimize = false;
    alerts = false;
    tray?.destroy();
    tray = null;
  }

  ipcMain.handle('meetrix:desktop-preferences', (event, preferences) => {
    if (!authorize(event) || typeof preferences?.tray !== 'boolean' || typeof preferences?.reminders !== 'boolean') {
      throw new Error('Use desktop preferences in your workspace.');
    }
    minimize = preferences.tray;
    alerts = preferences.reminders;
    if (!alerts) clearReminders();
    if (!minimize && tray) {
      reveal();
      tray.destroy();
      tray = null;
    }
    if (minimize && !tray) {
      try {
        tray = new Tray(icon);
        tray.setToolTip('Meetrix');
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: 'Open Meetrix', click: reveal },
          { type: 'separator' },
          { label: 'Quit Meetrix', click: () => app.quit() },
        ]));
        tray.on('double-click', reveal);
      } catch { minimize = false; tray?.destroy(); tray = null; }
    }
    return { tray: minimize, reminders: alerts && Notification.isSupported() };
  });

  ipcMain.handle('meetrix:meeting-reminders', (event, entries) => {
    if (!authorize(event) || !Array.isArray(entries) || entries.length > 100 ||
        entries.some(item => typeof item?.id !== 'string' || !meetingId.test(item.id) || !Number.isSafeInteger(item.startAt))) {
      throw new Error('This reminder list is invalid.');
    }
    if (!entries.length) clearReminders();
    else if (alerts) scheduled = entries.filter(item => item.startAt <= Date.now() + 7 * 24 * hour);
  });

  function tick() {
    if (!alerts || !scheduled.length || !Notification.isSupported() || !currentWindow()) return;
    const now = Date.now();
    for (const [id, time] of notified) if (now - time > hour) notified.delete(id);
    const due = scheduled.filter(item => item.startAt >= now - 60000 && item.startAt <= now + timeToNotify &&
      !notified.has(item.id + ':' + item.startAt));
    if (!due.length) return;
    for (const item of due) notified.set(item.id + ':' + item.startAt, now);
    notice?.close();
    notice = new Notification({
      title: 'Meetrix', body: due.length === 1 ? 'A scheduled meeting starts soon.' : 'You have scheduled meetings starting soon.',
    });
    notice.on('click', reveal);
    notice.show();
  }
  const timer = setInterval(tick, 15000);
  timer.unref();
  app.once('before-quit', () => { clearInterval(timer); reset(); });

  return {
    attach(window) {
      window.on('minimize', () => { if (minimize && tray && currentWindow() === window) window.hide(); });
    },
    reveal, reset, clearReminders,
  };
}

module.exports = { desktopControls };
