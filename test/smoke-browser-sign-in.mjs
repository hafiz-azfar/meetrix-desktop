import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron, chromium } from 'playwright';

const testDirectory = resolve('test-results');
await mkdir(testDirectory, { recursive: true });
const profile = await mkdtemp(join(testDirectory, 'insforge-'));
const executablePath = process.env.MEETRIX_EXE || resolve('release/win-unpacked/Meetrix InsForge.exe');
const args = ['--user-data-dir=' + profile, '--use-fake-device-for-media-stream'];
const app = await electron.launch(existsSync(executablePath) ? { executablePath, args } : { args: ['.', ...args] });
let browser;

try {
  const first = await app.firstWindow({ timeout: 30000 });
  const setup = first.getByRole('heading', { name: 'Connect to a workspace' });
  const entering = first.getByRole('button', { name: 'Continue in your browser' });
  await Promise.race([setup.waitFor({ timeout: 30000 }), entering.waitFor({ timeout: 30000 })]);
  if (await setup.isVisible()) {
    await first.getByLabel('InsForge project URL').fill('http://localhost');
    await first.getByRole('button', { name: 'Use this InsForge project' }).click();
    await first.getByText('INSFORGE_URL must be an HTTPS origin.', { exact: true }).waitFor();
    if (!process.env.INSFORGE_URL) {
      console.log('Windows opens the InsForge setup screen and rejects insecure project URLs.');
    } else {
      await first.getByLabel('InsForge project URL').fill(process.env.INSFORGE_URL);
      if (process.env.INSFORGE_ANON_KEY) await first.getByLabel('Public anon key (optional)').fill(process.env.INSFORGE_ANON_KEY);
      await first.getByRole('button', { name: 'Use this InsForge project' }).click();
    }
  }
  if (process.env.INSFORGE_URL || !await setup.isVisible().catch(() => false)) {
    let desktop;
    for (let attempt = 0; attempt < 80 && !desktop; attempt++) {
      desktop = app.windows().find(page => page.url().startsWith('http://'));
      if (!desktop) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(desktop, 'The local Meetrix workspace opened.');
    await desktop.getByRole('button', { name: 'Continue in your browser' }).waitFor({ timeout: 20000 });
    assert.equal(await desktop.evaluate(() => typeof window.require), 'undefined');
    const config = await desktop.evaluate(() => fetch('/api/config').then(response => response.json()));
    assert.deepEqual({ desktop: config.desktop, mediaReady: config.mediaReady, provider: config.authProvider },
      { desktop: true, mediaReady: true, provider: 'insforge' });
    const assets = new URL('/camera-model/', desktop.url());
    const model = await desktop.request.get(new URL('selfie_segmenter_landscape.tflite', assets).href);
    assert.ok(model.ok());
    assert.equal(createHash('sha256').update(await model.body()).digest('hex'),
      '490e9ea734313e0de10fa0cd9e3c6133e36ea4db2b7a49bde9ef019f72796b8e');
    const wasm = await desktop.request.head(new URL('vision_wasm_internal.wasm', assets).href);
    assert.equal(wasm.headers()['content-type'], 'application/wasm');
    await desktop.getByRole('button', { name: 'Join as a guest' }).click();
    await desktop.getByLabel('Meeting link or code').waitFor();
    await desktop.getByLabel('Display name').waitFor();
    await desktop.getByRole('button', { name: 'Cancel', exact: true }).click();

    await app.evaluate(({ shell }) => {
      shell.openExternal = async url => { globalThis.meetrixBrowserTarget = url; };
    });
    await desktop.getByRole('button', { name: 'Continue in your browser' }).click();
    const code = await desktop.getByLabel('Desktop pairing code').innerText();
    let target;
    for (let attempt = 0; attempt < 20 && !target; attempt++) {
      target = await app.evaluate(() => globalThis.meetrixBrowserTarget || null);
      if (!target) await new Promise(resolve => setTimeout(resolve, 150));
    }
    const url = new URL(target);
    assert.equal(url.origin, new URL(desktop.url()).origin);
    assert.equal(url.pathname, '/desktop-sign-in');

    browser = await chromium.launch({ channel: 'chrome' });
    for (const [provider, domain] of [['Google', 'google.com'], ['GitHub', 'github.com']]) {
      const context = await browser.newContext();
      try {
        let resolveProvider;
        const reached = new Promise(resolve => { resolveProvider = resolve; });
        await context.route('**/*', async route => {
          const request = route.request();
          const host = new URL(request.url()).hostname;
          if (request.isNavigationRequest() && (host === domain || host.endsWith('.' + domain))) {
            resolveProvider();
            await route.abort();
          } else await route.continue();
        });
        const page = await context.newPage();
        await page.goto(url.href);
        await page.getByRole('button', { name: 'Continue with ' + provider, exact: true }).click({ timeout: 15000 });
        let timer;
        try { await Promise.race([reached, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(provider + ' did not reach its authorization site.')), 20000);
        })]); } finally { clearTimeout(timer); }
        console.log(provider + ' reached its authorization site.');
      } finally { await context.close(); }
    }

    if (process.env.MEETRIX_QA_EMAIL && process.env.MEETRIX_QA_PASSWORD) {
      const page = await browser.newPage();
      await page.goto(url.href);
      const switchToPassword = page.getByRole('button', { name: 'Sign in with a password' });
      if (await switchToPassword.isVisible()) await switchToPassword.click();
      await page.getByLabel('Email address').fill(process.env.MEETRIX_QA_EMAIL);
      await page.getByLabel('Password', { exact: true }).fill(process.env.MEETRIX_QA_PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByLabel('Code from Meetrix').fill(code);
      await page.getByRole('button', { name: 'Approve desktop sign-in' }).click();
      await desktop.getByRole('button', { name: 'New meeting', exact: true }).waitFor({ timeout: 15000 });
      assert.equal(await desktop.evaluate(async () => (await fetch('/api/meetings')).status), 200);
      await desktop.getByRole('button', { name: 'Sign out', exact: true }).click();
      assert.equal(await desktop.evaluate(async () => (await fetch('/api/meetings')).status), 401);
      console.log('InsForge account sign-in, desktop pairing, and sign-out passed.');
    }

    await desktop.getByRole('button', { name: 'Join as a guest' }).click();
    await desktop.getByLabel('Meeting link or code').fill('C'.repeat(16));
    await desktop.getByLabel('Display name').fill('Windows camera preview check');
    await desktop.getByRole('button', { name: 'Continue', exact: true }).click();
    await desktop.getByRole('button', { name: 'Camera off' }).click();
    await desktop.getByText('Audio and video devices', { exact: true }).click();
    await desktop.getByLabel('Camera background', { exact: true }).selectOption('blur');
    await desktop.waitForFunction(() => {
      const video = document.querySelector('.preview video');
      const track = video?.srcObject?.getVideoTracks()[0];
      if (!video?.videoWidth || track?.constructor.name !== 'CanvasCaptureMediaStreamTrack') return false;
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[1] > 110;
    });
    console.log('The Windows app loaded the bundled model and blurred the pre-join camera preview.');
  }
} finally {
  await browser?.close();
  await app.close();
}
