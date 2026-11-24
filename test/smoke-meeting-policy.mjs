import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startLocal } from '../desktop/local.cjs';

const output = resolve('test-results');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(resolve(output, 'meeting-policy-'));
let backend;
let browser;

try {
  backend = await startLocal({
    directory, runtime: resolve('vendor/runtime'), origin: 'http://127.0.0.1:0',
    instance: { insforgeUrl: 'https://auth.meetrix.test' },
    meetingPolicy: { requireSignIn: true, requireWaitingRoom: true, requirePasscode: true },
    dependencies: { createAuth: () => ({
      async getPublicAuthConfig() { return { data: { oAuthProviders: [] } }; },
      async signInWithPassword({ email }) {
        const organizer = email.startsWith('organizer');
        const id = organizer ? '4e5c7bb9-0218-4d57-b9c0-4ff45db24395' : 'd338dd36-66ed-4dba-8f37-ddc3af85a041';
        return { data: { accessToken: 'test-token', user: { id, email, emailVerified: true,
          profile: { name: organizer ? 'Organizer' : 'Attendee' } } } };
      },
    }) },
  });
  const { origin } = backend;
  browser = await chromium.launch({ ...(process.env.CI ? {} : { channel: 'chrome' }),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
  const organizer = await browser.newPage();
  const attendee = await browser.newPage();
  async function signIn(page, name) {
    const response = await page.request.post(origin + '/api/auth/email/password', {
      headers: { Origin: origin }, data: { email: name + '@example.test', password: 'test-password' },
    });
    assert.equal(response.status(), 200);
  }

  await signIn(organizer, 'organizer');
  await organizer.goto(origin);
  await organizer.getByRole('button', { name: 'Schedule meeting', exact: true }).click();
  const form = organizer.getByRole('dialog', { name: 'Schedule a meeting' });
  const lobby = form.getByRole('checkbox', { name: /^Waiting room/ });
  assert.equal(await lobby.isChecked(), true);
  assert.equal(await lobby.isDisabled(), true);
  assert.equal(await form.getByRole('checkbox', { name: /Allow guests without an account/ }).isDisabled(), true);
  const passcode = form.getByLabel('Passcode');
  assert.equal(await passcode.evaluate(input => input.required), true);
  const date = new Date(Date.now() + 3600_000);
  await form.getByLabel('Start time').fill(new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  await form.getByLabel('Meeting name').fill('Workspace policy smoke');
  await form.screenshot({ path: resolve(output, 'meetrix-workspace-meeting-policy.png') });
  await passcode.fill('meeting-policy-passcode');
  await form.getByRole('button', { name: 'Schedule', exact: true }).click();
  await form.waitFor({ state: 'detached' });
  const listing = await (await organizer.request.get(origin + '/api/meetings')).json();
  const meeting = listing.find(item => item.title === 'Workspace policy smoke');
  assert.ok(meeting.lobby && meeting.hasPasscode);

  await attendee.goto(origin + '/join?m=' + meeting.id);
  await attendee.getByText('This workspace requires participants to sign in.', { exact: true }).waitFor();
  assert.equal(await attendee.getByRole('button', { name: 'Join as a guest', exact: true }).count(), 0);
  await signIn(attendee, 'attendee');
  await organizer.getByRole('button', { name: 'Open', exact: true }).click();
  await organizer.getByRole('button', { name: 'Enter room', exact: true }).click();
  await organizer.getByText('Connected', { exact: true }).waitFor();
  await attendee.goto(origin + '/join?m=' + meeting.id);
  await attendee.getByLabel('Passcode (if required)', { exact: true }).fill('meeting-policy-passcode');
  await attendee.getByRole('button', { name: 'Continue', exact: true }).click();
  await attendee.getByRole('button', { name: 'Join now', exact: true }).click();
  await attendee.getByText('The host will admit you from the waiting room.').waitFor();
  await organizer.getByRole('button', { name: 'Admit', exact: true }).click();
  await attendee.getByText('Connected', { exact: true }).waitFor();

  const published = await organizer.request.post(origin + '/api/workspace/bookings', {
    headers: { Origin: origin }, data: { title: 'Policy booking', ownerName: 'Organizer', duration: 30,
      slots: [new Date(Date.now() + 7200_000).toISOString()] },
  });
  assert.equal(published.status(), 201);
  const page = await published.json();
  const booker = await browser.newPage();
  await booker.goto(origin + '/book?b=' + page.id);
  await booker.getByText('You’ll need to sign in to Meetrix to join.', { exact: true }).waitFor();
  await booker.getByLabel('Available time').selectOption({ index: 1 });
  await booker.getByLabel('Your name').fill('Booker');
  await booker.getByLabel('Meeting passcode').fill('booking-policy-passcode');
  await booker.getByRole('button', { name: 'Reserve time', exact: true }).click();
  await booker.getByText('Enter the passcode you chose when you join.', { exact: true }).waitFor();
  const link = await booker.getByRole('link', { name: 'Open meeting link', exact: true }).getAttribute('href');
  assert.equal(link.includes('booking-policy-passcode'), false);
  console.log('Workspace policy passed scheduling, live admission, and passcode-protected public booking.');
} finally {
  await browser?.close();
  backend?.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }).catch(() => {});
}
