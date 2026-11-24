import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(resolve(output, 'windows-system-'));
const executablePath = process.env.MEETRIX_EXE || resolve('release/win-unpacked/Meetrix InsForge.exe');
const args = ['--user-data-dir=' + profile];
const app = await electron.launch(existsSync(executablePath) ? { executablePath, args } : { args: ['.', ...args] });

try {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Continue in your browser' }).waitFor({ timeout: 30000 });
  await app.evaluate(({ Notification }) => {
    globalThis.meetrixTestNotices = [];
    Notification.prototype.show = function () {
      globalThis.meetrixTestNotices.push({ title: this.title, body: this.body });
      this.emit('click');
    };
  });
  const preferences = await page.evaluate(() => window.meetrixDesktop.setDesktopPreferences({ tray: true, reminders: true }));
  assert.deepEqual(preferences, { tray: true, reminders: true });
  await assert.rejects(page.evaluate(() => window.meetrixDesktop.setMeetingReminders([
    { id: ['test-reminder001'], startAt: Date.now() },
  ])), /reminder list is invalid/);

  const windowState = () => app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    return { visible: main.isVisible(), minimized: main.isMinimized() };
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await expectEventually(async () => !(await windowState()).visible, 'notification-area minimize hides the window');
  await page.evaluate(() => window.meetrixDesktop.setMeetingReminders([
    { id: 'test-reminder001', startAt: Date.now() + 120000, title: 'Private title' },
  ]));
  const readNotices = () => app.evaluate(() => globalThis.meetrixTestNotices);
  await expectEventually(async () => (await readNotices()).length === 1, 'meeting reminder fires');
  assert.deepEqual(await readNotices(), [{ title: 'Meetrix', body: 'A scheduled meeting starts soon.' }]);
  await expectEventually(async () => (await windowState()).visible, 'notification opens the window');
  await delay(15500);
  assert.equal((await readNotices()).length, 1, 'same meeting reminder is deduplicated');

  assert.deepEqual(await page.evaluate(() => window.meetrixDesktop.setDesktopPreferences({ tray: false, reminders: false })),
    { tray: false, reminders: false });
  console.log('Windows tray minimizes the workspace. Private reminder opens it and deduplicates repeated checks.');
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 4 });
}

async function expectEventually(check, message) {
  const deadline = Date.now() + 20000;
  do {
    if (await check()) return;
    await delay(200);
  } while (Date.now() < deadline);
  assert.fail(message);
}
