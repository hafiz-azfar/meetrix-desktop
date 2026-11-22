import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { TokenVerifier } from 'livekit-server-sdk';
import { createApp } from '../server/app.mjs';
import { clerkHost } from '../server/auth.mjs';
import { readConfig } from '../server/config.mjs';

const origin = 'https://meetrix.test';
const clerkPublishableKey = 'pk_test_' + Buffer.from('clerk.meetrix.test$').toString('base64url');
const livekitKey = 'test-api-key';
const livekitSecret = 'not-a-real-secret-at-least-32-bytes';

async function fixture(t) {
  const calls = [];
  const rooms = {
    async createRoom(details) { calls.push(['open', details]); },
    async deleteRoom(id) { calls.push(['end', id]); },
    async removeParticipant(id, identity) { calls.push(['remove', id, identity]); },
  };
  const { app, close } = createApp({
    origin, clerkPublishableKey, livekitKey, livekitSecret,
    livekitUrl: 'wss://livekit.meetrix.test', databasePath: ':memory:',
  }, { rooms, authenticate: async token => {
    if (!['owner', 'guest', 'stranger'].includes(token)) throw Error('Bad session');
    return token;
  } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    close();
  });
  const root = 'http://127.0.0.1:' + server.address().port + '/api';
  async function api(path, { token = 'owner', method = 'GET', body, userOrigin = origin } = {}) {
    const response = await fetch(root + path, {
      method,
      headers: { Origin: userOrigin, ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, json: await response.json() };
  }
  const create = input => api('/meetings', { method: 'POST', body: { title: 'Roadmap', name: 'Owner', ...input } });
  const connect = (id, token, input = {}) => api('/meetings/' + id + '/connect', { method: 'POST', token, body: { name: token, ...input } });
  const moderate = (id, body, token = 'owner') => api('/meetings/' + id + '/moderate', { method: 'POST', body, token });
  return { api, create, connect, moderate, calls };
}

test('Clerk origin and LiveKit production configuration are pinned', () => {
  assert.equal(clerkHost(clerkPublishableKey), 'clerk.meetrix.test');
  assert.throws(() => readConfig({ APP_ORIGIN: 'http://meetrix.test' }), /HTTPS/);
  assert.throws(() => readConfig({ NODE_ENV: 'production' }), /Production requires/);
  assert.throws(() => readConfig({ APP_ORIGIN: 'http://localhost:4317', HOST: '0.0.0.0' }), /loopback/);
});

test('passcode, waiting room, authorization, narrow grants, lock, remove and end', async t => {
  const { api, create, connect, moderate, calls } = await fixture(t);
  assert.equal((await api('/meetings', { token: '' })).status, 401);
  assert.equal((await api('/meetings', { userOrigin: 'https://somewhere.test' })).status, 403);
  const meeting = (await create({ passcode: 'test passcode' })).json;
  assert.equal((await api('/meetings', { token: 'stranger' })).json.length, 0);
  assert.equal((await connect(meeting.id, 'guest', { passcode: 'incorrect' })).status, 403);
  const waiting = await connect(meeting.id, 'guest', { passcode: 'test passcode' });
  assert.equal(waiting.json.state, 'waiting');
  assert.equal(waiting.json.token, undefined);
  assert.deepEqual(calls, []);
  assert.equal((await moderate(meeting.id, { action: 'decide', identity: 'guest', admit: true }, 'guest')).status, 403);
  const host = await connect(meeting.id, 'owner');
  assert.equal(host.json.state, 'ready');
  assert.equal(calls[0][1].maxParticipants, 100);
  assert.equal((await moderate(meeting.id, { action: 'decide', identity: 'guest', admit: true })).status, 200);
  const grant = (await connect(meeting.id, 'guest')).json;
  const claims = await new TokenVerifier(livekitKey, livekitSecret).verify(grant.token);
  assert.equal(claims.sub, 'guest');
  assert.equal(claims.video.room, meeting.id);
  assert.ok(!claims.video.roomAdmin && !claims.video.roomCreate && !claims.video.roomRecord);
  assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 52);
  await moderate(meeting.id, { action: 'lock', locked: true });
  assert.equal((await connect(meeting.id, 'guest')).status, 423);
  assert.equal((await connect(meeting.id, 'owner')).status, 200);
  await moderate(meeting.id, { action: 'lock', locked: false });
  assert.equal((await moderate(meeting.id, { action: 'remove', identity: 'guest' })).status, 200);
  assert.equal((await connect(meeting.id, 'guest')).status, 403);
  assert.equal((await moderate(meeting.id, { action: 'end' })).status, 200);
  assert.equal((await moderate(meeting.id, { action: 'end' })).status, 200);
  assert.equal(calls.filter(([name]) => name === 'end').length, 1);
  assert.equal((await connect(meeting.id, 'owner')).status, 410);
});

test('weekly occurrences are created together and only the host can reschedule an unopened meeting', async t => {
  const { api, create, connect } = await fixture(t);
  const time = Date.now() + 3_600_000;
  const startAt = new Date(time).toISOString();
  const next = new Date(time + 7 * 86400000).toISOString();
  const duplicate = await create({ startAt, additionalStarts: [startAt] });
  assert.equal(duplicate.status, 400);
  assert.equal((await api('/meetings')).json.length, 0);
  const series = await create({ startAt, duration: 45, additionalStarts: [next] });
  assert.equal(series.status, 201);
  assert.equal(series.json.scheduledCount, 2);
  assert.equal((await api('/meetings')).json.length, 2);
  const path = '/meetings/' + series.json.id;
  const body = { title: 'Revised', startAt: next, duration: 90 };
  assert.equal((await api(path, { method: 'PATCH', token: 'stranger', body })).status, 403);
  assert.equal((await api(path, { method: 'PATCH', body })).json.duration, 90);
  await connect(series.json.id, 'owner');
  assert.equal((await api(path, { method: 'PATCH', body })).status, 409);
});

test('poll ballots and board strokes are scoped to admitted participants', async t => {
  const { api, create, connect } = await fixture(t);
  const meeting = (await create({ lobby: false })).json;
  await connect(meeting.id, 'owner');
  await connect(meeting.id, 'guest');
  const polls = '/meetings/' + meeting.id + '/poll';
  const input = { question: 'Which day?', choices: ['Tuesday', 'Thursday'] };
  assert.equal((await api(polls, { token: 'guest', method: 'POST', body: input })).status, 403);
  const poll = (await api(polls, { method: 'POST', body: input })).json;
  assert.deepEqual(poll.totals, [0, 0]);
  const vote = { poll: poll.id, choice: 1 };
  const first = await api(polls + '/vote', { token: 'guest', method: 'POST', body: vote });
  assert.equal(first.json.voted, 1);
  assert.equal(first.json.totals, null);
  assert.equal((await api(polls + '/vote', { token: 'guest', method: 'POST', body: vote })).status, 409);
  assert.equal((await api(polls + '/close', { method: 'POST', body: { poll: poll.id } })).status, 200);
  assert.deepEqual((await api(polls, { token: 'guest' })).json.totals, [0, 1]);
  const board = '/meetings/' + meeting.id + '/board';
  const stroke = { color: 'mint', points: [[0.1, 0.25], [0.5, 0.9]] };
  assert.equal((await api(board, { token: 'stranger' })).status, 403);
  assert.equal((await api(board, { token: 'guest', method: 'POST', body: stroke })).status, 201);
  assert.deepEqual((await api(board)).json, { version: 1, strokes: [stroke] });
  assert.equal((await api(board + '?since=1')).json, null);
  assert.equal((await api(board, { token: 'guest', method: 'DELETE', body: {} })).status, 403);
  assert.deepEqual((await api(board, { method: 'DELETE', body: {} })).json, { version: 2, strokes: [] });
});

test('shared notes require access and reject stale writes; encrypted rooms skip stored notes', async t => {
  const { api, create, connect } = await fixture(t);
  const meeting = (await create({})).json;
  const path = '/meetings/' + meeting.id + '/notes';
  assert.equal((await api(path, { token: 'stranger' })).status, 403);
  const initial = (await api(path)).json;
  assert.equal(initial.version, 0);
  const changes = await Promise.all(['first', 'second'].map(text => api(path, { method: 'PUT', body: { text, version: 0 } })));
  assert.deepEqual(changes.map(result => result.status).sort(), [200, 409]);
  const encrypted = (await create({ encrypted: true, lobby: false })).json;
  const hostPending = (await connect(encrypted.id, 'owner')).json;
  assert.equal(hostPending.state, 'key-required');
  assert.equal(hostPending.token, undefined);
  assert.equal((await connect(encrypted.id, 'owner', { keyReady: true })).json.state, 'ready');
  assert.equal((await connect(encrypted.id, 'guest')).json.state, 'key-required');
  assert.equal((await api('/meetings/' + encrypted.id + '/notes')).status, 403);
});
