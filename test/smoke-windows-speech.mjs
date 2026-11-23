import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const directory = resolve('test-results');
const fixture = join(directory, 'speech-fixture.wav');
const source = 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17' +
  '/resolve/d42f2d9f7ca24806fb667456a18a9f1b60f70d16/test_wavs/0.wav';
await mkdir(directory, { recursive: true });
const audio = await readFile(fixture).catch(async error => {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, 'Could not fetch the speech test fixture.');
  return Buffer.from(await response.arrayBuffer());
});
assert.equal(createHash('sha256').update(audio).digest('hex'), '6bc58a4efdf20daac252b6b1502632601a71efe0308f6757dc1eda34891a7e4f');
const speech = require(resolve('vendor/runtime/speech/sherpa-onnx.node'));
const wave = speech.readWaveFromBinary(audio);
assert.equal(wave.sampleRate, 16000);

const profile = await mkdtemp(join(directory, 'windows-speech-'));
const executablePath = process.env.MEETRIX_EXE || resolve('release/win-unpacked/Meetrix InsForge.exe');
const inputAsset = (await readdir('dist/assets')).find(file => /^speech-input-[A-Za-z0-9_-]+\.js$/.test(file));
assert.ok(inputAsset, 'Build the browser and Windows assets before running this test.');
let app;

try {
  const userData = '--user-data-dir=' + profile;
  app = await electron.launch(process.env.MEETRIX_TEST_SOURCE ? { args: ['.', userData] } : { executablePath, args: [userData] });
  const page = await app.firstWindow({ timeout: 30000 });
  await page.waitForFunction(() => location.protocol === 'http:' && !!window.meetrixDesktop);
  const result = await page.evaluate(async ({ audioSamples, inputAsset }) => {
    const { speech } = window.meetrixDesktop;
    if (!(await speech.available())) throw new Error('Offline speech resources are missing.');
    const session = await speech.start();
    const events = [];
    const stopListening = speech.onResult(event => events.push(event));
    try {
      let duplicateRejected = false;
      try { await speech.start(); }
      catch { duplicateRejected = true; }
      const { captureCaptionAudio } = await import('/assets/' + inputAsset);
      const context = new AudioContext({ sampleRate: 16000 });
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, audioSamples.length + 32000, context.sampleRate);
      source.buffer.copyToChannel(Float32Array.from(audioSamples), 0);
      const output = context.createMediaStreamDestination();
      source.connect(output);
      const track = output.stream.getAudioTracks()[0];
      let capture;
      let failed;
      try {
        await context.resume();
        capture = await captureCaptionAudio(track, ({ samples, sampleRate }) => speech.push(session, samples, sampleRate),
          error => { failed = error; });
        await new Promise(resolve => { source.onended = resolve; source.start(); });
        await new Promise(resolve => setTimeout(resolve, 350));
        if (failed) throw failed;
      } finally {
        capture?.stop();
        const sourceIntact = track.readyState === 'live';
        track.stop();
        await context.close();
        if (!sourceIntact) throw new Error('Stopping captions stopped the meeting audio source.');
      }
      return { events, duplicateRejected, session };
    } finally {
      stopListening();
      await speech.stop(session);
    }
  }, { audioSamples: Array.from(wave.samples), inputAsset });
  assert.equal(result.duplicateRejected, true);
  assert.ok(result.events.every(event => event.id === result.session && !event.error));
  assert.match(result.events.find(event => event.final)?.text || '', /the yellow lamps would light up here and there/i);
  console.log('The Windows speech engine recognized a real voice sample locally and returned finalized captions.');
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
}
