import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startLocal } from '../desktop/local.cjs';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(resolve(output, 'outlook-ui-'));
let backend;
let browser;
try {
  backend = await startLocal({
    directory, runtime: resolve('vendor/runtime'), origin: 'http://127.0.0.1:0',
    instance: { insforgeUrl: 'https://auth.meetrix.test' },
    dependencies: { createAuth: () => ({
      async getPublicAuthConfig() { return { data: { oAuthProviders: [] } }; },
      async signInWithPassword() {
        return { data: { accessToken: 'test-token', user: {
          id: '4e5c7bb9-0218-4d57-b9c0-4ff45db24395', profile: { name: 'Test organizer' },
        } } };
      },
    }) },
  });
  const { origin } = backend;
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  const incoming = { id: 'test-message', subject: 'Agenda draft', from: { name: 'Terry', address: 'terry@example.test' },
    to: [{ name: 'Organizer', address: 'owner@example.test' }], at: '2026-11-24T06:30:00Z', preview: 'Please review the plan.' };
  let connected = false;
  const sent = [];
  const calendar = { connected: true, linked: true, automatic: { enabled: true, status: 'conflict' } };
  const calendarActions = [];
  await page.route('**/api/config', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), outlook: true } });
  });
  await page.route(/\/api\/workspace\/outlook(?:[/?]|$)/, route => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice('/api/workspace/outlook'.length);
    const method = route.request().method();
    if (path === '/complete' && method === 'POST') connected = true;
    if (!path && method === 'DELETE') connected = false;
    if (path === '/mail' && method === 'POST') {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ json: { accepted: true }, status: 202 });
    }
    if (path === '/mail') return route.fulfill({ json: [incoming] });
    if (path === '/mail/test-message') return route.fulfill({ json: { ...incoming, text: '<img src="https://tracker.example.test/pixel"> literal text' } });
    return route.fulfill({ json: { calendar: true, mail: connected } });
  });
  await page.route(/\/api\/meetings\/[^/]+\/outlook(?:[/?]|$)/, route => {
    if (route.request().url().endsWith('/automatic')) {
      calendar.automatic = { enabled: route.request().postDataJSON().enabled, status: 'synced' };
      return route.fulfill({ json: { automatic: calendar.automatic } });
    }
    if (route.request().method() === 'POST') {
      calendarActions.push(route.request().postDataJSON());
      calendar.automatic.status = 'synced';
    }
    return route.fulfill({ json: calendar });
  });
  const auth = await page.request.post(origin + '/api/auth/email/password', {
    headers: { Origin: origin }, data: { email: 'test@example.test', password: 'test-password' },
  });
  assert.equal(auth.status(), 200);
  await page.goto(origin + '/?outlook=complete&outlookApp=mail');
  await page.getByText('Outlook Mail connected.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Read Agenda draft' }).click();
  await page.getByText('<img src="https://tracker.example.test/pixel"> literal text', { exact: true }).waitFor();
  assert.equal(await page.locator('img[src*="tracker.example.test"]').count(), 0);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'New message' }).click();
  await page.getByLabel('To', { exact: true }).fill('terry@example.test');
  await page.getByLabel('Subject').fill('Approved');
  await page.getByLabel('Message', { exact: true }).fill('The agenda is ready.');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Send email' }).click();
  assert.equal(sent.length, 0);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Send email' }).click();
  await page.getByText('Outlook accepted your message for delivery.').waitFor();
  assert.deepEqual(sent, [{ to: ['terry@example.test'], subject: 'Approved', text: 'The agenda is ready.' }]);
  await page.getByRole('button', { name: 'Sent', exact: true }).click();
  await page.getByRole('button', { name: 'Read Agenda draft' }).waitFor();
  await page.screenshot({ path: resolve(output, 'meetrix-outlook-mail.png') });
  await page.getByRole('button', { name: 'Outlook Mail settings' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Disconnect Outlook Mail' }).click();
  await page.getByRole('button', { name: 'Connect Outlook Mail' }).waitFor();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByText('Connect your Outlook Mail account to see messages here.').waitFor();

  const future = new Date(Date.now() + 3600000).toISOString();
  const scheduled = await page.request.post(origin + '/api/meetings', {
    headers: { Origin: origin }, data: { title: 'Outlook review', name: 'Organizer', startAt: future, duration: 30 },
  });
  assert.equal(scheduled.status(), 201);
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await page.getByRole('button', { name: 'Manage scheduled meeting' }).click();
  const paused = page.getByText('Sync paused. Review the event and choose which version to keep.');
  await paused.waitFor();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Keep Meetrix version' }).click();
  assert.deepEqual(calendarActions, []);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Keep Meetrix version' }).click();
  await paused.waitFor({ state: 'detached' });
  assert.deepEqual(calendarActions, [{ direction: 'keep-local' }]);
  const toggle = page.getByLabel('Automatically sync linked changes');
  await toggle.click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Outlook Calendar sync"] input[type="checkbox"]').checked);
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Outlook Calendar sync"] input[type="checkbox"]').checked);
  console.log('Outlook UI passed for separate mail authorization, plain-text rendering, send confirmation, and calendar sync controls.');
} finally {
  await browser?.close();
  backend?.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
}
