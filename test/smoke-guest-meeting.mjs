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
        return { data: { accessToken: 'test-token', user: { id: '4e5c7bb9-0218-4d57-b9c0-4ff45db24395', profile: { name: 'Test host' } } } };
      },
    }) },
  });
  const origin = backend.origin;
  browser = await chromium.launch({
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const host = await browser.newPage({ permissions: ['camera', 'microphone'] });
  const guest = await browser.newPage({ permissions: ['camera', 'microphone'] });
  const hostSignIn = await host.request.post(origin + '/api/auth/email/password', {
    headers: { Origin: origin }, data: { email: 'host@example.test', password: 'test-password' },
  });
  assert.equal(hostSignIn.status(), 200);

  await host.goto(origin);
  await host.getByRole('button', { name: 'New meeting', exact: true }).click();
  await host.getByLabel('Meeting name').fill('Guest smoke test');
  await host.getByLabel('Passcode').fill('test passcode');
  await host.getByLabel('Allow guests without an account').check();
  await host.getByRole('button', { name: 'Continue', exact: true }).click();
  await host.getByRole('button', { name: 'Camera off' }).click();
  await host.waitForFunction(() => document.querySelector('.preview video')?.readyState >= 2);
  await host.getByRole('button', { name: 'Enter room' }).click();
  await host.getByRole('button', { name: 'Devices', exact: true }).waitFor();
  const meetings = await (await host.request.get(origin + '/api/meetings')).json();
  const id = meetings[0].id;

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
  console.log('Accountless invite, host admission, video, device switching, and meeting end passed with real LiveKit.');
} finally {
  await browser?.close();
  backend?.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
}
