import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ParticipantInfo_State, TokenVerifier, TrackSource } from 'livekit-server-sdk';
import { createApp } from '../server/app.mjs';
import { insforgeSettings } from '../server/auth.mjs';
import { readConfig } from '../server/config.mjs';

const origin = 'https://meetrix.test';
const insforgeUrl = 'https://auth.meetrix.test';
const livekitKey = 'test-api-key';
const livekitSecret = 'not-a-real-secret-at-least-32-bytes';

async function fixture(t) {
  const calls = [];
  const livePeople = new Map();
  const rooms = {
    async createRoom(details) { calls.push(['open', details]); },
    async deleteRoom(id) { calls.push(['end', id]); },
    async removeParticipant(id, identity) { calls.push(['remove', id, identity]); },
    async getParticipant(_id, identity) {
      if (!livePeople.has(identity)) throw Object.assign(new Error('Participant is absent'), { status: 404 });
      return livePeople.get(identity);
    },
    async listParticipants() { return [...livePeople.values()]; },
    async mutePublishedTrack(id, identity, sid) { calls.push(['mute', id, identity, sid]); },
    async sendData(room, _data, _kind, options) { calls.push(['data', room, options]); },
  };
  const { app, close } = createApp({
    origin, insforgeUrl, livekitKey, livekitSecret,
    livekitUrl: 'wss://livekit.meetrix.test', databasePath: ':memory:',
  }, { rooms, authenticate: async token => {
    if (!['owner', 'guest', 'stranger', 'attendee'].includes(token)) throw Error('Bad session');
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
  return { api, create, connect, moderate, calls, livePeople };
}

test('InsForge and LiveKit production configuration are pinned', () => {
  assert.equal(insforgeSettings(insforgeUrl).insforgeUrl, insforgeUrl);
  assert.throws(() => insforgeSettings('http://auth.meetrix.test'), /HTTPS/);
  assert.throws(() => insforgeSettings(insforgeUrl, 'admin-key'), /ANON_KEY/);
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

test('accountless guests need host opt-in, the passcode, and admission for each meeting', async t => {
  const { api, create, connect, moderate } = await fixture(t);
  const proof = 'cf32b52d0e134150b3ccf8c27bc23e46';
  const guestJoin = (id, body = {}, userOrigin) => api('/meetings/' + id + '/guest', {
    method: 'POST', token: '', body: { name: 'Accountless guest', proof, ...body }, userOrigin,
  });
  assert.equal((await create({ allowGuests: true, lobby: false })).status, 400);
  const accountsOnly = (await create({})).json;
  assert.equal((await guestJoin(accountsOnly.id)).status, 403);

  const meeting = (await create({ allowGuests: true, passcode: 'test passcode' })).json;
  assert.equal((await guestJoin(meeting.id, { passcode: 'wrong passcode' })).status, 403);
  assert.equal((await guestJoin(meeting.id, { passcode: 'test passcode' }, 'https://other.test')).status, 403);
  const waiting = await guestJoin(meeting.id, { passcode: 'test passcode' });
  assert.deepEqual(waiting.json, { state: 'waiting', hostPresent: false });
  const lobby = (await api('/meetings/' + meeting.id + '/lobby')).json;
  assert.equal(lobby.guests.length, 1);
  assert.equal(lobby.guests[0].accountless, true);
  const { identity } = lobby.guests[0];
  await connect(meeting.id, 'owner');
  assert.equal((await guestJoin(meeting.id)).json.state, 'waiting');
  assert.equal((await moderate(meeting.id, { action: 'decide', identity, admit: true })).status, 200);
  const admitted = (await guestJoin(meeting.id)).json;
  assert.equal(admitted.accountless, true);
  assert.equal(admitted.meeting.isHost, false);
  const claims = await new TokenVerifier(livekitKey, livekitSecret).verify(admitted.token);
  assert.equal(claims.sub, identity);
  assert.equal(claims.video.room, meeting.id);
  assert.ok(!claims.video.roomAdmin && !claims.video.roomCreate && !claims.video.roomRecord);
  assert.equal((await api('/meetings/' + meeting.id + '/notes', { token: '' })).status, 401);

  const other = (await create({ allowGuests: true })).json;
  assert.equal((await guestJoin(other.id)).json.state, 'waiting');
  const otherLobby = (await api('/meetings/' + other.id + '/lobby')).json;
  assert.notEqual(otherLobby.guests[0].identity, identity);
  assert.equal((await moderate(meeting.id, { action: 'remove', identity })).status, 200);
  assert.equal((await guestJoin(meeting.id)).status, 403);
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

test('breakout grants are limited to an admitted guest and one active room', async t => {
  const { api, create, connect, moderate, calls } = await fixture(t);
  const meeting = (await create({ lobby: false })).json;
  const other = (await create({ lobby: false })).json;
  const host = (await connect(meeting.id, 'owner')).json;
  assert.equal(host.routingKey, undefined);
  const guest = (await connect(meeting.id, 'guest')).json;
  const stranger = (await connect(meeting.id, 'stranger')).json;
  const path = '/meetings/' + meeting.id + '/breakouts';
  const open = (rooms, token = 'owner') => api(path, { token, method: 'POST', body: { action: 'open', rooms } });
  const place = (key, roomId, parent = meeting.id, userOrigin) => api('/meetings/' + parent + '/placement', {
    token: '', method: 'POST', body: { key, roomId }, userOrigin,
  });
  const plan = [{ name: 'Planning', members: ['guest'] }, { name: 'Review', members: ['stranger'] }];
  assert.equal((await api(path, { token: 'guest' })).status, 403);
  assert.equal((await open(plan, 'guest')).status, 403);
  assert.equal((await api(path, { token: 'guest', method: 'POST', body: { action: 'announce', text: 'Guest message' } })).status, 403);
  assert.equal((await open([...plan, { name: 'Observer', members: ['guest'] }])).status, 400);
  assert.equal((await open([{ name: 'Hosts', members: ['owner'] }])).status, 404);
  assert.deepEqual((await place(guest.routingKey, meeting.id)).json, { roomId: meeting.id, coHosts: [] });
  const retry = (await connect(meeting.id, 'guest')).json;
  assert.notEqual(retry.routingKey, guest.routingKey);
  assert.equal((await place(guest.routingKey, meeting.id)).status, 200);

  const outcomes = await Promise.all([open(plan), open(plan)]);
  assert.deepEqual(outcomes.map(result => result.status).sort(), [200, 409]);
  assert.equal((await place(guest.routingKey, meeting.id, other.id)).status, 403);
  assert.equal((await place(guest.routingKey, meeting.id, meeting.id, 'https://other.test')).status, 403);
  const moved = (await place(guest.routingKey, meeting.id)).json;
  const secondRoom = (await place(stranger.routingKey, meeting.id)).json;
  assert.equal(moved.breakoutName, 'Planning');
  assert.notEqual(moved.roomId, secondRoom.roomId);
  const verifier = new TokenVerifier(livekitKey, livekitSecret);
  const claims = await verifier.verify((await place(guest.routingKey, secondRoom.roomId)).json.token);
  assert.equal(claims.sub, 'guest');
  assert.equal(claims.video.room, moved.roomId);
  assert.ok(!claims.video.roomAdmin && !claims.video.roomCreate && !claims.video.roomRecord);
  assert.equal((await api('/meetings/' + meeting.id + '/notes', { token: 'guest' })).status, 403);

  assert.equal((await moderate(meeting.id, { action: 'remove', identity: 'stranger' })).status, 200);
  assert.ok(calls.some(call => call[0] === 'remove' && call[1] === secondRoom.roomId && call[2] === 'stranger'));
  assert.equal((await place(stranger.routingKey, secondRoom.roomId)).status, 403);
  const closed = await api(path, { method: 'POST', body: { action: 'close' } });
  assert.deepEqual(closed.json.rooms, []);
  assert.ok(calls.some(call => call[0] === 'end' && call[1] === moved.roomId));
  assert.equal((await verifier.verify((await place(guest.routingKey, moved.roomId)).json.token)).video.room, meeting.id);

  assert.equal((await open([plan[0]])).status, 200);
  const newRoom = (await place(guest.routingKey, meeting.id)).json.roomId;
  assert.notEqual(newRoom, moved.roomId);
  assert.equal((await moderate(meeting.id, { action: 'end' })).status, 200);
  assert.ok(calls.some(call => call[0] === 'end' && call[1] === newRoom));
  assert.equal((await place(guest.routingKey, newRoom)).status, 410);

  const encrypted = (await create({ encrypted: true })).json;
  await connect(encrypted.id, 'owner', { keyReady: true });
  const encryptedAttempt = await api('/meetings/' + encrypted.id + '/breakouts', {
    method: 'POST', body: { action: 'open', rooms: plan },
  });
  assert.equal(encryptedAttempt.status, 403);
});

test('co-hosts can moderate only while their assigned LiveKit session is connected', async t => {
  const { api, create, connect, moderate, calls, livePeople } = await fixture(t);
  const { id } = (await create({ allowGuests: true })).json;
  const path = '/meetings/' + id;
  const grant = (identity, sid, enabled = true, token = 'owner') => moderate(id, { action: 'co-host', identity, sid, enabled }, token);
  const lobby = token => api(path + '/lobby', { token });
  const admit = (identity, token = 'owner') => moderate(id, { action: 'decide', identity, admit: true }, token);
  const publish = (identity, sid, mic = false) => livePeople.set(identity, {
    identity, sid, state: ParticipantInfo_State.ACTIVE,
    tracks: mic ? [{ sid: 'TR_mic', source: TrackSource.MICROPHONE }, { sid: 'TR_cam', source: TrackSource.CAMERA },
      { sid: 'TR_share', source: TrackSource.SCREEN_SHARE_AUDIO }] : [],
  });
  await connect(id, 'owner');
  await connect(id, 'guest');
  await admit('guest');
  const guest = (await connect(id, 'guest')).json;
  assert.equal((await grant('guest', 'PA_guest')).status, 409);
  publish('guest', 'PA_guest', true);
  assert.equal((await grant('guest', 'PA_stale')).status, 409);
  assert.equal((await grant('guest', 'PA_guest', true, 'guest')).status, 403);
  assert.equal((await lobby('guest')).status, 403);
  assert.deepEqual((await grant('guest', 'PA_guest')).json.coHosts, [{ identity: 'guest', sid: 'PA_guest' }]);

  const other = (await create({ lobby: false })).json;
  assert.equal((await api('/meetings/' + other.id + '/lobby', { token: 'guest' })).status, 403);
  const placement = await api(path + '/placement', { token: '', method: 'POST', body: { key: guest.routingKey, roomId: id } });
  assert.deepEqual(placement.json.coHosts, [{ identity: 'guest', sid: 'PA_guest' }]);
  const claims = await new TokenVerifier(livekitKey, livekitSecret).verify((await connect(id, 'guest')).json.token);
  assert.equal(Boolean(claims.video.roomAdmin), false);
  assert.equal(claims.video.canUpdateOwnMetadata, false);

  const accountless = await api(path + '/guest', {
    token: '', method: 'POST', body: { proof: 'cf32b52d0e134150b3ccf8c27bc23e46', name: 'Guest via invite' },
  });
  assert.equal(accountless.status, 200);
  assert.equal(accountless.json.state, 'waiting');
  const pending = (await lobby('guest')).json.guests[0];
  assert.equal(pending.accountless, true);
  await admit(pending.identity, 'guest');
  publish(pending.identity, 'PA_accountless');
  assert.equal((await grant(pending.identity, 'PA_accountless')).status, 403);
  assert.equal((await moderate(id, { action: 'lock', locked: true }, 'guest')).status, 200);
  assert.equal((await moderate(id, { action: 'lock', locked: false }, 'guest')).status, 200);

  for (const identity of ['stranger', 'attendee']) {
    await connect(id, identity);
    await admit(identity, 'guest');
    publish(identity, 'PA_' + identity, true);
  }
  publish('owner', 'PA_owner', true);
  assert.equal((await grant('stranger', 'PA_stranger', true, 'guest')).status, 403);
  assert.equal((await grant('stranger', 'PA_stranger')).status, 200);
  for (const identity of ['owner', 'guest', 'stranger']) {
    assert.equal((await moderate(id, { action: 'remove', identity }, 'guest')).status, 403);
    assert.equal((await moderate(id, { action: 'mute', identity }, 'guest')).status, 403);
  }
  assert.equal((await moderate(id, { action: 'end' }, 'guest')).status, 403);
  assert.equal((await moderate(id, { action: 'mute-all' }, 'guest')).status, 200);
  assert.deepEqual(calls.filter(call => call[0] === 'mute'), [['mute', id, 'attendee', 'TR_mic']]);
  assert.equal((await moderate(id, { action: 'stop-video', identity: 'owner' }, 'guest')).status, 403);
  assert.equal((await moderate(id, { action: 'stop-video', identity: 'attendee' }, 'guest')).status, 200);
  assert.deepEqual(calls.at(-1), ['mute', id, 'attendee', 'TR_cam']);
  assert.equal((await moderate(id, { action: 'ask-unmute', identity: 'stranger' }, 'guest')).status, 403);
  assert.equal((await moderate(id, { action: 'ask-unmute', identity: 'attendee' }, 'guest')).status, 200);
  assert.deepEqual(calls.at(-1), ['data', id, { topic: 'meetrix.microphone-request', destinationIdentities: ['attendee'] }]);

  const breakout = members => api(path + '/breakouts', {
    token: 'guest', method: 'POST', body: { action: 'open', rooms: [{ name: 'Review', members }] },
  });
  assert.equal((await breakout(['stranger'])).status, 409);
  assert.equal((await breakout(['attendee'])).status, 200);
  assert.equal((await api(path + '/breakouts', { token: 'guest', method: 'POST', body: { action: 'close' } })).status, 200);
  publish('guest', 'PA_reconnected');
  assert.equal((await lobby('guest')).status, 403);
  assert.equal((await moderate(id, { action: 'lock', locked: true }, 'guest')).status, 403);
  assert.equal((await grant('guest', 'PA_reconnected')).status, 200);
  assert.equal((await grant('guest', 'PA_guest', false)).status, 200);
  assert.equal((await lobby('guest')).status, 200);
  assert.equal((await grant('guest', 'PA_reconnected', false)).status, 200);
  assert.equal((await lobby('guest')).status, 403);
  assert.equal((await moderate(id, { action: 'lock', locked: true }, 'guest')).status, 403);
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
