import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { startLocal } from '../desktop/local.cjs';

const results = resolve('test-results');
await mkdir(results, { recursive: true });
const directory = await mkdtemp(join(results, 'workspace-features-'));
let backend;
let browser;
try {
  backend = await startLocal({
    directory, runtime: resolve('vendor/runtime'), origin: 'http://127.0.0.1:0',
    instance: { insforgeUrl: 'https://auth.meetrix.test' },
    dependencies: { createAuth: () => ({
      async getPublicAuthConfig() { return { data: { oAuthProviders: [] } }; },
      async signInWithPassword({ email }) {
        const member = email === 'teammate@example.test';
        return { data: { accessToken: 'test-token', user: {
          id: member ? 'd338dd36-66ed-4dba-8f37-ddc3af85a041' : '4e5c7bb9-0218-4d57-b9c0-4ff45db24395',
          profile: { name: member ? 'Test teammate' : 'Test organizer' },
        } } };
      },
    }) },
  });
  const { origin } = backend;
  browser = await chromium.launch({ channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const owner = await browser.newPage();
  const networks = [];
  await owner.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    networks.push(route.request().url());
    return route.abort();
  });
  await owner.addInitScript(() => {
    const BrowserRecorder = window.MediaRecorder;
    window.MediaRecorder = class ObservedRecorder extends BrowserRecorder {
      constructor(...args) {
        super(...args);
        this.addEventListener('dataavailable', event => {
          if (window.testClip) window.testClip.bytes += event.data.size;
        });
      }
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
      const [track] = stream.getVideoTracks();
      window.testClip = { track, bytes: 0 };
      return stream;
    };
  });
  const auth = await owner.request.post(origin + '/api/auth/email/password', {
    headers: { Origin: origin }, data: { email: 'test@example.test', password: 'test-password' },
  });
  assert.equal(auth.status(), 200);
  await owner.goto(origin);
  await owner.getByRole('button', { name: 'Tasks', exact: true }).click();
  await owner.getByRole('button', { name: 'New task' }).click();
  await owner.getByLabel('Title').fill('Publish project decision');
  await owner.getByLabel('Due date').fill('2030-04-02');
  await owner.getByRole('button', { name: 'Save', exact: true }).click();
  await owner.getByRole('button', { name: 'Edit Publish project decision' }).click();
  await owner.getByLabel('Complete', { exact: true }).check();
  await owner.getByRole('button', { name: 'Save', exact: true }).click();
  await owner.getByText('Complete · Due 2030-04-02').waitFor();
  await owner.reload();
  await owner.getByRole('button', { name: 'Tasks', exact: true }).click();
  await owner.getByText('Complete · Due 2030-04-02').waitFor();

  await owner.getByRole('button', { name: 'Canvas', exact: true }).click();
  await owner.getByRole('button', { name: 'New canvas' }).click();
  await owner.getByLabel('Title').fill('Launch outline');
  await owner.getByLabel('Canvas content').fill('## Decision\n- Ship Friday\n<script>literal content</script>');
  await owner.getByRole('button', { name: 'Preview', exact: true }).click();
  await owner.getByRole('heading', { name: 'Decision' }).waitFor();
  await owner.getByText('<script>literal content</script>', { exact: true }).waitFor();
  const markdown = owner.waitForEvent('download');
  await owner.getByRole('button', { name: 'Export Markdown' }).click();
  assert.match(await readFile(await (await markdown).path(), 'utf8'), /## Decision/);
  await owner.getByRole('button', { name: 'Save', exact: true }).click();
  await owner.getByRole('button', { name: 'Edit Launch outline' }).waitFor();

  await owner.getByRole('button', { name: 'Clips', exact: true }).click();
  await owner.getByRole('button', { name: 'Record a clip' }).click();
  await owner.getByRole('button', { name: 'Stop recording' }).waitFor();
  await owner.waitForFunction(() => window.testClip.bytes > 0, null, { timeout: 15000 });
  await owner.getByRole('button', { name: 'Stop recording' }).click();
  await owner.getByLabel('Clip title').or(owner.getByRole('alert')).first().waitFor();
  assert.equal(await owner.getByRole('alert').count(), 0, (await owner.getByRole('alert').allTextContents()).join(' / '));
  await owner.getByLabel('Clip title').fill('Product walk-through');
  assert.equal(await owner.evaluate(() => window.testClip.track.readyState), 'ended');
  await owner.getByRole('button', { name: 'Save to library' }).click();
  await owner.getByRole('button', { name: 'Play Product walk-through' }).waitFor();
  await owner.reload();
  await owner.getByRole('button', { name: 'Clips', exact: true }).click();
  await owner.getByRole('button', { name: 'Play Product walk-through' }).click();
  await owner.waitForFunction(() => document.querySelector('video[aria-label="Clip preview"]')?.readyState >= 1);
  const webm = owner.waitForEvent('download');
  await owner.getByRole('button', { name: 'Save WebM' }).click();
  const clip = await readFile(await (await webm).path());
  assert.deepEqual([...clip.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  owner.once('dialog', dialog => dialog.accept());
  await owner.getByRole('button', { name: 'Delete clip' }).click();
  await owner.getByText('No clips on this device.').waitFor();

  await owner.getByRole('button', { name: 'Team chat', exact: true }).click();
  await owner.getByRole('button', { name: 'New channel' }).click();
  await owner.getByLabel('Channel name').fill('Launch team');
  await owner.getByRole('button', { name: 'Create', exact: true }).click();
  await owner.getByRole('button', { name: 'Generate invite code' }).click();
  const inviteCode = await owner.getByLabel('Invite code (valid for 24 hours)').inputValue();
  const teammate = await browser.newPage();
  const teammateAuth = await teammate.request.post(origin + '/api/auth/email/password', {
    headers: { Origin: origin }, data: { email: 'teammate@example.test', password: 'test-password' },
  });
  assert.equal(teammateAuth.status(), 200);
  await teammate.goto(origin);
  await teammate.getByRole('button', { name: 'Team chat', exact: true }).click();
  await teammate.getByRole('button', { name: 'Join channel' }).click();
  await teammate.getByLabel('Invite code').fill(inviteCode);
  await teammate.getByRole('button', { name: 'Join', exact: true }).click();
  await teammate.getByLabel('Message', { exact: true }).fill('Draft reviewed and approved.');
  await teammate.getByRole('button', { name: 'Send message' }).click();
  await owner.getByText('Draft reviewed and approved.', { exact: true }).waitFor();
  await owner.getByText('Manage members', { exact: true }).click();
  owner.once('dialog', dialog => dialog.accept());
  await owner.getByRole('button', { name: 'Remove Test teammate' }).click();
  await teammate.getByText('You no longer have access to this channel.').waitFor();

  await owner.getByRole('button', { name: 'Bookings', exact: true }).click();
  await owner.getByRole('button', { name: 'New booking page' }).click();
  await owner.getByLabel('Meeting title').fill('Office hours');
  const time = new Date(Date.now() + 3_600_000);
  const local = new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await owner.getByLabel('Start time 1').fill(local);
  await owner.getByRole('button', { name: 'Publish booking page' }).click();
  await owner.getByText('Booking page published.').waitFor();
  const pages = await owner.request.get(origin + '/api/workspace/bookings').then(response => response.json());
  assert.equal(pages.length, 1);
  const visitor = await browser.newPage();
  await visitor.goto(origin + '/book?b=' + pages[0].id);
  await visitor.getByRole('heading', { name: 'Office hours' }).waitFor();
  await visitor.getByLabel('Available time').selectOption({ index: 1 });
  await visitor.getByLabel('Your name').fill('Test visitor');
  await visitor.getByRole('button', { name: 'Reserve time' }).click();
  await visitor.getByText("You're booked").waitFor();
  const invite = await visitor.getByRole('link', { name: 'Open meeting link' }).getAttribute('href');
  assert.match(invite, /\/join\?m=[A-Za-z0-9_-]{16}$/);
  await owner.getByRole('button', { name: 'Settings', exact: true }).click();
  await owner.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  await owner.getByLabel('Push-to-talk key').selectOption('F8');
  await owner.getByRole('button', { name: 'Meetings', exact: true }).click();
  const scheduled = owner.locator('article').filter({ hasText: 'Office hours' });
  await scheduled.getByRole('button', { name: 'Open' }).click();
  await owner.getByRole('button', { name: 'Enter room' }).click();
  await owner.bringToFront();
  try { await owner.getByText('Connected', { exact: true }).waitFor({ timeout: 45_000 }); }
  catch (failure) {
    console.error((await owner.locator('body').innerText()).slice(0, 700));
    throw failure;
  }
  await owner.getByRole('button', { name: 'Unmute', exact: true }).waitFor();
  await owner.waitForFunction(() => document.hasFocus() && JSON.parse(localStorage.getItem('meetrix-devices')).pushToTalk === 'F8');
  await owner.evaluate(() => document.activeElement.blur());
  await owner.keyboard.down('F8');
  await owner.getByText('Talking while key is held', { exact: true }).waitFor();
  await owner.getByRole('button', { name: 'Mute', exact: true }).waitFor();
  await owner.keyboard.up('F8');
  await owner.getByRole('button', { name: 'Unmute', exact: true }).waitFor();
  await owner.keyboard.down('F8');
  await owner.getByText('Talking while key is held', { exact: true }).waitFor();
  await owner.evaluate(() => window.dispatchEvent(new Event('blur')));
  await owner.getByRole('button', { name: 'Unmute', exact: true }).waitFor();
  await owner.keyboard.up('F8');

  await owner.getByRole('button', { name: 'Notes', exact: true }).click();
  await owner.getByText('AI meeting summary', { exact: true }).click();
  await owner.getByLabel('Text to summarize').fill(
    'The project team approved the product launch. The release is scheduled for Friday. Maya will prepare the release notes before launch.',
  );
  await owner.getByRole('button', { name: 'Generate summary' }).click();
  const summary = owner.getByLabel('Summary draft');
  await summary.waitFor({ timeout: 95_000 });
  assert.match(await summary.inputValue(), /launch|release/i);
  await owner.getByRole('button', { name: 'Captions', exact: true }).click();
  await owner.getByRole('button', { name: 'Meeting recap', exact: true }).click();
  await owner.getByRole('button', { name: 'Start collecting captions' }).click();
  await owner.getByRole('button', { name: 'Captions', exact: true }).click();
  await owner.getByRole('textbox', { name: 'Caption text' }).fill('The software launch is approved for Friday. Maya will prepare the release notes.');
  await owner.getByRole('button', { name: 'Send caption' }).click();
  await owner.getByRole('button', { name: 'Meeting recap', exact: true }).click();
  await owner.getByText('1 caption line collected.').waitFor();
  await owner.getByRole('button', { name: 'Leave', exact: true }).click();
  await owner.getByRole('button', { name: 'End for everyone' }).click();
  await owner.getByRole('heading', { name: 'Meeting recap', level: 1 }).waitFor();
  const recap = owner.getByLabel('Recap draft');
  await recap.waitFor({ timeout: 95_000 });
  assert.match(await recap.inputValue(), /launch|release/i);
  const recapDownload = owner.waitForEvent('download');
  await owner.getByRole('button', { name: 'Download recap' }).click();
  assert.match(await readFile(await (await recapDownload).path(), 'utf8'), /launch|release/i);
  await owner.getByRole('button', { name: 'Return to workspace' }).click();
  await owner.getByRole('button', { name: 'Bookings', exact: true }).waitFor();
  assert.deepEqual(networks, []);
  console.log('Tasks, Canvas, local WebM Clips, team chat, guest booking, push-to-talk, and automatic offline recap passed.');
} finally {
  await browser?.close();
  backend?.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
}
