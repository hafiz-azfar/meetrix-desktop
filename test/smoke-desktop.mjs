import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const testRoot = resolve('test-results');
await mkdir(testRoot, { recursive: true });
const profile = await mkdtemp(join(testRoot, 'desktop-'));
const args = ['--user-data-dir=' + profile];
const executablePath = process.env.MEETRIX_EXE || resolve('release/win-unpacked/Meetrix.exe');
const built = existsSync(executablePath);
const desktop = await electron.launch(built ? { executablePath, args } : { args: ['.', ...args] });
try {
  const page = await desktop.firstWindow({ timeout: 30000 });
  const messages = [];
  page.on('console', message => { if (message.type() === 'error') messages.push(message.text().slice(0, 240)); });
  page.on('pageerror', error => messages.push(error.message.slice(0, 240)));
  await page.waitForLoadState('domcontentloaded');
  try {
    await page.getByRole('heading', { name: 'Make room for a good meeting.' }).waitFor({ timeout: 30000 });
    await page.locator('input[name="identifier"]').waitFor({ timeout: 25000 });
  } catch (error) {
    console.error('Desktop loaded', new URL(page.url()).protocol, (await page.locator('body').innerText()).slice(0, 450), messages);
    throw error;
  }
  assert.match(new URL(page.url()).origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/config');
    const config = await response.json();
    return { desktop: config.desktop, mediaReady: config.mediaReady, testMode: config.clerkPublishableKey.startsWith('pk_test_') };
  });
  assert.deepEqual(result, { desktop: true, mediaReady: true, testMode: true });
  await page.screenshot({ path: join(testRoot, 'meetrix-sign-in.png') });
  console.log('Windows desktop opened the Clerk sign-in form with bundled LiveKit running.');
  if (!process.argv.includes('--clerk-account')) process.exitCode = 0;
  else {
    const existing = process.env.MEETRIX_QA_EMAIL;
    if (existing) {
      assert.ok(existing.endsWith('+clerk_test@example.com'), 'Use a Clerk test email address.');
      await page.locator('input[name="identifier"]').fill(existing);
    } else {
      await page.getByRole('link', { name: 'Sign up' }).click();
      const testId = Date.now();
      await page.locator('input[name="emailAddress"]').fill('meetrix-qa-' + testId + '+clerk_test@example.com');
      for (const [field, value] of [['firstName', 'Meetrix'], ['lastName', 'QA'], ['username', 'meetrix_qa_' + testId]]) {
        if (await page.locator('input[name="' + field + '"]').count()) await page.locator('input[name="' + field + '"]').fill(value);
      }
      const password = page.locator('input[name="password"]');
      if (await password.count()) await password.fill('MEETRIX_QA_!1_' + crypto.randomUUID());
    }
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const otp = page.locator('input[autocomplete="one-time-code"], input[name="code"], input[data-input-otp]').first();
    try { await otp.waitFor({ timeout: 12000 }); }
    catch (error) {
      console.error('Clerk verification state:', (await page.locator('body').innerText()).slice(0, 750), messages);
      throw error;
    }
    const meetingsResponse = page.waitForResponse(response => response.url().endsWith('/api/meetings') && response.request().method() === 'GET');
    await otp.pressSequentially('424242');
    await page.getByRole('button', { name: 'New meeting', exact: true }).waitFor({ timeout: 25000 });
    assert.equal((await meetingsResponse).status(), 200);
    await page.screenshot({ path: join(testRoot, 'meetrix-workspace.png') });
    await page.getByRole('button', { name: 'Schedule meeting', exact: true }).click();
    const schedule = page.getByRole('dialog');
    await schedule.getByRole('textbox', { name: 'Meeting name' }).fill('Weekly verification');
    const when = await page.evaluate(() => {
      const prospective = new Date(Date.now() + 3600000);
      return new Date(prospective.getTime() - prospective.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    });
    await schedule.locator('input[type="datetime-local"]').fill(when);
    await schedule.getByLabel('Calendar duration').selectOption('45');
    await schedule.getByLabel('Repeat').selectOption('4');
    await schedule.getByRole('button', { name: 'Schedule', exact: true }).click();
    await page.getByText('4 weekly meetings scheduled.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByRole('button', { name: 'New meeting', exact: true }).click();
    await page.getByRole('textbox', { name: 'Meeting name' }).fill('Desktop verification');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.evaluate(() => {
      const RealPeerConnection = window.RTCPeerConnection;
      window.meetrixRtcDiagnostics = [];
      window.meetrixTestConnections = [];
      window.RTCPeerConnection = class extends RealPeerConnection {
        constructor(...args) {
          super(...args);
          window.meetrixTestConnections.push(this);
          this.addEventListener('iceconnectionstatechange', () => window.meetrixRtcDiagnostics.push('ICE ' + this.iceConnectionState));
          this.addEventListener('icecandidate', event => {
            if (event.candidate) window.meetrixRtcDiagnostics.push(event.candidate.type + ' ' + event.candidate.protocol);
          });
        }
      };
    });
    await page.getByRole('button', { name: 'Enter room', exact: true }).click();
    try { await page.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 }); }
    catch (error) {
      console.error('Meeting state:', (await page.locator('body').innerText()).slice(0, 1000), messages, await page.evaluate(() => window.meetrixRtcDiagnostics));
      const summarize = await page.evaluate(async () => Promise.all(window.meetrixTestConnections.map(async connection => {
        const stats = await connection.getStats();
        return Array.from(stats.values()).filter(item => ['remote-candidate', 'candidate-pair'].includes(item.type)).map(item => ({
          type: item.type, candidate: item.candidateType, protocol: item.protocol, state: item.state,
          loopback: item.address?.startsWith('127.') || item.address === '::1',
          requests: item.requestsSent, responses: item.responsesReceived,
        }));
      })));
      console.error('ICE candidate pairs:', JSON.stringify(summarize));
      await page.screenshot({ path: join(testRoot, 'meetrix-meeting-failure.png') });
      throw error;
    }
    await page.screenshot({ path: join(testRoot, 'meetrix-meeting.png') });
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.getByLabel('Shared meeting notes').fill('Verified with a test account.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Notes saved.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Polls', exact: true }).click();
    await page.getByRole('button', { name: 'Create poll', exact: true }).click();
    await page.getByLabel('Question').fill('Does the desktop poll work?');
    await page.getByLabel('Option 1').fill('Yes');
    await page.getByLabel('Option 2').fill('No');
    await page.getByRole('button', { name: 'Open voting', exact: true }).click();
    await page.getByRole('button', { name: /^Yes/ }).click();
    await page.getByText('Vote submitted', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close voting', exact: true }).click();
    await page.getByText('Poll closed', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    const board = page.getByLabel('Shared drawing area');
    const bounds = await board.boundingBox();
    await page.mouse.move(bounds.x + 24, bounds.y + 32);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 120, bounds.y + 80, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const exportButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Export image');
      return exportButton && !exportButton.disabled;
    });
    await desktop.evaluate(({ dialog }) => {
      const show = dialog.showMessageBox;
      dialog.showMessageBox = (parent, options) => {
        if (options.title !== 'Share your screen') return show(parent, options);
        globalThis.meetrixPickerObserved = true;
        return Promise.resolve({ response: options.cancelId });
      };
    });
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await desktop.evaluate(() => Boolean(globalThis.meetrixPickerObserved))) break;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    assert.ok(await desktop.evaluate(() => Boolean(globalThis.meetrixPickerObserved)),
      'The native screen share picker opened. Renderer state: ' + (await page.locator('.call-notice').allTextContents()).join(' '));
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'End for everyone', exact: true }).click();
    await page.getByRole('button', { name: 'New meeting', exact: true }).waitFor();
    console.log((built ? 'Packaged' : 'Development') + ' desktop passed Clerk sign-in, weekly scheduling, live meeting, notes, polling, whiteboard and the screen-share picker.');
  }
} finally {
  await desktop.close();
}
