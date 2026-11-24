import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startLocal } from '../desktop/local.cjs';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(resolve(output, 'alternative-host-'));
const title = 'Alternative host smoke';
const email = 'backup@example.test';
const encrypted = process.env.MEETRIX_SMOKE_ENCRYPTED === '1';
let backend;
let browser;

try {
  backend = await startLocal({
    directory, runtime: resolve('vendor/runtime'), origin: 'http://127.0.0.1:0',
    instance: { insforgeUrl: 'https://auth.meetrix.test' },
    dependencies: { createAuth: () => ({
      async getPublicAuthConfig() { return { data: { oAuthProviders: [] } }; },
      async signInWithPassword({ email }) {
        const organizer = email.startsWith('organizer');
        const id = organizer ? '4e5c7bb9-0218-4d57-b9c0-4ff45db24395' : 'd338dd36-66ed-4dba-8f37-ddc3af85a041';
        return { data: { accessToken: 'test-token', user: { id, email, emailVerified: true,
          profile: { name: organizer ? 'Organizer' : 'Backup' } } } };
      },
    }) },
  });
  const { origin } = backend;
  browser = await chromium.launch({ ...(process.env.CI ? {} : { channel: 'chrome' }),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
  const organizer = await browser.newPage({ permissions: ['camera', 'microphone'] });
  const alternate = await browser.newPage({ permissions: ['camera', 'microphone'] });
  for (const [page, address] of [[organizer, 'organizer@example.test'], [alternate, email]]) {
    const auth = await page.request.post(origin + '/api/auth/email/password', {
      headers: { Origin: origin }, data: { email: address, password: 'test-password' },
    });
    assert.equal(auth.status(), 200);
  }

  await organizer.goto(origin);
  await organizer.getByRole('button', { name: 'Schedule meeting', exact: true }).click();
  const creation = organizer.getByRole('dialog', { name: 'Schedule a meeting' });
  const date = new Date(Date.now() + 3600_000);
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await creation.getByLabel('Meeting name').fill(title);
  await creation.getByLabel('Start time').fill(localTime);
  await creation.getByLabel('Passcode').fill('meeting passcode');
  if (encrypted) await creation.getByRole('checkbox', { name: /^End-to-end encrypted room/ }).check();
  await creation.getByLabel('Alternative host emails').fill('first-backup@example.test');
  await creation.getByRole('button', { name: 'Schedule', exact: true }).click();
  await organizer.getByRole('button', { name: 'Manage scheduled meeting' }).click();
  await organizer.getByRole('button', { name: 'Reschedule', exact: true }).click();
  const edit = organizer.getByRole('dialog', { name: 'Reschedule meeting' });
  assert.equal(await edit.getByLabel('Alternative host emails').inputValue(), 'first-backup@example.test');
  await edit.getByLabel('Alternative host emails').fill(email);
  await edit.screenshot({ path: resolve(output, 'meetrix-alternative-host-settings.png') });
  await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
  await edit.waitFor({ state: 'detached' });

  const list = await (await organizer.request.get(origin + '/api/meetings')).json();
  const meeting = list.find(item => item.title === title);
  assert.deepEqual(meeting.alternativeHosts, [email]);
  let roomKey;
  if (encrypted) {
    await organizer.getByRole('button', { name: 'Open', exact: true }).click();
    await organizer.getByRole('button', { name: 'Generate key', exact: true }).click();
    roomKey = await organizer.getByLabel('Room encryption key', { exact: true }).inputValue();
    await organizer.getByRole('button', { name: 'Back', exact: true }).click();
  }
  async function join(page) {
    await page.goto(origin + '/join?m=' + meeting.id);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    async function joinNow(expectedState) {
      const reply = page.waitForResponse(response => response.url().endsWith('/api/meetings/' + meeting.id + '/connect') &&
        response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Join now', exact: true }).click();
      const response = await reply;
      const { state, error } = await response.json();
      assert.equal(response.status(), 200, error);
      assert.equal(state, expectedState);
    }
    if (encrypted) {
      await joinNow('key-required');
      await page.getByLabel('Room encryption key', { exact: true }).fill(roomKey);
    }
    await joinNow('ready');
    try { await page.getByText('Connected', { exact: true }).waitFor(); }
    catch { assert.fail('The call did not connect. ' + await page.locator('body').innerText()); }
    if (encrypted) await page.getByText('Encrypted media', { exact: true }).waitFor();
  }

  await join(alternate);
  await alternate.getByText('You’re the host', { exact: true }).waitFor();
  assert.equal(await alternate.getByRole('button', { name: 'Reclaim host', exact: true }).count(), 0);
  await alternate.getByRole('button', { name: 'Lock room', exact: true }).click();
  await alternate.getByRole('button', { name: 'Unlock room', exact: true }).waitFor();
  await join(organizer);
  await alternate.getByRole('button', { name: 'People 2', exact: true }).waitFor();
  assert.equal(await alternate.getByRole('button', { name: 'Remove Organizer', exact: true }).count(), 0);
  assert.equal(await alternate.getByRole('button', { name: 'Move Organizer to waiting room', exact: true }).count(), 0);
  await organizer.screenshot({ path: resolve(output, 'meetrix-reclaim-host.png') });
  organizer.once('dialog', dialog => dialog.accept());
  await organizer.getByRole('button', { name: 'Reclaim host', exact: true }).click();
  await organizer.getByText('You’re the host', { exact: true }).waitFor();
  await alternate.getByText('You’re the host', { exact: true }).waitFor({ state: 'detached' });
  await organizer.getByRole('button', { name: 'Leave', exact: true }).click();
  await organizer.getByRole('button', { name: 'End for everyone', exact: true }).click();
  await alternate.getByText('You are disconnected from this room.').waitFor();
  console.log((encrypted ? 'Encrypted' : 'Standard') + ' meeting passed alternative-host startup, locked-room organizer admission, and reclaim.');
} finally {
  await browser?.close();
  backend?.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
}
