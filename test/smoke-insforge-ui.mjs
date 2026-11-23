import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/app.mjs';

const origin = 'http://127.0.0.1:4327';
let callback;
let verifier;
const { app, close } = createApp({
  origin, insforgeUrl: 'https://auth.meetrix.test', databasePath: ':memory:', assets: resolve('dist'), desktop: true,
}, { createAuth: () => ({
  async getPublicAuthConfig() { return { data: { oAuthProviders: ['google', 'github'] } }; },
  async signInWithOAuth(provider, { redirectTo }) {
    assert.equal(provider, 'google');
    callback = new URL(redirectTo);
    callback.searchParams.set('insforge_code', 'simulated-provider-code');
    verifier = randomBytes(32).toString('base64url');
    return { data: { url: 'https://accounts.google.com/o/oauth2/v2/auth', codeVerifier: verifier } };
  },
  async exchangeOAuthCode(code, proof) {
    assert.equal(code, 'simulated-provider-code');
    assert.equal(proof, verifier);
    return { data: { accessToken: 'simulated-token', user: { id: '4e5c7bb9-0218-4d57-b9c0-4ff45db24395', profile: { name: 'Meetrix QA' } } } };
  },
}) });
const server = app.listen(4327, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
  const desktop = await browser.newPage();
  await desktop.addInitScript(() => {
    window.meetrixDesktop = {
      openSignIn(request) { window.testBrowserUrl = '/desktop-sign-in?request=' + request; },
    };
  });
  await desktop.goto(origin);
  await desktop.getByRole('button', { name: 'Continue in your browser' }).click();
  const code = await desktop.getByLabel('Desktop pairing code').innerText();
  await desktop.waitForFunction(() => !!window.testBrowserUrl);
  const approval = await browser.newPage();
  await approval.route('https://accounts.google.com/**', route => route.fulfill({ status: 303, headers: { Location: callback.href } }));
  await approval.goto(origin + await desktop.evaluate(() => window.testBrowserUrl));
  await approval.getByRole('button', { name: 'Continue with GitHub' }).waitFor();
  assert.equal(await approval.getByText(/development mode|clerk/i).count(), 0);
  await mkdir('test-results', { recursive: true });
  await approval.screenshot({ path: 'test-results/insforge-sign-in.png' });
  await approval.getByRole('button', { name: 'Continue with Google' }).click();
  await approval.getByLabel('Code from Meetrix').fill(code);
  await approval.getByRole('button', { name: 'Approve desktop sign-in' }).click();
  await approval.getByRole('heading', { name: 'Desktop sign-in approved' }).waitFor();
  await desktop.getByRole('button', { name: 'New meeting', exact: true }).waitFor({ timeout: 15000 });
  await desktop.getByRole('button', { name: 'Sign out', exact: true }).click();
  await desktop.getByRole('button', { name: 'Continue in your browser' }).waitFor();
  console.log('InsForge sign-in UI, OAuth callback, desktop handoff, and sign-out passed with simulated provider responses.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  close();
}
