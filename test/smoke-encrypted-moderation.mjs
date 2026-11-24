import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startLocal } from '../desktop/local.cjs';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(resolve(output, 'encrypted-moderation-'));
let backend;
let browser;

try {
  backend = await startLocal({
    directory, runtime: resolve('vendor/runtime'), origin: 'http://127.0.0.1:0',
    instance: { insforgeUrl: 'https://auth.meetrix.test' },
    dependencies: { createAuth: () => ({
      async getPublicAuthConfig() { return { data: { oAuthProviders: [] } }; },
      async signInWithPassword({ email }) {
        const host = email.startsWith('host');
        const id = host ? '4e5c7bb9-0218-4d57-b9c0-4ff45db24395' : 'd338dd36-66ed-4dba-8f37-ddc3af85a041';
        return { data: { accessToken: 'test-token', user: { id, profile: { name: host ? 'Organizer' : 'Reader' } } } };
      },
    }) },
  });
  const { origin } = backend;
  browser = await chromium.launch({
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'],
  });
  const host = await browser.newPage({ permissions: ['camera', 'microphone'] });
  const reader = await browser.newPage({ permissions: ['camera', 'microphone'] });
  let key;
  let keySentToApi = false;
  async function connected(page) {
    try { await page.getByText('Connected', { exact: true }).waitFor(); }
    catch {
      assert.fail('Encrypted connection did not become ready. ' + await page.locator('body').innerText());
    }
  }
  for (const [page, account] of [[host, 'host'], [reader, 'reader']]) {
    page.on('request', request => {
      if (key && request.url().startsWith(origin + '/api/') && request.postData()?.includes(key)) keySentToApi = true;
    });
    const auth = await page.request.post(origin + '/api/auth/email/password', {
      headers: { Origin: origin }, data: { email: account + '@example.test', password: 'test-password' },
    });
    assert.equal(auth.status(), 200);
  }

  await host.goto(origin);
  await host.getByRole('button', { name: 'New meeting', exact: true }).click();
  await host.getByLabel('Meeting name').fill('Encrypted moderation smoke');
  await host.getByRole('checkbox', { name: /^End-to-end encrypted room/ }).check();
  await host.getByRole('button', { name: 'Continue', exact: true }).click();
  await host.getByRole('button', { name: 'Generate key', exact: true }).click();
  key = await host.getByLabel('Room encryption key', { exact: true }).inputValue();
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(key));
  await host.getByRole('button', { name: 'Enter room', exact: true }).click();
  await connected(host);
  const meetings = await (await host.request.get(origin + '/api/meetings')).json();
  const { id } = meetings.find(meeting => meeting.title === 'Encrypted moderation smoke');
  const path = `${origin}/api/meetings/${id}`;

  async function joinReader(admit) {
    await reader.goto(origin + '/join?m=' + id);
    await reader.getByRole('button', { name: 'Continue', exact: true }).click();
    await reader.getByRole('button', { name: 'Join now', exact: true }).click();
    if (admit) await host.getByRole('button', { name: 'Admit', exact: true }).click();
    await reader.getByLabel('Room encryption key', { exact: true }).fill(key);
    await reader.getByRole('button', { name: 'Join now', exact: true }).click();
    await connected(reader);
  }
  async function changeCoHost(enabled) {
    const reply = host.waitForResponse(response => response.url() === path + '/moderate' && response.request().method() === 'POST');
    if (enabled) host.once('dialog', dialog => dialog.accept());
    await host.getByRole('button', { name: enabled ? 'Make co-host: Reader' : 'Revoke co-host access for Reader', exact: true }).click();
    const response = await reply;
    assert.equal(response.status(), 200, await response.text());
    await reader.getByText('You’re a co-host', { exact: true }).waitFor({ state: enabled ? 'visible' : 'detached' });
  }

  await joinReader(true);
  await reader.getByText('Encrypted media', { exact: true }).waitFor();
  await reader.getByRole('button', { name: 'Camera', exact: true }).click();
  await reader.locator('button[aria-pressed="true"]').filter({ hasText: /^Camera$/ }).waitFor();
  await reader.getByRole('button', { name: 'Unmute', exact: true }).click();
  await reader.getByRole('button', { name: 'Mute', exact: true }).waitFor();

  host.once('dialog', dialog => dialog.accept());
  await host.getByRole('button', { name: 'Move Reader to waiting room', exact: true }).click();
  await reader.getByText('The host moved you to the waiting room.', { exact: true }).waitFor();
  assert.equal(await reader.getByRole('button', { name: 'Camera', exact: true }).count(), 0);
  await host.getByRole('button', { name: 'Admit', exact: true }).click();
  await reader.getByText('Readmitted to the meeting. Your microphone and camera are off.', { exact: true }).waitFor();
  await connected(reader);
  await reader.getByRole('button', { name: 'Unmute', exact: true }).waitFor();
  assert.equal(await reader.getByRole('button', { name: 'Camera', exact: true }).getAttribute('aria-pressed'), 'false');

  await host.getByRole('button', { name: 'Transfer host to Reader', exact: true }).waitFor();
  for (const page of [host, reader]) await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await reader.getByRole('textbox', { name: 'Message', exact: true }).fill('Encrypted chat resumed after readmission.');
  await reader.getByRole('button', { name: 'Send message', exact: true }).click();
  await reader.getByText('Encrypted chat resumed after readmission.', { exact: true }).waitFor();
  try { await host.getByText('Encrypted chat resumed after readmission.', { exact: true }).waitFor({ timeout: 12000 }); }
  catch {
    assert.fail('Encrypted chat did not reach the host. ' + JSON.stringify({
      hostStatus: await host.locator('.call-title').innerText(),
      hostNotice: await host.locator('.call-notice').allTextContents(),
      readerNotice: await reader.locator('.call-notice').allTextContents(),
    }));
  }
  await host.getByRole('button', { name: 'People 2', exact: true }).click();
  await host.getByRole('button', { name: 'Ask Reader to unmute', exact: true }).click();
  await reader.getByRole('button', { name: 'Turn on microphone', exact: true }).waitFor();
  assert.ok(await reader.getByRole('button', { name: 'Unmute', exact: true }).isVisible());
  await reader.getByRole('button', { name: 'Turn on microphone', exact: true }).click();
  await reader.getByRole('button', { name: 'Mute', exact: true }).waitFor();
  await reader.getByRole('button', { name: 'Mute', exact: true }).click();

  await changeCoHost(true);
  await reader.getByRole('button', { name: 'People 2', exact: true }).click();
  await reader.getByRole('button', { name: 'Lock room', exact: true }).click();
  await reader.getByRole('button', { name: 'Unlock room', exact: true }).click();
  await reader.getByRole('button', { name: 'Lock room', exact: true }).waitFor();
  await reader.screenshot({ path: resolve(output, 'meetrix-encrypted-co-host.png') });
  await changeCoHost(false);
  assert.equal((await reader.request.get(path + '/lobby')).status(), 403);
  host.once('dialog', dialog => dialog.accept());
  await host.getByRole('button', { name: 'Transfer host to Reader', exact: true }).click();
  await reader.getByText('You’re the host', { exact: true }).waitFor();
  assert.equal((await host.request.post(path + '/moderate', {
    headers: { Origin: origin }, data: { action: 'end' },
  })).status(), 403);
  for (const feature of ['Record', 'Captions', 'Breakouts', 'Polls', 'Whiteboard']) {
    assert.equal(await reader.getByRole('button', { name: feature, exact: true }).count(), 0);
  }

  await reader.getByRole('button', { name: 'Leave', exact: true }).click();
  const dialog = reader.getByRole('dialog', { name: 'Leave the meeting?' });
  await dialog.getByRole('combobox', { name: 'New host' }).selectOption({ label: 'Organizer' });
  await reader.screenshot({ path: resolve(output, 'meetrix-encrypted-host-transfer.png') });
  await dialog.getByRole('button', { name: 'Assign host and leave', exact: true }).click();
  await host.getByText('You’re the host', { exact: true }).waitFor();
  await reader.getByRole('button', { name: 'New meeting', exact: true }).waitFor();

  await joinReader(false);
  await changeCoHost(true);
  await host.getByRole('button', { name: 'Leave', exact: true }).click();
  await host.getByRole('button', { name: 'Leave room', exact: true }).click();
  await host.getByRole('button', { name: 'New meeting', exact: true }).waitFor();
  assert.equal(await reader.getByText('You’re the host', { exact: true }).count(), 0);
  await reader.getByText('You’re the host', { exact: true }).waitFor({ timeout: 75000 });
  await reader.getByText('Encrypted media', { exact: true }).waitFor();
  assert.equal((await host.request.post(path + '/moderate', {
    headers: { Origin: origin }, data: { action: 'end' },
  })).status(), 403);
  await reader.getByRole('button', { name: 'Leave', exact: true }).click();
  await reader.getByRole('button', { name: 'End for everyone', exact: true }).click();
  await reader.getByRole('button', { name: 'New meeting', exact: true }).waitFor();
  assert.equal(keySentToApi, false);
  console.log('Encrypted call passed readmission, microphone consent, co-host revocation, manual transfer, and automatic succession.');
} finally {
  await browser?.close();
  backend?.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
}
