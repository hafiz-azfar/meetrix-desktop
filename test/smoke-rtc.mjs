import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { startLocal } from '../desktop/local.cjs';

const directory = resolve('test-results');
await mkdir(directory, { recursive: true });
const runDirectory = await mkdtemp(join(directory, 'rtc-'));
const origin = 'http://localhost:4318';
const clerkPublishableKey = 'pk_test_' + Buffer.from('clerk.meetrix.test$').toString('base64url');
const browser = await chromium.launch({
  ...(process.env.CI ? {} : { channel: 'chrome' }),
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
let backend;
let frontend;
try {
  backend = await startLocal({ directory: runDirectory, runtime: resolve('vendor/runtime'), origin,
    testInstance: { clerkPublishableKey },
    dependencies: { authenticate: async token => {
      if (!['host', 'guest'].includes(token)) throw Error('Invalid test user.');
      return token;
    } },
  });
  frontend = await createServer({ configFile: false, optimizeDeps: { entries: ['test/rtc.html'] }, server: { host: '127.0.0.1', port: 0 } });
  await frontend.listen();
  const testUrl = 'http://127.0.0.1:' + frontend.httpServer.address().port + '/test/rtc.html';
  async function post(path, token, body) {
    const response = await fetch(origin + '/api' + path, { method: 'POST', headers: {
      Origin: origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) });
    const data = await response.json();
    assert.ok(response.ok, data.error);
    return data;
  }
  for (const encrypted of [false, true]) {
    const host = await browser.newPage();
    const guest = await browser.newPage();
    await Promise.all([host.goto(testUrl), guest.goto(testUrl)]);
    await Promise.all([host.waitForFunction(() => !!window.join), guest.waitForFunction(() => !!window.join)]);
    const key = encrypted ? await host.evaluate(() => window.generateRoomKey()) : null;
    const meeting = await post('/meetings', 'host', { title: 'RTC smoke test', name: 'Host', lobby: true, encrypted });
    const path = '/meetings/' + meeting.id;
    const open = await post(path + '/connect', 'host', { name: 'Host', keyReady: encrypted });
    assert.equal((await post(path + '/connect', 'guest', { name: 'Guest' })).state, 'waiting');
    await post(path + '/moderate', 'host', { action: 'decide', identity: 'guest', admit: true });
    const admitted = await post(path + '/connect', 'guest', { name: 'Guest', keyReady: encrypted });
    for (const [page, session] of [[host, open], [guest, admitted]]) {
      const status = await page.evaluate(([session, key]) => window.join(session, key), [session, key]);
      assert.equal(status.connected, 'connected');
      assert.equal(status.encrypted, encrypted);
    }
    await host.evaluate(async () => {
      await window.testRoom.localParticipant.setMicrophoneEnabled(true);
      await window.testRoom.localParticipant.setCameraEnabled(true);
    });
    await guest.waitForFunction(() => window.receivedVideoFrame && window.tracks.some(track => track.kind === 'audio'),
      undefined, { timeout: 15000 });
    if (encrypted) assert.ok((await guest.evaluate(() => window.tracks)).every(track => track.encryption > 0));
    await host.evaluate(() => window.testRoom.localParticipant.publishData(new TextEncoder().encode('room message'), { reliable: true }));
    await guest.waitForFunction(() => window.messages.includes('room message'));
    await post(path + '/moderate', 'host', { action: 'remove', identity: 'guest' });
    await guest.waitForFunction(() => window.testRoom.state === 'disconnected');
    await post(path + '/moderate', 'host', { action: 'end' });
    await host.waitForFunction(() => window.testRoom.state === 'disconnected');
    await Promise.all([host.close(), guest.close()]);
    console.log((encrypted ? 'Encrypted' : 'Standard') + ' two-client LiveKit meeting passed: lobby, video, audio, data, removal and ending.');
  }
} finally {
  await frontend?.close();
  await browser.close();
  backend?.stop();
  await new Promise(resolve => setTimeout(resolve, 350));
  await rm(runDirectory, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
}
