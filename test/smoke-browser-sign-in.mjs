import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron, chromium } from 'playwright';

const email = process.env.MEETRIX_QA_EMAIL;
assert.ok(email?.endsWith('+clerk_test@example.com'), 'Set MEETRIX_QA_EMAIL to an existing Clerk test address.');
const testDirectory = resolve('test-results');
await mkdir(testDirectory, { recursive: true });
const profile = await mkdtemp(join(testDirectory, 'browser-sign-in-'));
const executablePath = process.env.MEETRIX_EXE || resolve('release/win-unpacked/Meetrix.exe');
const packaged = existsSync(executablePath);
const args = ['--user-data-dir=' + profile];
const app = await electron.launch(packaged ? { executablePath, args } : { args: ['.', ...args] });
let browser;

try {
  const desktop = await app.firstWindow({ timeout: 30000 });
  const social = desktop.getByRole('button', { name: 'Continue with Google, Apple, or GitHub' });
  await social.waitFor({ timeout: 30000 });
  assert.equal(await desktop.evaluate(() => typeof window.require), 'undefined');
  await app.evaluate(({ shell }) => {
    shell.openExternal = async url => { globalThis.meetrixBrowserTarget = url; };
  });
  await social.click();
  const code = await desktop.getByLabel('Desktop pairing code').innerText();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  let browserTarget;
  for (let attempt = 0; attempt < 20 && !browserTarget; attempt++) {
    browserTarget = await app.evaluate(() => globalThis.meetrixBrowserTarget || null);
    if (!browserTarget) await new Promise(resolve => setTimeout(resolve, 150));
  }
  const url = new URL(browserTarget);
  assert.equal(url.origin, new URL(desktop.url()).origin);
  assert.equal(url.pathname, '/desktop-sign-in');
  assert.deepEqual([...url.searchParams.keys()], ['request']);

  browser = await chromium.launch({ channel: 'chrome', headless: process.env.MEETRIX_QA_HEADED !== '1' });
  const page = await browser.newPage();
  await page.goto(url.href);
  const providerNames = ['Google', 'Apple', 'GitHub'];
  for (const name of providerNames) await page.getByRole('button', { name: new RegExp(name, 'i') }).first().waitFor({ timeout: 25000 });
  if (process.argv.includes('--providers')) {
    for (const [provider, domain] of [['Google', 'google.com'], ['Apple', 'apple.com'], ['GitHub', 'github.com']]) {
      const context = await browser.newContext();
      try {
        let matched;
        const reached = new Promise(resolve => { matched = resolve; });
        await context.route('**/*', async route => {
          const request = route.request();
          const host = new URL(request.url()).hostname;
          if (request.isNavigationRequest() && (host === domain || host.endsWith('.' + domain))) {
            matched();
            await route.abort();
          } else await route.continue();
        });
        const tab = await context.newPage();
        await tab.goto(url.href);
        await tab.getByRole('button', { name: new RegExp(provider, 'i') }).first().click({ timeout: 15000 });
        let timer;
        try {
          await Promise.race([reached, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(provider + ' did not reach its authorization domain.')), 18000);
          })]);
        } finally { clearTimeout(timer); }
        console.log(provider + ' reached its authorization site.');
      } finally { await context.close(); }
    }
  }

  await page.locator('input[name="identifier"]').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const otp = page.locator('input[autocomplete="one-time-code"], input[name="code"], input[data-input-otp]').first();
  try {
    const linkInstructions = page.getByText('Use the verification link sent to your email', { exact: true });
    await Promise.race([otp.waitFor({ timeout: 18000 }), linkInstructions.waitFor({ timeout: 18000 })]);
    if (await linkInstructions.isVisible()) {
      await page.getByText('Use another method', { exact: true }).click();
      await page.getByRole('button', { name: /email.*code|code.*email/i }).first().click({ timeout: 9000 });
    }
    await otp.waitFor({ timeout: 18000 });
  } catch (error) {
    console.error('Clerk test sign-in state:', (await page.locator('body').innerText()).slice(0, 500));
    throw error;
  }
  await otp.pressSequentially('424242');
  await page.getByLabel('Code from Meetrix').fill(code);
  await page.getByRole('button', { name: 'Approve desktop sign-in' }).click();
  await page.getByRole('heading', { name: 'Desktop sign-in approved' }).waitFor({ timeout: 15000 });
  await desktop.getByRole('button', { name: 'New meeting', exact: true }).waitFor({ timeout: 15000 });

  const valid = await desktop.evaluate(async () => {
    const response = await fetch('/api/meetings');
    const profile = await fetch('/api/desktop-auth/session').then(response => response.json());
    return { status: response.status, signedIn: Boolean(profile.user), readable: document.cookie.includes('meetrix_desktop=') };
  });
  assert.deepEqual(valid, { status: 200, signedIn: true, readable: false });
  await desktop.reload();
  await desktop.getByRole('button', { name: 'New meeting', exact: true }).waitFor({ timeout: 20000 });
  await desktop.getByRole('button', { name: 'Sign out', exact: true }).click();
  await social.waitFor({ timeout: 20000 });
  assert.equal(await desktop.evaluate(async () => (await fetch('/api/meetings')).status), 401);
  console.log((packaged ? 'Packaged' : 'Development') + ' desktop signed in through Clerk in a separate browser and revoked its workspace session on sign-out.');
} finally {
  await browser?.close();
  await app.close();
}
