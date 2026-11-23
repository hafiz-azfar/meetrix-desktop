import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startLocal } from '../desktop/local.cjs';

const results = resolve('test-results');
await mkdir(results, { recursive: true });
const directory = await mkdtemp(resolve(results, 'guest-meeting-'));
async function waitForCameraColor(page, selector, color) {
  await page.waitForFunction(({ selector, color }) => {
    const video = document.querySelector(selector);
    if (video?.readyState < 2 || !video?.videoWidth) return false;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    context.drawImage(video, video.videoWidth * 0.14, video.videoHeight * 0.28, 8, 8, 0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return color === 'pink' ? red > 160 && blue > 100 && green < 100 : green > 110 && red < 115;
  }, { selector, color });
}
let backend;
let browser;
try {
  backend = await startLocal({
    directory, runtime: resolve('vendor/runtime'), origin: 'http://127.0.0.1:0',
    instance: { insforgeUrl: 'https://auth.meetrix.test' },
    dependencies: { createAuth: () => ({
      async getPublicAuthConfig() { return { data: { oAuthProviders: [] } }; },
      async signInWithPassword({ email }) {
        const delegate = email === 'delegate@example.test';
        const id = delegate ? 'd338dd36-66ed-4dba-8f37-ddc3af85a041' : '4e5c7bb9-0218-4d57-b9c0-4ff45db24395';
        return { data: { accessToken: 'test-token', user: { id, profile: { name: delegate ? 'Design partner' : 'Alex Morgan' } } } };
      },
    }) },
  });
  const origin = backend.origin;
  browser = await chromium.launch({
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'],
  });
  const host = await browser.newPage({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
  const guest = await browser.newPage({ permissions: ['camera', 'microphone'] });
  await host.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async options => {
      window.testShareOptions = options;
      const stream = await navigator.mediaDevices.getUserMedia({ video: options.video });
      window.testShareTrack = stream.getVideoTracks()[0];
      if (options.audio) {
        const audio = new AudioContext();
        const signal = audio.createOscillator();
        const output = audio.createMediaStreamDestination();
        signal.connect(output);
        signal.start();
        await audio.resume();
        window.testShareAudio = output.stream.getAudioTracks()[0];
        stream.addTrack(window.testShareAudio);
        window.testAudioContext = audio;
      }
      return stream;
    };
  });
  const hostSignIn = await host.request.post(origin + '/api/auth/email/password', {
    headers: { Origin: origin }, data: { email: 'host@example.test', password: 'test-password' },
  });
  assert.equal(hostSignIn.status(), 200);

  await host.goto(origin);
  await host.getByText('Your schedule is clear').waitFor();
  await host.getByRole('button', { name: 'Schedule meeting', exact: true }).click();
  await host.getByLabel('Meeting name').fill('Weekly team check-in');
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const localTime = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await host.getByLabel('Start time').fill(localTime);
  await host.getByRole('dialog').getByRole('button', { name: 'Schedule', exact: true }).click();
  await host.getByText('Weekly team check-in', { exact: true }).waitFor();
  await host.getByRole('button', { name: 'Home', exact: true }).click();
  await host.getByText('Weekly team check-in', { exact: true }).waitFor();
  await host.screenshot({ path: resolve(results, 'meetrix-home.png') });
  await host.getByRole('button', { name: 'Settings', exact: true }).click();
  await host.getByRole('heading', { name: 'Audio', exact: true }).waitFor();
  await host.screenshot({ path: resolve(results, 'meetrix-settings.png') });

  const volume = host.getByRole('slider', { name: 'Speaker volume' });
  await volume.press('ArrowLeft');
  await host.waitForFunction(() => JSON.parse(localStorage.getItem('meetrix-devices')).speakerVolume === 0.99);
  await host.getByRole('button', { name: 'Check microphone', exact: true }).click();
  await host.getByText('Speak to check the input level.').waitFor();
  await host.getByRole('button', { name: 'Stop microphone check' }).click();
  await host.getByRole('button', { name: 'Play test tone' }).click();
  await host.getByRole('button', { name: 'Playing test tone…' }).waitFor();
  await host.getByRole('button', { name: 'Play test tone' }).waitFor();

  await host.getByRole('button', { name: 'Video', exact: true }).click();
  await host.getByRole('button', { name: 'Start camera preview' }).click();
  await host.waitForFunction(() => document.querySelector('.video-settings video')?.readyState >= 2);
  const track = await host.locator('.video-settings video').evaluateHandle(video => video.srcObject.getVideoTracks()[0]);
  await host.getByLabel('Mirror my local view').uncheck();
  assert.equal(await host.locator('.video-settings video').evaluate(video => getComputedStyle(video).transform), 'none');
  const magenta = await host.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ed2198';
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await host.getByLabel('Camera background', { exact: true }).selectOption('blur');
  await host.waitForFunction(() => document.querySelector('.video-settings video')?.srcObject?.getVideoTracks()[0]?.constructor.name === 'CanvasCaptureMediaStreamTrack');
  await waitForCameraColor(host, '.video-settings video', 'green');
  await host.getByLabel('Choose background image', { exact: true }).setInputFiles({
    name: 'pink.png', mimeType: 'image/png', buffer: Buffer.from(magenta, 'base64'),
  });
  await waitForCameraColor(host, '.video-settings video', 'pink');
  await host.screenshot({ path: resolve(results, 'meetrix-camera-background.png') });
  await host.getByRole('button', { name: 'Meeting defaults' }).click();
  assert.equal(await track.evaluate(videoTrack => videoTrack.readyState), 'ended');
  await track.dispose();
  await host.getByLabel('Starting layout').selectOption('speaker');
  await host.waitForFunction(() => JSON.parse(localStorage.getItem('meetrix-devices')).layout === 'speaker');
  await host.getByLabel('Show elapsed time').check();
  await host.waitForFunction(() => JSON.parse(localStorage.getItem('meetrix-devices')).meetingTimer === true);
  await host.getByRole('button', { name: 'Appearance' }).click();
  await host.getByLabel('App theme').selectOption('dark');
  await host.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === 'dark');
  await host.screenshot({ path: resolve(results, 'meetrix-settings-dark.png') });
  await host.reload();
  await host.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await host.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
  assert.equal(await host.evaluate(() => JSON.parse(localStorage.getItem('meetrix-devices')).meetingTimer), true);
  assert.equal(await host.evaluate(() => JSON.parse(localStorage.getItem('meetrix-devices')).background), 'image');
  await host.getByRole('button', { name: 'Appearance' }).click();
  await host.getByLabel('App theme').selectOption('light');
  await host.getByRole('button', { name: 'Accessibility', exact: true }).click();
  await host.getByLabel('Meeting chat text size').selectOption('largest');
  await host.getByLabel('Announce new messages in the open chat panel').uncheck();
  await host.getByLabel('Reduce motion').check();
  await host.waitForFunction(() => document.documentElement.dataset.reducedMotion === 'true');
  await host.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  const cameraShortcut = host.getByLabel('Toggle camera', { exact: true });
  assert.equal(await cameraShortcut.locator('option[value="M"]').isDisabled(), true);
  await cameraShortcut.selectOption('K');
  await host.getByRole('button', { name: 'Screen sharing', exact: true }).click();
  await host.getByLabel('Capture frame rate').selectOption('5');
  await host.getByLabel('Content priority').selectOption('text');
  await host.getByLabel('Shared screen layout').selectOption('side');
  await host.setViewportSize({ width: 390, height: 844 });
  await host.getByRole('button', { name: 'Audio', exact: true }).click();
  assert.ok(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await host.setViewportSize({ width: 1280, height: 800 });
  await host.getByRole('button', { name: 'Home', exact: true }).click();

  await host.getByRole('button', { name: 'New meeting', exact: true }).click();
  await host.getByLabel('Meeting name').fill('Guest smoke test');
  await host.getByLabel('Passcode').fill('test passcode');
  await host.getByLabel('Allow guests without an account').check();
  await host.getByRole('button', { name: 'Continue', exact: true }).click();
  await host.getByRole('button', { name: 'Camera off' }).click();
  await waitForCameraColor(host, '.preview video', 'pink');
  await host.getByRole('button', { name: 'Enter room' }).click();
  await host.getByRole('button', { name: 'Devices', exact: true }).waitFor();
  await host.getByRole('button', { name: 'Gallery', exact: true }).waitFor();
  try { await host.locator('time.call-timer').waitFor({ timeout: 15000 }); }
  catch {
    assert.fail(await host.evaluate(() => JSON.stringify({
      status: document.querySelector('.call-title')?.innerText,
      notice: document.querySelector('.call-notice')?.innerText,
      meetingTimer: JSON.parse(localStorage.getItem('meetrix-devices')).meetingTimer,
    })));
  }
  assert.equal(await host.evaluate(() => JSON.parse(localStorage.getItem('meetrix-devices')).camera), false);
  const meetings = await (await host.request.get(origin + '/api/meetings')).json();
  const id = meetings.find(meeting => meeting.title === 'Guest smoke test').id;

  await guest.goto(origin + '/join?m=' + id);
  await guest.getByRole('button', { name: 'Join as a guest' }).click();
  await guest.getByLabel('Display name').fill('Test guest');
  await guest.getByLabel('Passcode').fill('test passcode');
  await guest.getByRole('button', { name: 'Continue', exact: true }).click();
  await guest.getByRole('button', { name: 'Join now' }).click();
  await guest.getByText('The host will admit you from the waiting room.').waitFor();
  await host.getByText('Unverified guest', { exact: true }).waitFor();
  await host.getByRole('button', { name: 'Admit', exact: true }).click();
  await guest.getByRole('button', { name: 'Devices', exact: true }).waitFor();
  await waitForCameraColor(guest, '.stage video', 'pink');
  assert.equal((await guest.request.get(origin + '/api/meetings/' + id + '/notes')).status(), 401);
  await host.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await host.waitForFunction(() => document.fullscreenElement === document.documentElement);
  await host.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await host.waitForFunction(() => document.fullscreenElement === null);

  const cameraToggle = host.getByRole('button', { name: 'Camera', exact: true });
  await host.getByRole('button', { name: 'Devices', exact: true }).click();
  await host.getByLabel('Camera background', { exact: true }).selectOption('blur');
  await host.getByRole('button', { name: 'Done', exact: true }).click();
  await waitForCameraColor(guest, '.stage video', 'green');
  await cameraToggle.click();
  await guest.locator('.stage video').waitFor({ state: 'detached' });
  const modelRoute = '**/camera-model/selfie_segmenter_landscape.tflite';
  await host.route(modelRoute, request => request.abort());
  await cameraToggle.click();
  await host.getByText('The camera stayed off because its background could not be started.').waitFor();
  assert.equal(await cameraToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await guest.locator('.stage video').count(), 0);
  await host.unroute(modelRoute);
  await host.getByRole('button', { name: 'Devices', exact: true }).click();
  await host.getByLabel('Camera background', { exact: true }).selectOption('off');
  await host.getByRole('button', { name: 'Done', exact: true }).click();
  await cameraToggle.click();
  await waitForCameraColor(guest, '.stage video', 'green');
  await host.getByRole('button', { name: 'Chat', exact: true }).click();
  await host.getByRole('textbox', { name: 'Message', exact: true }).focus();
  assert.equal(await host.locator('.chat-log').getAttribute('aria-live'), 'off');
  assert.equal(await host.locator('.chat-log').getAttribute('data-text-size'), 'largest');
  await host.keyboard.press('Alt+Shift+K');
  assert.equal(await cameraToggle.getAttribute('aria-pressed'), 'true');
  await host.getByRole('button', { name: 'Close panel' }).click();
  await host.keyboard.press('Alt+Shift+K');
  await host.locator('button[aria-pressed="false"]').filter({ hasText: /^Camera$/ }).waitFor();
  await host.keyboard.press('Alt+Shift+K');
  await host.locator('button[aria-pressed="true"]').filter({ hasText: /^Camera$/ }).waitFor();

  await guest.getByRole('button', { name: 'Call statistics' }).click();
  await guest.locator('.stat-sample').filter({ hasText: 'Camera' }).getByText(/\d+ kb\/s/).waitFor();
  await host.getByRole('button', { name: 'Share', exact: true }).click();
  assert.equal(await host.getByLabel('Include sound').isChecked(), false);
  await host.getByLabel('Include sound').check();
  await host.getByRole('button', { name: 'Choose source', exact: true }).click();
  await host.locator('.stage.share-side .share video').waitFor();
  await guest.locator('.share video').waitFor();
  assert.equal(await host.evaluate(() => window.testShareOptions.video.frameRate), 5);
  assert.equal(await host.evaluate(() => window.testShareTrack.contentHint), 'text');
  assert.equal(await host.evaluate(() => window.testShareOptions.audio.restrictOwnAudio), true);
  await guest.getByText('Alex Morgan is sharing with sound', { exact: true }).waitFor();
  await guest.locator('.stat-sample').filter({ hasText: 'Shared audio' }).getByText(/[1-9]\d* kb\/s/).waitFor();

  await guest.getByRole('button', { name: 'View preferences' }).click();
  await guest.getByLabel('Pause incoming cameras').check();
  await guest.getByLabel('Hide my tile from my view').check();
  await guest.getByRole('button', { name: 'Done', exact: true }).click();
  await guest.locator('.stat-sample').filter({ hasText: 'Camera' }).waitFor({ state: 'detached' });
  assert.equal(await guest.locator('.stage .tile video').count(), 0);
  assert.equal(await guest.locator('.stage .tile').count(), 1);
  await guest.locator('.share video').waitFor();
  await guest.getByRole('button', { name: 'View preferences' }).click();
  await guest.getByLabel('Pause incoming cameras').uncheck();
  await guest.getByRole('button', { name: 'Done', exact: true }).click();
  await guest.locator('.stage .tile video').waitFor();
  await guest.screenshot({ path: resolve(results, 'meetrix-call-statistics.png') });
  await host.getByRole('button', { name: 'Stop share', exact: true }).click();
  await guest.locator('.stat-sample').filter({ hasText: 'Shared audio' }).waitFor({ state: 'detached' });
  await host.waitForFunction(() => window.testShareTrack.readyState === 'ended' && window.testShareAudio.readyState === 'ended');
  await host.evaluate(() => window.testAudioContext.close());
  await guest.getByRole('button', { name: 'Close panel' }).click();

  await host.getByRole('button', { name: 'Devices', exact: true }).click();
  const camera = host.getByLabel('Camera device', { exact: true });
  await host.waitForFunction(() => document.querySelector('select[aria-label="Camera device"]')?.options.length > 1);
  const cameraId = await camera.selectOption({ index: 1 });
  await host.waitForFunction(id => JSON.parse(localStorage.getItem('meetrix-devices')).cameraId === id, cameraId[0]);
  await camera.selectOption('');
  await host.waitForFunction(() => JSON.parse(localStorage.getItem('meetrix-devices')).cameraId === '');
  await host.getByRole('button', { name: 'Done', exact: true }).click();
  await guest.waitForFunction(() => Array.from(document.querySelectorAll('.stage video')).some(video => video.readyState >= 2));

  await host.getByRole('button', { name: 'Captions', exact: true }).click();
  await guest.getByRole('button', { name: 'Captions', exact: true }).click();
  assert.equal(await guest.getByRole('textbox', { name: 'Caption text' }).count(), 0);
  await host.getByRole('textbox', { name: 'Caption text' }).fill('The demo starts now.');
  await host.getByRole('button', { name: 'Send caption' }).click();
  const overlay = guest.locator('.caption-overlay').getByText('The demo starts now.');
  await overlay.waitFor();
  await guest.getByLabel('Show captions on stage').uncheck();
  await overlay.waitFor({ state: 'detached' });
  await guest.getByRole('region', { name: 'Caption history' }).getByText('The demo starts now.').waitFor();
  const captionDownload = guest.waitForEvent('download');
  await guest.getByRole('button', { name: 'Save caption history' }).click();
  const captionFile = await captionDownload;
  assert.match(captionFile.suggestedFilename(), /-captions\.txt$/);
  assert.match(await readFile(await captionFile.path(), 'utf8'), /The demo starts now\./);

  assert.equal(await guest.getByRole('button', { name: 'Record', exact: true }).count(), 0);
  await host.getByRole('button', { name: 'Unmute', exact: true }).click();
  await host.getByRole('button', { name: 'Mute', exact: true }).waitFor();
  await host.getByRole('button', { name: 'Record', exact: true }).click();
  await host.getByRole('button', { name: 'Request recording' }).click();
  const startRecording = host.getByRole('button', { name: 'Start recording', exact: true });
  await guest.getByRole('button', { name: 'Allow recording' }).waitFor();
  assert.equal(await startRecording.isDisabled(), true);
  await guest.getByRole('button', { name: 'Decline recording' }).click();
  await host.locator('.recording-consent').getByText('Declined', { exact: true }).waitFor();
  assert.equal(await startRecording.isDisabled(), true);
  await guest.getByRole('button', { name: 'Allow recording' }).click();
  await host.locator('.recording-consent').getByText('Allowed', { exact: true }).waitFor();
  await host.bringToFront();
  await startRecording.click();
  await host.getByRole('button', { name: 'Stop recording' }).waitFor();
  await guest.getByText('Meeting recording is active.', { exact: true }).waitFor();
  await host.screenshot({ path: resolve(results, 'meetrix-recording.png') });
  await guest.getByRole('button', { name: 'Withdraw consent' }).click();
  await host.getByText('Recording stopped because a participant withdrew consent.').waitFor();
  await guest.getByText('Meeting recording is active.', { exact: true }).waitFor({ state: 'detached' });
  const videoDownload = host.waitForEvent('download');
  await host.getByRole('button', { name: 'Save WebM' }).click();
  const videoFile = await videoDownload;
  assert.match(videoFile.suggestedFilename(), /\.webm$/);
  const recording = await readFile(await videoFile.path());
  assert.ok(recording.length > 500);
  assert.equal(recording.subarray(0, 4).toString('hex'), '1a45dfa3');
  await videoFile.saveAs(resolve(results, 'meetrix-consented-test.webm'));

  await host.getByRole('button', { name: 'Request recording' }).click();
  await guest.getByRole('button', { name: 'Allow recording' }).click();
  await startRecording.click();
  await host.getByRole('button', { name: 'Stop recording' }).waitFor();

  const sections = [['Design partner', '0'], ['Workshop guest', '1']];
  const otherGuests = await Promise.all(sections.map(async ([name]) => {
    const page = await browser.newPage({ permissions: ['camera', 'microphone'] });
    const signedIn = name === 'Design partner';
    if (signedIn) {
      const response = await page.request.post(origin + '/api/auth/email/password', {
        headers: { Origin: origin }, data: { email: 'delegate@example.test', password: 'test-password' },
      });
      assert.equal(response.status(), 200);
    }
    await page.goto(origin + '/join?m=' + id);
    if (!signedIn) {
      await page.getByRole('button', { name: 'Join as a guest' }).click();
      await page.getByLabel('Display name').fill(name);
    }
    await page.getByLabel('Passcode').fill('test passcode');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Join now' }).click();
    await page.getByText('The host will admit you from the waiting room.').waitFor();
    return page;
  }));
  await host.getByRole('button', { name: /^People / }).click();
  for (const [name] of sections) {
    await host.locator('.waiting-person').filter({ hasText: name }).getByRole('button', { name: 'Admit', exact: true }).click();
  }
  await host.getByRole('button', { name: 'People 4', exact: true }).waitFor();
  await host.getByRole('button', { name: 'Record', exact: true }).click();
  await host.getByText('Recording stopped because the participant list changed.').waitFor();
  await host.getByRole('button', { name: 'Save WebM' }).waitFor();
  await host.getByRole('button', { name: 'Discard', exact: true }).click();
  for (const page of otherGuests) assert.equal(await page.locator('.recording-banner').count(), 0);
  await guest.getByRole('button', { name: 'Camera', exact: true }).click();
  await guest.locator('button[aria-pressed="true"]').filter({ hasText: /^Camera$/ }).waitFor();
  await host.getByRole('button', { name: 'Breakouts', exact: true }).click();
  await host.getByLabel('Name for breakout room 1').fill('Design');
  await host.getByLabel('Name for breakout room 2').fill('Workshop');
  await host.getByRole('button', { name: 'Divide evenly' }).click();
  assert.notEqual(await host.getByLabel('Assign Test guest').inputValue(), '');
  await host.getByLabel('Assign Test guest').selectOption('0');
  for (const [name, room] of sections) await host.getByLabel('Assign ' + name).selectOption(room);
  await host.getByRole('button', { name: 'Open breakout rooms' }).click();
  for (const page of [guest, otherGuests[0]]) {
    await page.getByText('Breakout · Design', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'People 2', exact: true }).waitFor();
  }
  await otherGuests[1].getByText('Breakout · Workshop', { exact: true }).waitFor();
  await otherGuests[1].getByRole('button', { name: 'People 1', exact: true }).waitFor();
  assert.equal(await guest.getByRole('button', { name: 'Camera', exact: true }).getAttribute('aria-pressed'), 'false');
  await host.getByRole('button', { name: 'People 1', exact: true }).waitFor();
  for (const page of [guest, ...otherGuests]) await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await guest.getByRole('textbox', { name: 'Message', exact: true }).fill('Design breakout message');
  await guest.getByRole('button', { name: 'Send message', exact: true }).click();
  await otherGuests[0].getByText('Design breakout message', { exact: true }).waitFor();
  assert.equal(await otherGuests[1].getByText('Design breakout message', { exact: true }).count(), 0);
  await host.getByLabel('Announcement to rooms').fill('Wrap up your discussion.');
  await host.getByRole('button', { name: 'Send announcement' }).click();
  await host.getByText('Sent to 2 rooms.', { exact: true }).waitFor();
  for (const page of [guest, ...otherGuests]) await page.getByText('Host announcement · Wrap up your discussion.', { exact: true }).waitFor();
  await host.locator('.call-side').screenshot({ path: resolve(results, 'meetrix-breakout-rooms.png') });
  await host.getByRole('button', { name: 'Close all rooms', exact: true }).click();
  for (const page of [guest, ...otherGuests]) {
    await page.getByText('Returned to the main meeting. Your microphone and camera are off.', { exact: true }).waitFor();
  }
  await host.getByRole('button', { name: 'People 4', exact: true }).waitFor();

  const delegate = otherGuests[0];
  const roleStatus = delegate.getByText('You’re a co-host', { exact: true });
  await host.getByRole('button', { name: 'People 4', exact: true }).click();
  assert.equal(await host.getByRole('button', { name: 'Make co-host: Test guest', exact: true }).count(), 0);
  host.once('dialog', dialog => dialog.accept());
  await host.getByRole('button', { name: 'Make co-host: Design partner', exact: true }).click();
  await roleStatus.waitFor();
  await delegate.getByRole('button', { name: 'People 4', exact: true }).click();
  assert.equal(await delegate.getByRole('button', { name: 'Remove Alex Morgan' }).count(), 0);
  await delegate.getByRole('button', { name: 'Lock room', exact: true }).click();
  await delegate.getByRole('button', { name: 'Unlock room', exact: true }).click();
  await guest.getByRole('button', { name: 'Unmute', exact: true }).click();
  await guest.getByRole('button', { name: 'Mute', exact: true }).waitFor();
  await delegate.getByRole('button', { name: 'Mute attendees', exact: true }).click();
  await guest.getByRole('button', { name: 'Unmute', exact: true }).waitFor();
  await delegate.getByRole('button', { name: 'Ask Test guest to unmute', exact: true }).click();
  await guest.getByRole('button', { name: 'Turn on microphone', exact: true }).waitFor();
  assert.ok(await guest.getByRole('button', { name: 'Unmute', exact: true }).isVisible());
  assert.equal(await host.getByRole('button', { name: 'Turn on microphone', exact: true }).count(), 0);
  await guest.getByRole('button', { name: 'Turn on microphone', exact: true }).click();
  await guest.getByRole('button', { name: 'Mute', exact: true }).waitFor();
  await guest.getByRole('button', { name: 'Camera', exact: true }).click();
  await delegate.getByRole('button', { name: 'Stop camera for Test guest', exact: true }).click();
  await guest.locator('button[aria-pressed="false"]').filter({ hasText: /^Camera$/ }).waitFor();

  await delegate.getByRole('button', { name: 'Breakouts', exact: true }).click();
  assert.equal(await delegate.getByLabel('Assign Alex Morgan').count(), 0);
  await delegate.getByLabel('Name for breakout room 1').fill('Peer review');
  await delegate.getByLabel('Assign Test guest').selectOption('0');
  await delegate.getByRole('button', { name: 'Open breakout rooms' }).click();
  await guest.getByText('Breakout · Peer review', { exact: true }).waitFor();
  await delegate.getByRole('button', { name: 'Close all rooms' }).click();
  await guest.getByText('Returned to the main meeting. Your microphone and camera are off.', { exact: true }).waitFor();
  await host.getByRole('button', { name: 'Revoke co-host access for Design partner', exact: true }).click();
  await roleStatus.waitFor({ state: 'detached' });
  await delegate.getByRole('button', { name: 'Breakouts', exact: true }).waitFor({ state: 'detached' });
  assert.equal((await delegate.request.post(origin + '/api/meetings/' + id + '/moderate', {
    headers: { Origin: origin }, data: { action: 'lock', locked: true },
  })).status(), 403);

  host.once('dialog', dialog => dialog.accept());
  await host.getByRole('button', { name: 'Transfer host to Design partner', exact: true }).click();
  await delegate.getByText('You’re the host', { exact: true }).waitFor();
  await host.getByRole('button', { name: 'Record', exact: true }).waitFor({ state: 'detached' });
  assert.equal((await host.request.post(origin + '/api/meetings/' + id + '/moderate', {
    headers: { Origin: origin }, data: { action: 'end' },
  })).status(), 403);
  await delegate.getByRole('button', { name: 'Captions', exact: true }).click();
  await delegate.getByRole('textbox', { name: 'Caption text' }).fill('The meeting continues with a new host.');
  await delegate.getByRole('button', { name: 'Send caption' }).click();
  await guest.locator('.caption-overlay').getByText('The meeting continues with a new host.').waitFor();
  await host.getByRole('button', { name: 'Leave', exact: true }).click();
  await host.getByRole('button', { name: 'New meeting', exact: true }).waitFor();
  await delegate.getByText('You’re the host', { exact: true }).waitFor();
  await delegate.getByRole('button', { name: 'Leave', exact: true }).click();
  await delegate.getByRole('button', { name: 'End for everyone' }).click();
  await guest.getByText('You are disconnected from this room.').waitFor();
  console.log('Four-client meeting checks passed, including screen-share audio, host transfer, backgrounds, breakouts, captions, recording, and co-hosts.');
} finally {
  await browser?.close();
  backend?.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
}
