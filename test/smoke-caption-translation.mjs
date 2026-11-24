import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron as electron, chromium } from 'playwright';
import { startLocal } from '../desktop/local.cjs';

const directory = resolve('test-results');
await mkdir(directory, { recursive: true });
const profile = await mkdtemp(resolve(directory, 'caption-translation-'));
const workerAsset = (await readdir('dist/assets')).find(file => /^caption-translation-worker-.*\.js$/.test(file));
assert.ok(workerAsset, 'Build the translation worker before running this test.');
let app;
let browser;
let backend;
try {
  let page;
  if (process.argv.includes('--desktop')) {
    app = await electron.launch({
      executablePath: process.env.MEETRIX_EXE || resolve('release/win-unpacked/Meetrix InsForge.exe'),
      args: ['--user-data-dir=' + profile],
    });
    page = await app.firstWindow({ timeout: 30000 });
    await page.waitForFunction(() => location.protocol === 'http:' && !!window.meetrixDesktop);
  } else {
    backend = await startLocal({
      directory: profile, runtime: resolve('vendor/runtime'), origin: 'http://127.0.0.1:0',
      instance: { insforgeUrl: 'https://auth.meetrix.test' },
    });
    browser = await chromium.launch({ channel: 'chrome' });
    page = await browser.newPage();
    await page.goto(backend.origin);
  }
  const fullOrigin = new URL(page.url()).origin;
  const otherOrigins = [];
  let closedNetwork = false;
  await page.route('**/*', route => {
    if (!closedNetwork || new URL(route.request().url()).origin === fullOrigin) return route.continue();
    otherOrigins.push(new URL(route.request().url()).origin);
    return route.abort();
  });
  closedNetwork = true;
  for (const language of ['hi', 'es', 'summary']) {
    const result = await page.evaluate(({ language, workerAsset }) => new Promise((resolve, reject) => {
      const worker = new Worker('/assets/' + workerAsset, { type: 'module' });
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Translation worker timed out')); }, 60000);
      const finish = callback => value => {
        clearTimeout(timeout);
        worker.terminate();
        callback(value);
      };
      worker.onerror = finish(event => reject(new Error(event.message)));
      worker.onmessage = finish(event => resolve(event.data));
      const text = language === 'summary'
        ? 'The project team approved the product launch. The release is scheduled for Friday. Maya will prepare the release notes before launch.'
        : 'The meeting starts tomorrow.';
      worker.postMessage({ id: 'test', text, language, action: language === 'summary' ? 'summarize' : undefined });
    }), { workerAsset, language });
    assert.equal(result.id, 'test');
    assert.match(result.text ?? '', language === 'hi' ? /[\u0900-\u097f]/ : language === 'es' ? /reunión.*mañana/i : /launch|release/i);
  }
  assert.deepEqual(otherOrigins, []);
  console.log('Caption translations and the meeting summary ran locally with external requests disabled.');
} finally {
  await app?.close();
  await browser?.close();
  backend?.stop();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
}
