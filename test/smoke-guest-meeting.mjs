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

  await host.getByRole('button', { name: 'Devices', exact: true }).click();
  const camera = host.getByLabel('Camera device', { exact: true });
  await host.waitForFunction(() => document.querySelector('select[aria-label="Camera device"]')?.options.length > 1);
  const cameraId = await camera.selectOption({ index: 1 });
  await host.waitForFunction(id => JSON.parse(localStorage.getItem('meetrix-devices')).cameraId === id, cameraId[0]);
  await camera.selectOption('');
  await host.waitForFunction(() => JSON.parse(localStorage.getItem('meetrix-devices')).cameraId === '');
  await host.getByRole('button', { name: 'Done', exact: true }).click();
  await guest.waitForFunction(() => Array.from(document.querySelectorAll('.stage video')).some(video => video.readyState >= 2));

  await host.getByRole('button', { name: 'Leave', exact: true }).click();
  await host.getByRole('button', { name: 'End for everyone' }).click();
  await guest.getByText('You are disconnected from this room.').waitFor();
  console.log('Settings, media checks, accountless admission, device switching, and meeting end passed.');
} finally {
  await browser?.close();
  backend?.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
}
