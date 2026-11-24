import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const directory = resolve('test-results');
await mkdir(directory, { recursive: true });
const profile = await mkdtemp(join(directory, 'windows-share-'));
const executablePath = process.env.MEETRIX_EXE || resolve('release/win-unpacked/Meetrix InsForge.exe');
let app;

try {
  app = await electron.launch({ executablePath, args: ['--user-data-dir=' + profile] });
  const page = await app.firstWindow({ timeout: 30000 });
  await page.waitForFunction(() => location.protocol === 'http:' && !!window.meetrixDesktop);
  await app.evaluate(({ desktopCapturer, dialog }) => {
    const listSources = desktopCapturer.getSources.bind(desktopCapturer);
    const state = { cancel: false };
    globalThis.meetrixShareTest = state;
    desktopCapturer.getSources = async options => {
      state.types = options.types;
      return listSources(options);
    };
    dialog.showMessageBox = async (_window, options) => {
      state.choice = { defaultId: options.defaultId, cancelId: options.cancelId, detail: options.detail };
      return { response: state.cancel ? options.cancelId : 0 };
    };
  });

  async function capture(sound, cancel = false) {
    await app.evaluate((_electron, cancel) => { globalThis.meetrixShareTest.cancel = cancel; }, cancel);
    await page.evaluate(sound => {
      window.meetrixShareResult = null;
      const button = document.createElement('button');
      button.textContent = 'Check the Windows capture source';
      Object.assign(button.style, { position: 'fixed', top: '0', left: '0', zIndex: '999' });
      button.onclick = async () => {
        button.remove();
        try {
          const media = await navigator.mediaDevices.getDisplayMedia({
            video: true, audio: sound ? { restrictOwnAudio: true } : false,
          });
          window.meetrixShareResult = {
            video: media.getVideoTracks().map(track => track.readyState),
            audio: media.getAudioTracks().map(track => track.readyState),
          };
          media.getVideoTracks().forEach(track => track.stop());
          window.meetrixShareResult.audioWithoutVideo = media.getAudioTracks().map(track => track.readyState);
          media.getTracks().forEach(track => track.stop());
        } catch (error) { window.meetrixShareResult = { error: error.name }; }
      };
      document.body.append(button);
    }, sound);
    await page.getByRole('button', { name: 'Check the Windows capture source' }).click();
    const result = await page.waitForFunction(() => window.meetrixShareResult);
    return { tracks: await result.jsonValue(), prompt: await app.evaluate(() => globalThis.meetrixShareTest) };
  }

  const declined = await capture(true, true);
  assert.ok(declined.tracks.error);
  assert.deepEqual(declined.prompt.types, ['screen']);
  assert.equal(declined.prompt.choice.defaultId, declined.prompt.choice.cancelId);
  assert.match(declined.prompt.choice.detail, /system audio/);
  const silent = await capture(false);
  assert.deepEqual(silent.prompt.types, ['screen', 'window']);
  assert.deepEqual(silent.tracks, { video: ['live'], audio: [], audioWithoutVideo: [] });
  const audible = await capture(true);
  assert.deepEqual(audible.tracks, { video: ['live'], audio: ['live'], audioWithoutVideo: ['live'] });
  console.log('Windows native capture passed for cancellation, video only, and opt-in display audio.');
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
}
