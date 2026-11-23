import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { startLocal } from '../desktop/local.cjs';

const results = resolve('test-results');
await mkdir(results, { recursive: true });
const directory = await mkdtemp(join(results, 'cloud-template-'));
const runtime = join(directory, 'runtime');
await mkdir(runtime);
await copyFile(resolve('vendor/runtime/livekit-server.exe'), join(runtime, 'livekit-server.exe'));
let backend;
let frontend;
let browser;

try {
  backend = await startLocal({
    directory, runtime, origin: 'http://127.0.0.1:0', instance: { insforgeUrl: 'https://auth.meetrix.test' },
    dependencies: { authenticate: async identity => {
      if (!['host', 'attendee', 'recorder'].includes(identity)) throw new Error('Invalid fixture identity.');
      return identity;
    } },
  });
  frontend = await createServer({ configFile: false, optimizeDeps: { entries: ['test/rtc.html', 'recording.html'] },
    server: { host: '127.0.0.1', port: 0 } });
  await frontend.listen();
  const web = 'http://127.0.0.1:' + frontend.httpServer.address().port;
  browser = await chromium.launch({
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const host = await browser.newPage();
  const attendee = await browser.newPage();
  const recorder = await browser.newPage();

  async function post(path, identity, body) {
    const response = await fetch(backend.origin + '/api' + path, { method: 'POST', headers: {
      Origin: backend.origin, Authorization: 'Bearer ' + identity, 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) });
    const data = await response.json();
    assert.ok(response.ok, data.error);
    return data;
  }

  const meeting = await post('/meetings', 'host', { title: 'Template smoke test', name: 'Host', lobby: false });
  const path = '/meetings/' + meeting.id + '/connect';
  const hostSession = await post(path, 'host', { name: 'Host' });
  const recorderSession = await post(path, 'recorder', { name: 'Recorder' });
  const attendeeSession = await post(path, 'attendee', { name: 'Unconsented attendee' });

  await host.goto(web + '/test/rtc.html');
  await host.waitForFunction(() => !!window.join);
  await host.evaluate(session => window.join(session), hostSession);
  const hostSid = await host.evaluate(async () => {
    await window.testRoom.localParticipant.setCameraEnabled(true);
    await window.testRoom.localParticipant.setMicrophoneEnabled(true);
    return window.testRoom.localParticipant.sid;
  });

  const authorized = { room: meeting.id, serverUrl: hostSession.serverUrl, participants: [{ identity: 'host', sid: hostSid }] };
  await recorder.route(web + '/api/recording-template', route => route.fulfill({ json: authorized }));
  const template = new URL('/recording.html', web);
  template.searchParams.set('access', 'fixture-ticket');
  template.searchParams.set('token', recorderSession.token);
  const start = recorder.waitForEvent('console', message => message.text() === 'START_RECORDING');
  await recorder.goto(template.href);
  await start;
  await recorder.locator('video').waitFor();
  await recorder.locator('audio').waitFor({ state: 'attached' });
  await recorder.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  assert.equal(new URL(recorder.url()).search, '');

  const stop = recorder.waitForEvent('console', message => message.text() === 'END_RECORDING');
  await attendee.goto(web + '/test/rtc.html');
  await attendee.waitForFunction(() => !!window.join);
  await attendee.evaluate(session => window.join(session), attendeeSession);
  await stop;
  assert.equal(await recorder.locator('video, audio').count(), 0);
  assert.equal(await recorder.getByText('Unconsented attendee').count(), 0);
  console.log('The Egress template attached consented LiveKit media and ended on an unconsented join.');
} finally {
  await browser?.close();
  await frontend?.close();
  backend?.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
