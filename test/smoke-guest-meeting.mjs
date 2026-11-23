import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startLocal } from '../desktop/local.cjs';

const results = resolve('test-results');
await mkdir(results, { recursive: true });
const directory = await mkdtemp(resolve(results, 'guest-meeting-'));
let backend;
let browser;
try {
  backend = await startLocal({
    directory, runtime: resolve('vendor/runtime'), origin: 'http://127.0.0.1:0',
    instance: { insforgeUrl: 'https://auth.meetrix.test' },
    dependencies: { createAuth: () => ({
      async getPublicAuthConfig() { return { data: { oAuthProviders: [] } }; },
      async signInWithPassword() {
        return { data: { accessToken: 'test-token', user: { id: '4e5c7bb9-0218-4d57-b9c0-4ff45db24395', profile: { name: 'Alex Morgan' } } } };
      },
    }) },
  });
  const origin = backend.origin;
  browser = await chromium.launch({
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'],
  });
  const host = await browser.newPage({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
  const guest = await browser.newPage({ permissions: ['camera', 'microphone'] });
  await host.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async options => {
      window.testShareOptions = options;
      const stream = await navigator.mediaDevices.getUserMedia({ video: options.video });
      window.testShareTrack = stream.getVideoTracks()[0];
      return stream;
    };
  });
  const hostSignIn = await host.request.post(origin + '/api/auth/email/password', {
    headers: { Origin: origin }, data: { email: 'host@example.test', password: 'test-password' },
  });
  assert.equal(hostSignIn.status(), 200);

  await host.goto(origin);
  await host.getByText('Your schedule is clear').waitFor();
  await host.getByRole('button', { name: 'Schedule meeting', exact: true }).click();
  await host.getByLabel('Meeting name').fill('Weekly team check-in');
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const localTime = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await host.getByLabel('Start time').fill(localTime);
  await host.getByRole('dialog').getByRole('button', { name: 'Schedule', exact: true }).click();
  await host.getByText('Weekly team check-in', { exact: true }).waitFor();
  await host.getByRole('button', { name: 'Home', exact: true }).click();
  await host.getByText('Weekly team check-in', { exact: true }).waitFor();
  await host.screenshot({ path: resolve(results, 'meetrix-home.png') });
  await host.getByRole('button', { name: 'Settings', exact: true }).click();
  await host.getByRole('heading', { name: 'Audio', exact: true }).waitFor();
  await host.screenshot({ path: resolve(results, 'meetrix-settings.png') });

  const volume = host.getByRole('slider', { name: 'Speaker volume' });
  await volume.press('ArrowLeft');
  await host.waitForFunction(() => JSON.parse(localStorage.getItem('meetrix-devices')).speakerVolume === 0.99);
  await host.getByRole('button', { name: 'Check microphone', exact: true }).click();
  await host.getByText('Speak to check the input level.').waitFor();
  await host.getByRole('button', { name: 'Stop microphone check' }).click();
  await host.getByRole('button', { name: 'Play test tone' }).click();
  await host.getByRole('button', { name: 'Playing test tone…' }).waitFor();
  await host.getByRole('button', { name: 'Play test tone' }).waitFor();

  await host.getByRole('button', { name: 'Video', exact: true }).click();
  await host.getByRole('button', { name: 'Start camera preview' }).click();
  await host.waitForFunction(() => document.querySelector('.video-settings video')?.readyState >= 2);
  const track = await host.locator('.video-settings video').evaluateHandle(video => video.srcObject.getVideoTracks()[0]);
  await host.getByLabel('Mirror my local view').uncheck();
  assert.equal(await host.locator('.video-settings video').evaluate(video => getComputedStyle(video).transform), 'none');
  await host.getByRole('button', { name: 'Meeting defaults' }).click();
  assert.equal(await track.evaluate(videoTrack => videoTrack.readyState), 'ended');
  await track.dispose();
  await host.getByLabel('Starting layout').selectOption('speaker');
  await host.waitForFunction(() => JSON.parse(localStorage.getItem('meetrix-devices')).layout === 'speaker');
  await host.getByLabel('Show elapsed time').check();
  await host.waitForFunction(() => JSON.parse(localStorage.getItem('meetrix-devices')).meetingTimer === true);
  await host.getByRole('button', { name: 'Appearance' }).click();
  await host.getByLabel('App theme').selectOption('dark');
  await host.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === 'dark');
  await host.screenshot({ path: resolve(results, 'meetrix-settings-dark.png') });
  await host.reload();
  await host.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await host.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
  assert.equal(await host.evaluate(() => JSON.parse(localStorage.getItem('meetrix-devices')).meetingTimer), true);
  await host.getByRole('button', { name: 'Appearance' }).click();
  await host.getByLabel('App theme').selectOption('light');
  await host.getByRole('button', { name: 'Accessibility', exact: true }).click();
  await host.getByLabel('Meeting chat text size').selectOption('largest');
  await host.getByLabel('Announce new messages in the open chat panel').uncheck();
  await host.getByLabel('Reduce motion').check();
  await host.waitForFunction(() => document.documentElement.dataset.reducedMotion === 'true');
  await host.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  const cameraShortcut = host.getByLabel('Toggle camera', { exact: true });
  assert.equal(await cameraShortcut.locator('option[value="M"]').isDisabled(), true);
  await cameraShortcut.selectOption('K');
  await host.getByRole('button', { name: 'Screen sharing', exact: true }).click();
  await host.getByLabel('Capture frame rate').selectOption('5');
  await host.getByLabel('Content priority').selectOption('text');
  await host.getByLabel('Shared screen layout').selectOption('side');
  await host.setViewportSize({ width: 390, height: 844 });
  await host.getByRole('button', { name: 'Audio', exact: true }).click();
  assert.ok(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await host.setViewportSize({ width: 1280, height: 800 });
  await host.getByRole('button', { name: 'Home', exact: true }).click();

  await host.getByRole('button', { name: 'New meeting', exact: true }).click();
  await host.getByLabel('Meeting name').fill('Guest smoke test');
  await host.getByLabel('Passcode').fill('test passcode');
  await host.getByLabel('Allow guests without an account').check();
  await host.getByRole('button', { name: 'Continue', exact: true }).click();
  await host.getByRole('button', { name: 'Camera off' }).click();
  await host.waitForFunction(() => document.querySelector('.preview video')?.readyState >= 2);
  await host.getByRole('button', { name: 'Enter room' }).click();
  await host.getByRole('button', { name: 'Devices', exact: true }).waitFor();
  await host.getByRole('button', { name: 'Gallery', exact: true }).waitFor();
  try { await host.locator('time.call-timer').waitFor({ timeout: 15000 }); }
  catch {
    assert.fail(await host.evaluate(() => JSON.stringify({
      status: document.querySelector('.call-title')?.innerText,
      notice: document.querySelector('.call-notice')?.innerText,
      meetingTimer: JSON.parse(localStorage.getItem('meetrix-devices')).meetingTimer,
    })));
  }
  assert.equal(await host.evaluate(() => JSON.parse(localStorage.getItem('meetrix-devices')).camera), false);
  const meetings = await (await host.request.get(origin + '/api/meetings')).json();
  const id = meetings.find(meeting => meeting.title === 'Guest smoke test').id;

  await guest.goto(origin + '/join?m=' + id);
  await guest.getByRole('button', { name: 'Join as a guest' }).click();
  await guest.getByLabel('Display name').fill('Test guest');
  await guest.getByLabel('Passcode').fill('test passcode');
  await guest.getByRole('button', { name: 'Continue', exact: true }).click();
  await guest.getByRole('button', { name: 'Join now' }).click();
  await guest.getByText('The host will admit you from the waiting room.').waitFor();
  await host.getByText('Unverified guest', { exact: true }).waitFor();
  await host.getByRole('button', { name: 'Admit', exact: true }).click();
  await guest.getByRole('button', { name: 'Devices', exact: true }).waitFor();
  await guest.waitForFunction(() => Array.from(document.querySelectorAll('.stage video')).some(video => video.readyState >= 2));
  assert.equal((await guest.request.get(origin + '/api/meetings/' + id + '/notes')).status(), 401);
  await host.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await host.waitForFunction(() => document.fullscreenElement === document.documentElement);
  await host.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await host.waitForFunction(() => document.fullscreenElement === null);

  const cameraToggle = host.getByRole('button', { name: 'Camera', exact: true });
  await host.getByRole('button', { name: 'Chat', exact: true }).click();
  await host.getByRole('textbox', { name: 'Message', exact: true }).focus();
  assert.equal(await host.locator('.chat-log').getAttribute('aria-live'), 'off');
  assert.equal(await host.locator('.chat-log').getAttribute('data-text-size'), 'largest');
  await host.keyboard.press('Alt+Shift+K');
  assert.equal(await cameraToggle.getAttribute('aria-pressed'), 'true');
  await host.getByRole('button', { name: 'Close panel' }).click();
  await host.keyboard.press('Alt+Shift+K');
  await host.locator('button[aria-pressed="false"]').filter({ hasText: /^Camera$/ }).waitFor();
  await host.keyboard.press('Alt+Shift+K');
  await host.locator('button[aria-pressed="true"]').filter({ hasText: /^Camera$/ }).waitFor();

  await guest.getByRole('button', { name: 'Call statistics' }).click();
  await guest.locator('.stat-sample').filter({ hasText: 'Camera' }).getByText(/\d+ kb\/s/).waitFor();
  await host.getByRole('button', { name: 'Share', exact: true }).click();
  await host.locator('.stage.share-side .share video').waitFor();
  await guest.locator('.share video').waitFor();
  assert.equal(await host.evaluate(() => window.testShareOptions.video.frameRate), 5);
  assert.equal(await host.evaluate(() => window.testShareTrack.contentHint), 'text');

  await guest.getByRole('button', { name: 'View preferences' }).click();
  await guest.getByLabel('Pause incoming cameras').check();
  await guest.getByLabel('Hide my tile from my view').check();
  await guest.getByRole('button', { name: 'Done', exact: true }).click();
  await guest.locator('.stat-sample').filter({ hasText: 'Camera' }).waitFor({ state: 'detached' });
  assert.equal(await guest.locator('.stage .tile video').count(), 0);
  assert.equal(await guest.locator('.stage .tile').count(), 1);
  await guest.locator('.share video').waitFor();
  await guest.getByRole('button', { name: 'View preferences' }).click();
  await guest.getByLabel('Pause incoming cameras').uncheck();
  await guest.getByRole('button', { name: 'Done', exact: true }).click();
  await guest.locator('.stage .tile video').waitFor();
  await guest.screenshot({ path: resolve(results, 'meetrix-call-statistics.png') });
  await host.getByRole('button', { name: 'Stop share', exact: true }).click();
  await guest.getByRole('button', { name: 'Close panel' }).click();

  await host.getByRole('button', { name: 'Devices', exact: true }).click();
  const camera = host.getByLabel('Camera device', { exact: true });
  await host.waitForFunction(() => document.querySelector('select[aria-label="Camera device"]')?.options.length > 1);
  const cameraId = await camera.selectOption({ index: 1 });
  await host.waitForFunction(id => JSON.parse(localStorage.getItem('meetrix-devices')).cameraId === id, cameraId[0]);
  await camera.selectOption('');
  await host.waitForFunction(() => JSON.parse(localStorage.getItem('meetrix-devices')).cameraId === '');
  await host.getByRole('button', { name: 'Done', exact: true }).click();
  await guest.waitForFunction(() => Array.from(document.querySelectorAll('.stage video')).some(video => video.readyState >= 2));

  const sections = [['Design partner', '0'], ['Workshop guest', '1']];
  const otherGuests = await Promise.all(sections.map(async ([name]) => {
    const page = await browser.newPage({ permissions: ['camera', 'microphone'] });
    await page.goto(origin + '/join?m=' + id);
    await page.getByRole('button', { name: 'Join as a guest' }).click();
    await page.getByLabel('Display name').fill(name);
    await page.getByLabel('Passcode').fill('test passcode');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Join now' }).click();
    await page.getByText('The host will admit you from the waiting room.').waitFor();
    return page;
  }));
  await host.getByRole('button', { name: /^People / }).click();
  for (const [name] of sections) {
    await host.locator('.waiting-person').filter({ hasText: name }).getByRole('button', { name: 'Admit', exact: true }).click();
  }
  await host.getByRole('button', { name: 'People 4', exact: true }).waitFor();
  await guest.getByRole('button', { name: 'Camera', exact: true }).click();
  await guest.locator('button[aria-pressed="true"]').filter({ hasText: /^Camera$/ }).waitFor();
  await host.getByRole('button', { name: 'Breakouts', exact: true }).click();
  await host.getByLabel('Name for breakout room 1').fill('Design');
  await host.getByLabel('Name for breakout room 2').fill('Workshop');
  await host.getByRole('button', { name: 'Divide evenly' }).click();
  assert.notEqual(await host.getByLabel('Assign Test guest').inputValue(), '');
  await host.getByLabel('Assign Test guest').selectOption('0');
  for (const [name, room] of sections) await host.getByLabel('Assign ' + name).selectOption(room);
  await host.getByRole('button', { name: 'Open breakout rooms' }).click();
  for (const page of [guest, otherGuests[0]]) {
    await page.getByText('Breakout · Design', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'People 2', exact: true }).waitFor();
  }
  await otherGuests[1].getByText('Breakout · Workshop', { exact: true }).waitFor();
  await otherGuests[1].getByRole('button', { name: 'People 1', exact: true }).waitFor();
  assert.equal(await guest.getByRole('button', { name: 'Camera', exact: true }).getAttribute('aria-pressed'), 'false');
  await host.getByRole('button', { name: 'People 1', exact: true }).waitFor();
  for (const page of [guest, ...otherGuests]) await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await guest.getByRole('textbox', { name: 'Message', exact: true }).fill('Design breakout message');
  await guest.getByRole('button', { name: 'Send message', exact: true }).click();
  await otherGuests[0].getByText('Design breakout message', { exact: true }).waitFor();
  assert.equal(await otherGuests[1].getByText('Design breakout message', { exact: true }).count(), 0);
  await host.getByLabel('Announcement to rooms').fill('Wrap up your discussion.');
  await host.getByRole('button', { name: 'Send announcement' }).click();
  await host.getByText('Sent to 2 rooms.', { exact: true }).waitFor();
  for (const page of [guest, ...otherGuests]) await page.getByText('Host announcement · Wrap up your discussion.', { exact: true }).waitFor();
  await host.locator('.call-side').screenshot({ path: resolve(results, 'meetrix-breakout-rooms.png') });
  await host.getByRole('button', { name: 'Close all rooms', exact: true }).click();
  for (const page of [guest, ...otherGuests]) {
    await page.getByText('Returned to the main meeting. Your microphone and camera are off.', { exact: true }).waitFor();
  }
  await host.getByRole('button', { name: 'People 4', exact: true }).waitFor();

  await host.getByRole('button', { name: 'Leave', exact: true }).click();
  await host.getByRole('button', { name: 'End for everyone' }).click();
  await guest.getByText('You are disconnected from this room.').waitFor();
  console.log('Meeting settings and four-client breakout checks passed, including room isolation and return.');
} finally {
  await browser?.close();
  backend?.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
}
