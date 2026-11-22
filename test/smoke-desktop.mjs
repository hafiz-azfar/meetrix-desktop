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
  assert.equal(new URL(page.url()).origin, 'http://localhost:4317');
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
    await page.getByRole('button', { name: 'New meeting', exact: true }).click();
    await page.getByRole('textbox', { name: 'Meeting name' }).fill('Desktop verification');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Enter room', exact: true }).click();
    await page.getByText('Connected', { exact: true }).waitFor({ timeout: 20000 });
    await page.screenshot({ path: join(testRoot, 'meetrix-meeting.png') });
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('button', { name: 'End for everyone', exact: true }).click();
    await page.getByRole('button', { name: 'New meeting', exact: true }).waitFor();
    console.log('Clerk test account verification, authenticated dashboard, create room, connect and end passed.');
  }
} finally {
  await desktop.close();
}
