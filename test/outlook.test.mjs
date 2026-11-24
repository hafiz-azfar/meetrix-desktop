import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.mjs';
import { openDatabase } from '../server/db.mjs';
import { outlookSettings } from '../server/outlook-oauth.mjs';

test('Outlook separates grants, reconciles edits, and retries cancellation without blocking the organizer', async t => {
  const origin = 'https://meetrix.test';
  const config = outlookSettings({
    MEETRIX_OUTLOOK_CLIENT_ID: 'ed224338-5204-47ea-9a8b-70450dc83f56',
    MEETRIX_OUTLOOK_CLIENT_SECRET: 'test-secret',
    MEETRIX_OUTLOOK_KEY: randomBytes(32).toString('base64url'),
  }, new URL(origin));
  const db = openDatabase(':memory:');
  const grants = new Map();
  let event;
  let number = 0;
  const sent = [];
  let mailRefresh = 0;
  let deleteAttempts = 0;
  const { app, close, syncCalendars } = createApp({
    origin, insforgeUrl: 'https://auth.meetrix.test', outlook: config, databasePath: ':memory:',
  }, {
    db, authenticate: async token => token,
    outlookRequest: async (uri, options) => {
      const url = new URL(uri);
      assert.equal(options.redirect, 'error');
      if (url.hostname === 'login.microsoftonline.com') {
        assert.equal(url.pathname, '/common/oauth2/v2.0/token');
        assert.equal(options.body.get('client_secret'), 'test-secret');
        const grant = options.body.get('grant_type');
        const scope = options.body.get('scope');
        const kind = scope.includes('Mail.Send') ? 'mail' : 'calendar';
        if (grant === 'authorization_code') {
          assert.equal(options.body.get('code'), 'code-' + kind);
          assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'), grants.get(kind));
          return Response.json({ scope, access_token: 'access-' + kind, refresh_token: 'refresh-' + kind });
        }
        if (kind === 'mail') {
          const expected = mailRefresh ? 'refresh-mail-' + mailRefresh : 'refresh-mail';
          assert.equal(options.body.get('refresh_token'), expected);
          return Response.json({ scope, access_token: 'access-mail', refresh_token: 'refresh-mail-' + ++mailRefresh });
        }
        assert.equal(options.body.get('refresh_token'), 'refresh-calendar');
        return Response.json({ scope, access_token: 'access-calendar' });
      }
      assert.equal(url.hostname, 'graph.microsoft.com');
      if (url.pathname.includes('/events')) {
        assert.equal(options.headers.Authorization, 'Bearer access-calendar');
        assert.match(options.headers.Prefer, /timezone="UTC"/);
        if (options.method === 'GET') return event ? Response.json(event) : new Response(null, { status: 404 });
        if (options.method === 'DELETE') {
          assert.equal(options.headers['If-Match'], event['@odata.etag']);
          assert.equal(options.body, undefined);
          if (++deleteAttempts === 1) return new Response(null, { status: 503 });
          event = null;
          return new Response(null, { status: 204 });
        }
        const fields = JSON.parse(options.body);
        assert.equal(fields.attendees, undefined);
        if (options.method === 'POST') {
          assert.match(fields.transactionId, /^[a-f0-9]{64}$/);
          assert.match(fields.body.content, /\/join\?m=/);
        } else {
          assert.equal(options.method, 'PATCH');
          assert.equal(options.headers['If-Match'], event['@odata.etag']);
        }
        event = { ...event, ...fields, type: 'singleInstance', isOrganizer: true,
          id: 'outlook-event', '@odata.etag': 'W/"' + ++number + '"' };
        return Response.json(event);
      }
      assert.equal(options.headers.Authorization, 'Bearer access-mail');
      if (url.pathname.endsWith('/sendMail')) {
        sent.push(JSON.parse(options.body));
        return new Response(null, { status: 202 });
      }
      const message = { id: 'mail-id', subject: 'Notes', bodyPreview: 'Plain preview',
        body: { contentType: 'html', content: '<img src="https://example.test/tracker.png">' },
        from: { emailAddress: { name: 'Sender', address: 'sender@example.test' } }, toRecipients: [],
        receivedDateTime: '2026-11-24T08:00:00Z' };
      return url.pathname.includes('mailFolders') ? Response.json({ value: [message] }) : Response.json(message);
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); close(); });
  const root = 'http://127.0.0.1:' + server.address().port + '/api';
  async function api(path, method = 'GET', payload, owner = 'owner', cookie) {
    const response = await fetch(root + path, {
      method, redirect: 'manual', headers: { Origin: origin,
        ...(owner ? { Authorization: 'Bearer ' + owner } : {}), ...(cookie ? { Cookie: cookie } : {}),
        ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, headers: response.headers,
      json: response.headers.get('content-type')?.startsWith('application/json') ? await response.json() : null };
  }
  const base = '/workspace/outlook';
  async function connect(kind) {
    const started = await api(base + '/start', 'POST', { capability: kind });
    assert.equal(started.status, 200);
    const url = new URL(started.json.url);
    const scope = url.searchParams.get('scope');
    assert.equal(scope.includes('Calendars.ReadWrite'), kind === 'calendar');
    assert.equal(scope.includes('Mail.Send'), kind === 'mail');
    grants.set(kind, url.searchParams.get('code_challenge'));
    const cookie = started.headers.get('set-cookie').split(';')[0];
    const callback = '/outlook/callback?state=' + url.searchParams.get('state') + '&code=code-' + kind;
    assert.match((await api(callback, 'GET', null, null)).headers.get('location'), /failed$/);
    assert.match((await api(callback, 'GET', null, null, cookie)).headers.get('location'), /complete/);
    assert.equal((await api(base + '/complete', 'POST', {}, 'intruder', cookie)).status, 409);
    assert.equal((await api(base + '/complete', 'POST', {}, 'owner', cookie)).status, 200);
    assert.equal((await api(base + '/complete', 'POST', {}, 'owner', cookie)).status, 409);
  }

  await connect('calendar');
  assert.equal((await api(base + '/mail')).status, 409);
  const original = new Date(Date.now() + 86_400_000).toISOString();
  const meeting = (await api('/meetings', 'POST', { title: 'Roadmap', name: 'Owner', startAt: original, duration: 30 })).json;
  const path = '/meetings/' + meeting.id + '/outlook';
  assert.equal((await api(path, 'POST', { direction: 'push' }, 'intruder')).status, 404);
  assert.equal((await api(path, 'POST', { direction: 'push' })).status, 200);
  assert.equal((await api(path + '/automatic', 'POST', { enabled: true })).json.automatic.enabled, true);
  const due = db.prepare('UPDATE calendar_automation SET next_at = 0 WHERE meeting = ?');

  event.subject = 'Updated in Outlook';
  event['@odata.etag'] = 'W/"remote-change"';
  due.run(meeting.id);
  await syncCalendars();
  assert.equal((await api('/meetings')).json[0].title, 'Updated in Outlook');

  const reschedule = (title) => api('/meetings/' + meeting.id, 'PATCH', { title, startAt: original, duration: 30 });
  assert.equal((await reschedule('Updated in Meetrix')).status, 200);
  due.run(meeting.id);
  await syncCalendars();
  assert.equal(event.subject, 'Updated in Meetrix');

  event.subject = 'Conflicting Outlook update';
  event['@odata.etag'] = 'W/"conflict"';
  await reschedule('Conflicting Meetrix update');
  due.run(meeting.id);
  await syncCalendars();
  assert.equal(event.subject, 'Conflicting Outlook update');
  assert.equal((await api('/meetings')).json[0].title, 'Conflicting Meetrix update');
  assert.equal((await api(path)).json.automatic.status, 'conflict');
  assert.equal((await api(path, 'POST', { direction: 'push' })).status, 409);
  assert.equal((await api(path, 'POST', { direction: 'keep-local' })).status, 200);
  assert.equal(event.subject, 'Conflicting Meetrix update');
  assert.equal((await api(path)).json.automatic.status, 'synced');
  assert.equal((await api(path, 'POST', { direction: 'keep-local' })).status, 409);

  await connect('mail');
  assert.equal((await api(base + '/mail', 'GET', null, 'intruder')).status, 409);
  const inbox = await api(base + '/mail?folder=inbox');
  assert.equal(inbox.json[0].subject, 'Notes');
  assert.equal((await api(base + '/mail/mail-id')).json.text, 'Plain preview');
  const message = { to: ['person@example.test'], subject: 'Project update', text: 'Friday is confirmed.' };
  assert.equal((await api(base + '/mail', 'POST', message, 'intruder')).status, 409);
  assert.equal(sent.length, 0);
  assert.equal((await api(base + '/mail', 'POST', message)).status, 202);
  assert.equal(sent[0].message.body.contentType, 'Text');
  assert.equal(sent[0].message.toRecipients[0].emailAddress.address, 'person@example.test');
  assert.equal(sent[0].saveToSentItems, true);
  assert.ok(mailRefresh >= 3);
  assert.equal((await api(base, 'DELETE', { capability: 'mail' })).json.calendar, true);
  assert.equal((await api(base + '/mail')).status, 409);

  const cancelPath = '/meetings/' + meeting.id + '/cancel';
  const removeLinkedEvents = { removeLinkedEvents: true };
  assert.equal((await api(cancelPath, 'POST', removeLinkedEvents, 'intruder')).status, 403);
  assert.equal((await api(cancelPath, 'POST', removeLinkedEvents)).json.calendarRemovals, 1);
  assert.equal((await api(cancelPath, 'POST', removeLinkedEvents)).json.calendarRemovals, 1);
  assert.equal((await api('/meetings')).json[0].stoppedAt > 0, true);
  assert.equal((await api(path)).json.automatic.enabled, false);
  const status = async () => (await api('/meetings')).json[0].calendarRemovals;
  await syncCalendars();
  assert.equal(deleteAttempts, 1);
  assert.deepEqual(await status(), [{ provider: 'outlook', status: 'pending' }]);
  await syncCalendars();
  assert.equal(deleteAttempts, 1);
  db.prepare('UPDATE calendar_removals SET next_at = 0 WHERE meeting = ?').run(meeting.id);
  await syncCalendars();
  assert.equal(deleteAttempts, 2);
  assert.equal(event, null);
  assert.deepEqual(await status(), [{ provider: 'outlook', status: 'removed' }]);

  const detached = (await api('/meetings', 'POST', { title: 'Disconnected calendar', name: 'Owner', startAt: original, duration: 30 })).json;
  assert.equal((await api('/meetings/' + detached.id + '/outlook', 'POST', { direction: 'push' })).status, 200);
  assert.equal((await api('/meetings/' + detached.id + '/cancel', 'POST', removeLinkedEvents)).json.calendarRemovals, 1);
  assert.equal((await api(base, 'DELETE', { capability: 'calendar' })).json.calendar, false);
  await syncCalendars();
  assert.equal(deleteAttempts, 2);
  assert.deepEqual((await api('/meetings')).json.find(row => row.id === detached.id).calendarRemovals,
    [{ provider: 'outlook', status: 'attention' }]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM calendar_automation').get().n, 0);
});
