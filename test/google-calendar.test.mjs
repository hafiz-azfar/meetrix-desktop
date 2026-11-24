import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { calendarScope, googleCalendarSettings } from '../server/google-calendar-oauth.mjs';

test('Google Calendar binds OAuth, synchronizes edits, and removes only eligible canceled occurrences', async t => {
  const origin = 'https://meetrix.test';
  const options = googleCalendarSettings({
    MEETRIX_GOOGLE_CALENDAR_CLIENT_ID: 'test.apps.googleusercontent.com',
    MEETRIX_GOOGLE_CALENDAR_CLIENT_SECRET: 'fixture-secret',
    MEETRIX_GOOGLE_CALENDAR_KEY: randomBytes(32).toString('base64url'),
  }, new URL(origin));
  const db = openDatabase(':memory:');
  const events = new Map();
  let challenge;
  let number = 0;
  let exchanges = 0;
  const deletions = [];
  const { app, close, syncCalendars } = createApp({
    origin, insforgeUrl: 'https://auth.meetrix.test', databasePath: ':memory:', googleCalendar: options,
  }, {
    db, authenticate: async value => value,
    googleCalendarRequest: async (uri, request) => {
      assert.equal(request.redirect, 'error');
      const url = new URL(uri);
      if (url.hostname === 'oauth2.googleapis.com') {
        assert.equal(request.body.get('client_secret'), 'fixture-secret');
        if (request.body.get('grant_type') === 'authorization_code') {
          assert.equal(request.body.get('code'), 'fixture-code');
          assert.equal(createHash('sha256').update(request.body.get('code_verifier')).digest('base64url'), challenge);
          exchanges++;
          return Response.json({ refresh_token: 'fixture-refresh', scope: calendarScope });
        }
        assert.equal(request.body.get('refresh_token'), 'fixture-refresh');
        return Response.json({ access_token: 'fixture-access' });
      }
      assert.equal(url.hostname, 'www.googleapis.com');
      assert.equal(request.headers.Authorization, 'Bearer fixture-access');
      const id = url.pathname.split('/').at(-1);
      if (request.method === 'GET') return events.has(id) ? Response.json(events.get(id)) : new Response('', { status: 404 });
      assert.equal(url.searchParams.get('sendUpdates'), 'none');
      if (request.method === 'DELETE') {
        assert.equal(request.headers['If-Match'], events.get(id).etag);
        assert.equal(request.body, undefined);
        deletions.push(id);
        events.delete(id);
        return new Response(null, { status: 204 });
      }
      const value = JSON.parse(request.body);
      assert.equal(value.attendees, undefined);
      if (request.method === 'PATCH') {
        assert.equal(request.headers['If-Match'], events.get(id).etag);
        const updated = { ...events.get(id), ...value, etag: '"' + ++number + '"' };
        events.set(id, updated);
        return Response.json(updated);
      }
      assert.equal(request.method, 'POST');
      const created = { ...value, organizer: { self: true }, etag: '"' + ++number + '"' };
      events.set(created.id, created);
      return Response.json(created);
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); close(); });
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api';
  async function api(path, method = 'GET', body, owner = 'owner', cookie) {
    const response = await fetch(endpoint + path, {
      method, redirect: 'manual',
      headers: { Origin: origin, ...(owner ? { Authorization: 'Bearer ' + owner } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = response.headers.get('content-type')?.startsWith('application/json') ? await response.json() : null;
    return { status: response.status, data, headers: response.headers };
  }

  const account = '/workspace/google-calendar';
  const start = await api(account + '/start', 'POST', {});
  assert.equal(start.status, 200);
  for (const flag of [/; Secure\b/i, /; HttpOnly\b/i, /; SameSite=Lax\b/i]) {
    assert.match(start.headers.get('set-cookie'), flag);
  }
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const auth = new URL(start.data.url);
  assert.equal(auth.origin, 'https://accounts.google.com');
  assert.equal(auth.searchParams.get('scope'), calendarScope);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  challenge = auth.searchParams.get('code_challenge');
  const callback = '/google-calendar/callback?state=' + auth.searchParams.get('state') + '&code=fixture-code';
  assert.match((await api(callback, 'GET', null, null)).headers.get('location'), /failed$/);
  assert.match((await api(callback, 'GET', null, null, cookie)).headers.get('location'), /complete$/);
  assert.equal((await api(account + '/complete', 'POST', {}, 'other', cookie)).status, 409);
  assert.equal((await api(account + '/complete', 'POST', {}, 'owner', cookie)).status, 200);
  assert.equal((await api(account + '/complete', 'POST', {}, 'owner', cookie)).status, 409);
  assert.equal(exchanges, 1);
  const sealed = db.prepare('SELECT refresh_token FROM google_calendar_connections WHERE owner = ?').get('owner').refresh_token;
  assert.ok(sealed.length > 'fixture-refresh'.length);
  assert.doesNotMatch(sealed, /fixture-refresh/);
  const meeting = (await api('/meetings', 'POST', { title: 'Design review', name: 'Owner',
    startAt: new Date(Date.now() + 3_600_000).toISOString(), duration: 30,
    additionalStarts: [2, 3, 4].map(days => new Date(Date.now() + days * 86_400_000).toISOString()) })).data;
  const sync = '/meetings/' + meeting.id + '/google-calendar';
  assert.equal((await api(sync, 'POST', { direction: 'push' }, 'other')).status, 404);
  assert.equal((await api(sync, 'POST', { direction: 'push' })).status, 200);
  assert.equal(events.size, 1);
  const event = [...events.values()][0];
  assert.match(event.description, /\/join\?m=/);
  const moved = new Date(Date.now() + 86_400_000);
  const ending = new Date(moved.getTime() + 60 * 60_000);
  Object.assign(event, { etag: '"changed"', summary: 'Google review', start: { dateTime: moved.toISOString() },
    end: { dateTime: ending.toISOString() } });
  assert.equal((await api(sync, 'POST', { direction: 'push' })).status, 409);
  assert.equal((await api(sync, 'POST', { direction: 'pull' })).status, 200);
  const updated = (await api('/meetings')).data.find(row => row.id === meeting.id);
  assert.equal(updated.title, 'Google review');
  assert.equal(updated.duration, 60);
  assert.equal(updated.startAt, moved.getTime());
  assert.equal((await api(sync, 'POST', { direction: 'push' })).status, 200);
  assert.equal(events.size, 1);
  assert.equal((await api(sync + '/automatic', 'POST', { enabled: true })).data.automatic.enabled, true);
  const latest = events.get(event.id);
  latest.summary = 'Auto-imported Google title';
  latest.etag = '"automatic"';
  db.prepare('UPDATE calendar_automation SET next_at = 0 WHERE meeting = ?').run(meeting.id);
  await syncCalendars();
  assert.equal((await api('/meetings')).data.find(row => row.id === meeting.id).title, 'Auto-imported Google title');
  assert.equal((await api(sync)).data.automatic.status, 'synced');
  latest.summary = 'Conflicting Google title';
  latest.etag = '"conflict"';
  assert.equal((await api('/meetings/' + meeting.id, 'PATCH', {
    title: 'Keep Meetrix title', startAt: moved.toISOString(), duration: 60,
  })).status, 200);
  db.prepare('UPDATE calendar_automation SET next_at = 0 WHERE meeting = ?').run(meeting.id);
  await syncCalendars();
  assert.equal((await api(sync)).data.automatic.status, 'conflict');
  assert.equal((await api(sync, 'POST', { direction: 'keep-local' })).status, 200);
  assert.equal(events.get(event.id).summary, 'Keep Meetrix title');
  assert.equal((await api(sync)).data.automatic.status, 'synced');

  const [, second, third, fourth] = meeting.scheduledMeetings;
  for (const { id } of [second, third, fourth]) {
    assert.equal((await api('/meetings/' + id + '/google-calendar', 'POST', { direction: 'push' })).status, 200);
  }
  const remoteId = id => db.prepare('SELECT event FROM google_calendar_events WHERE meeting = ?').get(id).event;
  const secondEvent = remoteId(second.id);
  const thirdEvent = remoteId(third.id);
  events.get(thirdEvent).attendees = [{ email: 'guest@example.test' }];
  events.delete(remoteId(fourth.id));
  const series = '/meetings/' + second.id + '/series';
  const { revision } = (await api(series)).data;
  const cancel = { action: 'cancel', scope: 'following', revision, removeLinkedEvents: true };
  assert.equal((await api(series, 'PATCH', cancel, 'other')).status, 404);
  assert.equal((await api(series, 'PATCH', cancel)).data.calendarRemovals, 3);
  assert.equal((await api(series, 'PATCH', cancel)).status, 409);
  const state = async id => (await api('/meetings')).data.find(row => row.id === id).calendarRemovals;
  assert.deepEqual(await state(second.id), [{ provider: 'google', status: 'pending' }]);
  await syncCalendars();
  await syncCalendars();
  assert.deepEqual(deletions, [secondEvent]);
  assert.deepEqual(await state(second.id), [{ provider: 'google', status: 'removed' }]);
  assert.deepEqual(await state(third.id), [{ provider: 'google', status: 'attention' }]);
  assert.deepEqual(await state(fourth.id), [{ provider: 'google', status: 'removed' }]);
  assert.equal(events.has(event.id), true);
  assert.equal(events.has(thirdEvent), true);

  assert.equal((await api(account, 'DELETE', {})).data.connected, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM calendar_automation').get().n, 0);
  assert.equal((await api(sync, 'POST', { direction: 'push' })).status, 409);
});
