import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { once } from 'node:events';
import { ParticipantInfo_State, TokenVerifier, TrackSource } from 'livekit-server-sdk';
import { createApp } from '../server/app.mjs';
import { insforgeSettings } from '../server/auth.mjs';
import { readConfig } from '../server/config.mjs';
import { breakoutHelpTopic, breakoutVoiceTopic, readVoicePacket, voiceBytes } from '../server/breakout-voice-format.mjs';

const origin = 'https://meetrix.test';
const insforgeUrl = 'https://auth.meetrix.test';
const livekitKey = 'test-api-key';
const livekitSecret = 'not-a-real-secret-at-least-32-bytes';

async function fixture(t, authFixture) {
  const calls = [];
  const packets = [];
  const livePeople = new Map();
  const failedRemovals = new Set();
  const failedLookups = new Set();
  const rooms = {
    async createRoom(details) { calls.push(['open', details]); },
    async deleteRoom(id) { calls.push(['end', id]); },
    async removeParticipant(id, identity, options) {
      calls.push(['remove', id, identity, options]);
      if (failedRemovals.has(identity)) throw new Error('LiveKit is unavailable');
    },
    async getParticipant(id, identity) {
      if (failedLookups.has(identity)) throw new Error('LiveKit is unavailable');
      const participant = livePeople.get(identity);
      if (!participant || (participant.roomId && participant.roomId !== id)) {
        throw Object.assign(new Error('Participant is absent'), { status: 404 });
      }
      return participant;
    },
    async listParticipants() { return [...livePeople.values()]; },
    async mutePublishedTrack(id, identity, sid) { calls.push(['mute', id, identity, sid]); },
    async sendData(room, data, _kind, options) {
      calls.push(['data', room, options]);
      if (options?.topic === breakoutVoiceTopic) packets.push({ room, data });
    },
  };
  const { app, checkHostContinuity, close } = createApp({
    origin, insforgeUrl, livekitKey, livekitSecret,
    livekitUrl: 'wss://livekit.meetrix.test', databasePath: ':memory:',
  }, { rooms, createAuth: authFixture, authenticate: async token => {
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
  function request(path, { token = 'owner', cookie, method = 'GET', body, userOrigin = origin, contentType = 'application/json' } = {}) {
    return fetch(root + path, {
      method,
      headers: { Origin: userOrigin, ...(cookie ? { Cookie: cookie } : token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': contentType } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function api(path, options) {
    const response = await request(path, options);
    return { status: response.status, json: await response.json() };
  }
  api.request = request;
  api.text = async path => {
    const response = await fetch(root + path);
    return { status: response.status, type: response.headers.get('content-type'), body: await response.text() };
  };
  const create = input => api('/meetings', { method: 'POST', body: { title: 'Roadmap', name: 'Owner', ...input } });
  const connect = (id, token, input = {}) => api('/meetings/' + id + '/connect', { method: 'POST', token, body: { name: token, ...input } });
  const moderate = (id, body, token = 'owner') => api('/meetings/' + id + '/moderate', { method: 'POST', body, token });
  return { api, create, connect, moderate, calls, packets, livePeople, failedRemovals, failedLookups, checkHostContinuity };
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
  const dates = Array.from({ length: 52 }, (_, index) => new Date(time + (index + 1) * 86400000).toISOString());
  assert.equal((await create({ startAt, additionalStarts: dates })).status, 400);
  const longer = await create({ startAt, additionalStarts: dates.slice(0, 51) });
  assert.equal(longer.status, 201);
  assert.equal(longer.json.scheduledCount, 52);
  assert.equal(new Set(longer.json.scheduledMeetings.map(meeting => meeting.id)).size, 52);
  assert.equal((await api('/meetings')).json.length, 54);
});

test('series edits preserve invite IDs and use optimistic concurrency for unopened occurrences', async t => {
  const { api, create, connect } = await fixture(t);
  const start = Date.now() + 86400000;
  const date = index => new Date(start + index * 86400000).toISOString();
  const created = await create({ startAt: date(0), additionalStarts: [date(1), date(2), date(3)] });
  assert.equal(created.status, 201);
  const [first, second, third, fourth] = created.json.scheduledMeetings;
  assert.deepEqual(created.json.scheduledMeetings.map(item => item.seriesIndex), [0, 1, 2, 3]);
  const path = '/meetings/' + second.id + '/series';
  const load = async () => (await api(path)).json;
  const edit = body => api(path, { method: 'PATCH', body });
  assert.equal((await api(path, { token: 'guest' })).status, 404);
  const before = await load();
  assert.equal(before.meetings.length, 4);
  assert.equal((await connect(first.id, 'owner')).status, 200);
  assert.equal((await edit({ action: 'cancel', scope: 'upcoming', revision: before.revision })).status, 409);
  const current = await load();
  const updated = await edit({ action: 'reschedule', scope: 'following', revision: current.revision,
    title: 'Revised check-in', duration: 45, startTimes: [1, 2, 3].map(index => new Date(Date.parse(date(index)) + 3600000).toISOString()) });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json.meetings.map(item => [item.id, item.title, item.duration, item.sequence]),
    [second, third, fourth].map(item => [item.id, 'Revised check-in', 45, 1]));
  const snapshot = await load();
  assert.equal((await edit({ action: 'reschedule', scope: 'upcoming', revision: snapshot.revision,
    title: 'Colliding dates', duration: 30, startTimes: [date(2), date(2), date(3)] })).status, 400);
  assert.equal((await load()).revision, snapshot.revision);
  assert.equal((await edit({ action: 'cancel', scope: 'upcoming', revision: snapshot.revision })).json.updated, 3);
  for (const item of [second, third, fourth]) assert.equal((await connect(item.id, 'guest')).status, 410);
  const existing = (await api('/meetings')).json.find(item => item.id === first.id);
  assert.equal(existing.title, 'Roadmap');
  assert.equal(existing.stoppedAt, null);
  assert.equal(existing.sequence, 0);
});

test('scheduled breakout plans are private and load after starting a standard meeting', async t => {
  const { api, create, connect } = await fixture(t);
  const meeting = (await create({})).json;
  const uri = '/meetings/' + meeting.id;
  const plan = { names: ['Research', 'Design'], selfSelect: true, durationMinutes: 10 };
  const save = (value, token = 'owner') => api(uri + '/breakout-plan', { method: 'PATCH', token, body: { plan: value } });
  assert.equal((await api(uri + '/breakout-plan', { token: 'guest' })).status, 404);
  assert.equal((await save(plan, 'guest')).status, 404);
  assert.equal((await save({ ...plan, names: ['Design', ' design '] })).status, 400);
  assert.deepEqual((await save(plan)).json.plan, plan);
  assert.deepEqual((await api(uri + '/breakout-plan')).json.plan, plan);
  assert.equal((await save(null)).json.plan, null);
  await save(plan);
  assert.equal((await connect(meeting.id, 'owner')).status, 200);
  assert.equal((await save(null)).status, 409);
  assert.equal((await api(uri + '/breakouts', { token: 'guest' })).status, 403);
  assert.deepEqual((await api(uri + '/breakouts')).json.plan, plan);
  const opened = await api(uri + '/breakouts', { method: 'POST', body: {
    action: 'open', selfSelect: plan.selfSelect, durationSeconds: plan.durationMinutes * 60,
    rooms: plan.names.map(name => ({ name, members: [] })),
  } });
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.json.rooms.map(room => room.name), plan.names);
  assert.ok(opened.json.closesAt > Date.now());
  const encrypted = (await create({ encrypted: true })).json;
  assert.equal((await api('/meetings/' + encrypted.id + '/breakout-plan', { method: 'PATCH', body: { plan } })).status, 404);
});

test('scheduled breakout rosters match verified sign-ins only after normal admission', async t => {
  const addresses = {
    'present@example.test': { id: '4e5c7bb9-0218-4d57-b9c0-4ff45db24395', emailVerified: true },
    'later@example.test': { id: 'd338dd36-66ed-4dba-8f37-ddc3af85a041', emailVerified: true },
    'unverified@example.test': { id: '454f7cfb-ced7-47e0-a76b-005b149c2323', emailVerified: false },
  };
  const { api, create, connect, moderate, livePeople } = await fixture(t, () => ({
    async signInWithPassword({ email }) {
      return { data: { accessToken: 'fixture-token', user: { ...addresses[email], email } } };
    },
  }));
  async function signIn(email) {
    const reply = await api.request('/auth/email/password', { method: 'POST', body: { email, password: 'fixture-password' } });
    assert.equal(reply.status, 200);
    const cookie = reply.headers.get('set-cookie').split(';')[0];
    const session = (await api('/desktop-auth/session', { cookie })).json.user;
    return { cookie, identity: session.id };
  }
  const [present, later, unverified] = await Promise.all(Object.keys(addresses).map(signIn));
  const meeting = (await create({})).json;
  const uri = '/meetings/' + meeting.id;
  const plan = { names: ['Research', 'Design'], selfSelect: true, durationMinutes: null, assignments: [
    { email: 'Present@example.test', room: 0 }, { email: 'later@example.test', room: 1 }, { email: 'unverified@example.test', room: 1 },
  ] };
  const invalid = await api(uri + '/breakout-plan', { method: 'PATCH', body: { plan: {
    ...plan, assignments: [...plan.assignments, { email: 'PRESENT@example.test', room: 1 }],
  } } });
  assert.equal(invalid.status, 400);
  assert.equal((await api(uri + '/breakout-plan', { method: 'PATCH', body: { plan } })).status, 200);
  assert.equal((await connect(meeting.id, 'owner')).status, 200);
  const request = person => api(uri + '/connect', { cookie: person.cookie, method: 'POST', body: { name: 'Attendee' } });
  const admit = person => moderate(meeting.id, { action: 'decide', identity: person.identity, admit: true });
  assert.equal((await request(present)).json.state, 'waiting');
  await admit(present);
  const presentGrant = (await request(present)).json;
  assert.equal(presentGrant.roomId, meeting.id);
  livePeople.set(present.identity, { identity: present.identity, sid: 'PA_present', state: ParticipantInfo_State.ACTIVE, tracks: [] });
  assert.equal((await request(later)).json.state, 'waiting');
  const tools = (await api(uri + '/breakouts')).json;
  assert.equal(tools.preassignedCount, 3);
  assert.ok(!JSON.stringify(tools).includes('@example.test'));
  const opened = await api(uri + '/breakouts', { method: 'POST', body: { action: 'open-plan' } });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.rooms[0].members[0].identity, present.identity);
  assert.deepEqual(opened.json.rooms[1].members, []);
  assert.equal((await request(later)).json.state, 'waiting');
  await admit(later);
  const lateGrant = (await request(later)).json;
  assert.equal(lateGrant.roomId, opened.json.rooms[1].id);
  const claims = await new TokenVerifier(livekitKey, livekitSecret).verify(lateGrant.token);
  assert.equal(claims.video.room, opened.json.rooms[1].id);
  const move = await api(uri + '/placement', { method: 'POST', body: { key: presentGrant.routingKey, roomId: meeting.id } });
  assert.equal(move.json.roomId, opened.json.rooms[0].id);
  await request(unverified);
  await admit(unverified);
  assert.equal((await request(unverified)).json.roomId, meeting.id);
  const leave = await api(uri + '/placement', { method: 'POST', body: {
    key: lateGrant.routingKey, roomId: lateGrant.roomId, breakoutRoomId: null,
  } });
  assert.equal(leave.status, 200);
  assert.equal((await request(later)).json.roomId, meeting.id, 'a participant can keep their own room choice');
  await api(uri + '/breakouts', { method: 'POST', body: { action: 'close' } });
  assert.equal((await request(present)).json.roomId, meeting.id);
});

test('breakout voice is bound to the connected moderator and selected room', async t => {
  const { api, create, connect, moderate, livePeople, packets } = await fixture(t);
  const { id } = (await create({})).json;
  const url = '/meetings/' + id;
  const send = (body, token) => api(url + '/breakout-voice', { method: 'POST', token, body });
  const main = identity => ({ identity, sid: 'PA_' + identity, state: ParticipantInfo_State.ACTIVE, tracks: [] });
  await connect(id, 'owner');
  for (const identity of ['guest', 'attendee', 'stranger']) {
    await connect(id, identity);
    await moderate(id, { action: 'decide', identity, admit: true });
  }
  const open = await api(url + '/breakouts', { method: 'POST', body: {
    action: 'open', rooms: [{ name: 'Design', members: ['guest'] }, { name: 'Review', members: ['attendee'] }],
  } });
  assert.equal(open.status, 200);
  const [design, review] = open.json.rooms;
  assert.equal((await send({ action: 'start' })).status, 403);
  livePeople.set('owner', main('owner'));
  livePeople.set('stranger', main('stranger'));
  assert.equal((await send({ action: 'start' }, 'guest')).status, 403);
  const grant = await send({ action: 'start', roomId: design.id });
  assert.equal(grant.status, 200);
  const pcm = Buffer.alloc(voiceBytes, 0x4f).toString('base64');
  const audio = { action: 'audio', broadcast: grant.json.broadcast, index: 0, pcm };
  assert.equal((await send(audio, 'guest')).status, 409);
  assert.equal((await send({ ...audio, pcm: 'x'.repeat(pcm.length) })).status, 400);
  assert.equal((await send(audio)).status, 200);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].room, design.id);
  const packet = readVoicePacket(packets[0].data);
  assert.equal(packet.id, grant.json.broadcast);
  assert.equal(packet.index, 0);
  assert.equal(packet.samples.getInt16(0, true), 0x4f4f);
  assert.equal((await send(audio)).status, 409);
  assert.equal((await send({ action: 'start', roomId: review.id })).status, 409);
  await send({ action: 'stop', broadcast: grant.json.broadcast }, 'guest');
  assert.equal((await send({ ...audio, index: 1 })).status, 200);
  await send({ action: 'stop', broadcast: grant.json.broadcast });
  assert.equal((await moderate(id, { action: 'co-host', identity: 'stranger', sid: 'PA_stranger', enabled: true })).status, 200);
  const delegate = await send({ action: 'start' }, 'stranger');
  assert.equal(delegate.status, 200);
  assert.equal((await send({ ...audio, broadcast: delegate.json.broadcast }, 'stranger')).status, 200);
  assert.deepEqual(packets.slice(-2).map(item => item.room).sort(), [design.id, review.id].sort());
  await moderate(id, { action: 'co-host', identity: 'stranger', sid: 'PA_stranger', enabled: false });
  assert.equal((await send({ ...audio, broadcast: delegate.json.broadcast, index: 1 }, 'stranger')).status, 403);
  const active = await send({ action: 'start' });
  assert.equal(active.status, 200);
  await api(url + '/breakouts', { method: 'POST', body: { action: 'close' } });
  assert.equal((await send({ ...audio, broadcast: active.json.broadcast })).status, 409);
});

test('breakout help requests are scoped to the assigned room and resolved by moderators', async t => {
  const { api, create, connect, moderate, calls } = await fixture(t);
  const { id } = (await create({})).json;
  const url = '/meetings/' + id;
  await connect(id, 'owner');
  await connect(id, 'guest');
  await moderate(id, { action: 'decide', identity: 'guest', admit: true });
  const { routingKey } = (await connect(id, 'guest')).json;
  const ask = (key, userOrigin = origin) => api(url + '/breakout-help', { method: 'POST', token: '', body: { key }, userOrigin });
  assert.equal((await ask(routingKey)).status, 403);
  const result = await api(url + '/breakouts', { method: 'POST', body: {
    action: 'open', rooms: [{ name: 'Workshop', members: ['guest'] }],
  } });
  const [room] = result.json.rooms;
  assert.equal((await ask(routingKey, 'https://other.test')).status, 403);
  assert.equal((await ask('a'.repeat(43))).status, 403);
  assert.deepEqual((await ask(routingKey)).json, { requested: true });
  assert.deepEqual(calls.at(-1), ['data', id, { topic: breakoutHelpTopic, destinationIdentities: ['owner'] }]);
  assert.deepEqual((await ask(routingKey)).json, { requested: false });
  assert.ok((await api(url + '/breakouts')).json.rooms[0].helpRequestedAt);
  const resolve = token => api(url + '/breakouts', { method: 'POST', token, body: { action: 'resolve-help', roomId: room.id } });
  assert.equal((await resolve('guest')).status, 403);
  assert.equal((await resolve('owner')).json.rooms[0].helpRequestedAt, null);
  assert.deepEqual((await ask(routingKey)).json, { requested: true });
  await api(url + '/breakouts', { method: 'POST', body: { action: 'close' } });
  assert.equal((await ask(routingKey)).status, 403);
});

test('personal workspace keeps items private and rejects stale saves and deletes', async t => {
  const { api } = await fixture(t);
  const tasks = '/workspace/tasks';
  const payload = { title: 'Send a recap', body: 'Include next steps', dueDate: '2030-01-02', completed: false };
  assert.equal((await api(tasks, { token: '' })).status, 401);
  const created = await api(tasks, { method: 'POST', body: payload });
  assert.equal(created.status, 201);
  const path = tasks + '/' + created.json.id;
  assert.equal((await api(path, { token: 'guest' })).status, 404);
  assert.deepEqual((await api(tasks, { token: 'guest' })).json, []);
  assert.equal((await api(path, { method: 'PUT', token: 'guest', body: { ...payload, version: 1 } })).status, 404);
  const updated = await api(path, { method: 'PUT', body: { ...payload, completed: true, version: 1 } });
  assert.equal(updated.json.completed, true);
  assert.equal(updated.json.version, 2);
  assert.equal((await api(path, { method: 'PUT', body: { ...payload, version: 1 } })).status, 409);
  assert.equal((await api(path, { method: 'DELETE', body: { version: 1 } })).status, 409);
  assert.equal((await api(path, { method: 'DELETE', body: { version: 2 } })).status, 200);
  assert.equal((await api(path)).status, 404);
  const canvas = await api('/workspace/canvases', { method: 'POST', body: { title: 'Design notes', body: '<script>plain text</script>' } });
  assert.equal(canvas.status, 201);
  assert.equal((await api('/workspace/canvases/' + canvas.json.id)).json.body, '<script>plain text</script>');
  assert.equal((await api('/workspace/canvases/' + canvas.json.id, { token: 'guest' })).status, 404);
});

test('a booking slot can be reserved once, hides guest details, and creates a waiting room', async t => {
  const { api } = await fixture(t);
  const starts = [Date.now() + 45 * 60_000, Date.now() + 2 * 3_600_000].map(time => new Date(time).toISOString());
  const input = { title: 'Consultation', ownerName: 'Organizer', duration: 30, slots: starts };
  assert.equal((await api('/workspace/bookings', { method: 'POST', body: { ...input, slots: [starts[0], starts[0]] } })).status, 400);
  const published = await api('/workspace/bookings', { method: 'POST', body: input });
  assert.equal(published.status, 201);
  const privatePath = '/workspace/bookings/' + published.json.id;
  const publicPath = '/bookings/' + published.json.id;
  const publicView = await api(publicPath, { token: '' });
  assert.equal(publicView.status, 200);
  assert.equal(publicView.json.slots.length, 2);
  const [slot] = publicView.json.slots;
  assert.deepEqual(Object.keys(slot).sort(), ['id', 'startAt']);
  const reserve = (name, userOrigin) => api(publicPath, { token: '', method: 'POST', userOrigin, body: { slot: slot.id, name } });
  assert.equal((await reserve('Other site', 'https://other.test')).status, 403);
  const results = await Promise.all([reserve('First guest'), reserve('Second guest')]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const booked = results.find(result => result.status === 201).json;
  assert.equal(booked.startAt, slot.startAt);
  const [saved] = (await api('/meetings')).json;
  assert.equal(saved.id, booked.id);
  const joining = await api('/meetings/' + booked.id + '/guest', { token: '', method: 'POST',
    body: { name: 'Booked visitor', proof: 'a'.repeat(32) } });
  assert.equal(joining.status, 200);
  assert.equal(joining.json.state, 'waiting');
  assert.equal(saved.lobby, true);
  assert.equal((await api(publicPath, { token: '' })).json.slots.length, 1);
  assert.equal((await api(privatePath, { token: 'guest', method: 'DELETE', body: {} })).status, 404);
  assert.equal((await api(privatePath, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await api(publicPath, { token: '' })).status, 404);
  assert.equal((await api('/meetings')).json[0].id, booked.id);
});

test('a calendar subscription is owner-scoped, updates, rotates and revokes', async t => {
  const { api, create } = await fixture(t);
  const { id } = (await create({ title: 'Calendar sync check', startAt: new Date(Date.now() + 3600000).toISOString() })).json;
  await create({ title: 'Other owner event' });
  const path = '/workspace/calendar-feed';
  assert.deepEqual((await api(path)).json, { available: true, active: false });
  assert.equal((await api(path, { method: 'POST', token: '', body: {} })).status, 401);
  const created = (await api(path, { method: 'POST', body: {} })).json;
  const feedPath = new URL(created.url).pathname.slice(4);
  const raw = await api.text(feedPath);
  assert.equal(raw.status, 200);
  assert.match(raw.type, /^text\/calendar/);
  assert.match(raw.body, /SUMMARY:Calendar sync check/);
  const guest = (await api(path, { token: 'guest', method: 'POST', body: {} })).json;
  assert.doesNotMatch((await api.text(new URL(guest.url).pathname.slice(4))).body, /Calendar sync check/);
  await api('/meetings/' + id, { method: 'PATCH', body: {
    title: 'Updated meeting', startAt: new Date(Date.now() + 7200000).toISOString(), duration: 45,
  } });
  assert.match((await api.text(feedPath)).body, /SUMMARY:Updated meeting/);
  const rotated = (await api(path, { method: 'POST', body: {} })).json;
  assert.equal((await api.text(feedPath)).status, 404);
  const nextPath = new URL(rotated.url).pathname.slice(4);
  assert.equal((await api.text(nextPath)).status, 200);
  assert.equal((await api(path, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await api.text(nextPath)).status, 404);
});

test('team channel content is membership-scoped and removing a member rotates access', async t => {
  const { api } = await fixture(t);
  const base = '/workspace/channels';
  const room = (await api(base, { method: 'POST', body: { title: 'Team launch', name: 'Organizer' } })).json;
  assert.ok(room.id, JSON.stringify(room));
  const path = base + '/' + room.id;
  const sent = await api(path + '/messages', { method: 'POST', body: { text: 'Ship after review.' } });
  assert.equal(sent.status, 201);
  assert.equal((await api(path + '/messages', { token: 'guest' })).status, 404);
  assert.equal((await api(path + '/messages', { token: 'guest', method: 'POST', body: { text: 'Hello' } })).status, 404);
  const key = (await api(path + '/invite', { method: 'POST', body: {} })).json.code;
  const join = token => api(base + '/join', { method: 'POST', token, body: { name: 'Guest', code: key } });
  assert.equal((await join('guest')).status, 200);
  assert.equal((await api(path + '/invite', { token: 'guest', method: 'POST', body: {} })).status, 404);
  assert.equal((await api(path + '/messages', { token: 'guest' })).json.messages[0].text, 'Ship after review.');
  const listing = await api(path + '/messages');
  assert.equal(listing.json.members.length, 1);
  assert.equal((await api(path + '/members/' + listing.json.members[0].id, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await api(path + '/messages', { token: 'guest' })).status, 404);
  assert.equal((await join('stranger')).status, 404);
  assert.equal((await api(path, { method: 'DELETE', body: {} })).status, 200);
  assert.deepEqual((await api(base)).json, []);
});

test('team attachments and replies stay within their channel and current membership', async t => {
  const { api } = await fixture(t);
  const base = '/workspace/channels';
  const create = (title, token = 'owner') => api(base, { method: 'POST', token, body: { title, name: token } });
  const channel = base + '/' + (await create('Team files')).json.id;
  const other = base + '/' + (await create('Other files')).json.id;
  const parent = (await api(channel + '/messages', { method: 'POST', body: { text: 'Review the report' } })).json.id;
  const reply = (route, replyTo, token = 'owner') => api(route + '/messages', {
    method: 'POST', token, body: { text: 'Reviewed', replyTo },
  });
  const upload = (body, token = 'owner', userOrigin = origin) => api(channel + '/attachments', {
    method: 'POST', token, userOrigin, body, contentType: 'application/vnd.meetrix.attachment+json',
  });
  const file = 'Launch notes\nReady for review.\n';
  const attachment = { text: 'Draft for discussion', name: 'Launch notes.txt', data: Buffer.from(file).toString('base64'), replyTo: parent };
  assert.equal((await upload(attachment, 'guest')).status, 404);
  assert.equal((await upload(attachment, 'owner', 'https://other.test')).status, 403);
  assert.equal((await upload({ ...attachment, name: 'notes.exe' })).status, 400);
  assert.equal((await upload({ ...attachment, name: 'notes.pdf' })).status, 400);
  assert.equal((await upload({ ...attachment, name: '../notes.txt' })).status, 400);
  assert.equal((await upload({ ...attachment, data: Buffer.alloc(1024 * 1024 + 40000, 'a').toString('base64') })).status, 413);
  assert.equal((await reply(other, parent)).status, 404);
  const key = (await api(channel + '/invite', { method: 'POST', body: {} })).json.code;
  assert.equal((await api(base + '/join', { method: 'POST', token: 'guest', body: { name: 'Guest', code: key } })).status, 200);
  const sent = await upload(attachment, 'guest');
  assert.equal(sent.status, 201);
  const filePath = channel + '/attachments/' + sent.json.id;
  const threadPath = channel + '/messages/' + parent + '/replies';
  assert.equal((await reply(channel, sent.json.id)).status, 404);
  const { messages, members } = (await api(channel + '/messages')).json;
  assert.deepEqual(messages.map(message => [message.id, message.replyCount]), [[parent, 1]]);
  const thread = (await api(threadPath, { token: 'guest' })).json;
  assert.equal(thread.replies[0].attachmentName, attachment.name);
  assert.equal(thread.replies[0].data, undefined);
  const fetched = await api.request(filePath, { token: 'guest' });
  assert.equal(await fetched.text(), file);
  assert.match(fetched.headers.get('content-disposition'), /^attachment;/);
  assert.equal(fetched.headers.get('content-type'), 'application/octet-stream');
  assert.equal(fetched.headers.get('cache-control'), 'no-store');
  assert.equal(fetched.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await api(other + '/attachments/' + sent.json.id)).status, 404);
  assert.equal((await api(filePath, { token: 'stranger' })).status, 404);
  const ownerFile = await upload({ ...attachment, replyTo: undefined, text: '' });
  const ownerFilePath = channel + '/attachments/' + ownerFile.json.id;
  const remove = (path, token) => api(path, { method: 'DELETE', body: {}, token });
  assert.equal((await remove(ownerFilePath, 'guest')).status, 404);
  assert.equal((await remove(ownerFilePath, 'owner')).status, 200);
  assert.equal((await api(ownerFilePath)).status, 404);
  assert.equal((await api(channel + '/members/' + members[0].id, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await api(threadPath, { token: 'guest' })).status, 404);
  assert.equal((await api(filePath, { token: 'guest' })).status, 404);
  assert.equal((await api(channel, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await api(filePath)).status, 404);
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
  assert.match(host.routingKey, /^[A-Za-z0-9_-]{43}$/);
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
  assert.deepEqual((await place(guest.routingKey, meeting.id)).json,
    { roomId: meeting.id, hostIdentity: 'owner', hostVersion: 0, coHosts: [], placementEpoch: 0 });
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

test('the waiting room blocks media grants and collaboration until an attendee is readmitted', async t => {
  const { api, create, connect, moderate, calls, failedRemovals, livePeople } = await fixture(t);
  const { id } = (await create({ lobby: false })).json;
  const path = '/meetings/' + id;
  const wait = (identity, token) => moderate(id, { action: 'wait', identity }, token);
  const admit = identity => moderate(id, { action: 'decide', identity, admit: true });
  const place = (key, roomId, placementEpoch) => api(path + '/placement', {
    token: '', method: 'POST', body: { key, roomId, placementEpoch },
  });
  await connect(id, 'owner');
  const guest = (await connect(id, 'guest')).json;
  await connect(id, 'stranger');
  await connect(id, 'attendee');
  for (const identity of ['stranger', 'attendee']) {
    const sid = 'PA_' + identity;
    livePeople.set(identity, { identity, sid, state: ParticipantInfo_State.ACTIVE, tracks: [] });
    assert.equal((await moderate(id, { action: 'co-host', identity, sid, enabled: true })).status, 200);
  }

  assert.equal((await wait('stranger', 'guest')).status, 403);
  assert.equal((await wait('owner', 'stranger')).status, 403);
  assert.equal((await wait('attendee', 'stranger')).status, 403);
  assert.equal((await api(path + '/breakouts', { method: 'POST', body: {
    action: 'open', rooms: [{ name: 'Planning', members: ['guest'] }],
  } })).status, 200);
  const inBreakout = (await place(guest.routingKey, id, guest.placementEpoch)).json;

  failedRemovals.add('guest');
  assert.equal((await wait('guest', 'stranger')).status, 502);
  assert.equal((await admit('guest')).status, 409);
  assert.equal((await api(path + '/lobby')).json.guests[0].evicting, true);
  assert.deepEqual((await place(guest.routingKey, inBreakout.roomId, guest.placementEpoch)).json, {
    waiting: true, placementEpoch: 1,
  });
  assert.equal((await connect(id, 'guest')).json.token, undefined);
  assert.equal((await api(path + '/notes', { token: 'guest' })).status, 403);

  failedRemovals.delete('guest');
  assert.equal((await wait('guest', 'stranger')).status, 200);
  assert.equal((await api(path + '/lobby')).json.guests[0].evicting, false);
  assert.ok(calls.some(([event, room, identity, options]) =>
    event === 'remove' && room === inBreakout.roomId && identity === 'guest' && typeof options?.revokeTokenTs === 'bigint'));
  assert.equal((await admit('guest')).status, 200);
  const readmitted = (await place(guest.routingKey, inBreakout.roomId, guest.placementEpoch)).json;
  assert.equal(readmitted.roomId, id);
  assert.equal(readmitted.placementEpoch, 1);
  const claims = await new TokenVerifier(livekitKey, livekitSecret).verify(readmitted.token);
  assert.equal(claims.video.room, id);
  assert.equal(claims.sub, 'guest');
  assert.equal((await api(path + '/breakouts')).json.rooms[0].members.length, 0);
  assert.equal((await place(guest.routingKey, id, guest.placementEpoch)).status, 200);
  assert.ok((await place(guest.routingKey, id, guest.placementEpoch)).json.token);
  assert.equal((await place(guest.routingKey, id, 1)).json.token, undefined);
  assert.equal((await api(path + '/notes', { token: 'guest' })).status, 200);

  assert.equal((await wait('guest', 'stranger')).status, 200);
  assert.equal((await moderate(id, { action: 'decide', identity: 'guest', admit: false })).status, 200);
  assert.equal((await place(guest.routingKey, id, 1)).status, 403);
});

test('breakout deadlines close rooms without a moderator client and preserve access controls', async t => {
  const { api, create, connect, moderate, calls } = await fixture(t);
  const { id } = (await create({ lobby: true })).json;
  await connect(id, 'owner');
  await connect(id, 'guest');
  assert.equal((await moderate(id, { action: 'decide', identity: 'guest', admit: true })).status, 200);
  const guest = (await connect(id, 'guest')).json;
  const path = '/meetings/' + id;
  const rooms = [{ name: 'Timed room', members: ['guest'] }];
  const manage = (body, token = 'owner') => api(path + '/breakouts', { method: 'POST', body, token });
  const placement = roomId => api(path + '/placement', {
    method: 'POST', token: '', body: { key: guest.routingKey, roomId },
  });
  assert.equal((await manage({ action: 'open', rooms, durationSeconds: 29 })).status, 400);
  const opened = await manage({ action: 'open', rooms, durationSeconds: 120 });
  assert.equal(opened.status, 200);
  const timed = opened.json.rooms[0].id;
  assert.ok(opened.json.closesAt > Date.now() + 110_000);
  const moved = (await placement(id)).json;
  assert.equal(moved.roomId, timed);
  assert.equal(moved.breakoutClosesAt, opened.json.closesAt);
  assert.equal((await manage({ action: 'close', delaySeconds: 1 }, 'guest')).status, 403);
  const countdown = await manage({ action: 'close', delaySeconds: 1 });
  assert.equal(countdown.status, 200);
  assert.ok(countdown.json.closesAt < opened.json.closesAt);
  assert.equal((await manage({ action: 'close', delaySeconds: 60 })).json.closesAt, countdown.json.closesAt);
  const stopWaiting = Date.now() + 5000;
  while (!calls.some(([event, room]) => event === 'end' && room === timed)) {
    assert.ok(Date.now() < stopWaiting, 'LiveKit cleanup was not run automatically');
    await sleep(100);
  }
  const returned = (await placement(timed)).json;
  assert.equal(returned.roomId, id);
  assert.ok(returned.token);
  assert.equal(returned.breakoutClosesAt, undefined);
  const cleared = (await api(path + '/breakouts')).json;
  assert.equal(cleared.closesAt, null);
  assert.deepEqual(cleared.rooms, []);
  const reopened = await manage({ action: 'open', rooms });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.closesAt, null);
});

test('admitted attendees may choose only active breakout rooms when the moderator allows it', async t => {
  const { api, create, connect, moderate, calls, livePeople, failedRemovals } = await fixture(t);
  const { id } = (await create({ lobby: true, allowGuests: true })).json;
  const { id: anotherMeeting } = (await create({ lobby: false })).json;
  const path = '/meetings/' + id;
  const host = (await connect(id, 'owner')).json;
  const invitee = {
    method: 'POST', token: '', body: { name: 'Guest attendee', proof: 'ea27219f5fdd461080725f537ffead91' },
  };
  assert.equal((await api(path + '/guest', invitee)).json.state, 'waiting');
  const { identity } = (await api(path + '/lobby')).json.guests[0];
  const moderator = body => api(path + '/breakouts', { method: 'POST', body });
  const placement = (key, roomId = id, breakoutRoomId) => api(path + '/placement', {
    method: 'POST', token: '', body: { key, roomId, ...(breakoutRoomId === undefined ? {} : { breakoutRoomId }) },
  });
  assert.equal((await moderate(id, { action: 'decide', identity, admit: true })).status, 200);
  const guest = (await api(path + '/guest', invitee)).json;
  const key = guest.routingKey;
  const rooms = [{ name: 'Design', members: [] }, { name: 'Planning', members: [] }];
  assert.equal((await placement(key, id, null)).status, 403);
  assert.equal((await moderator({ action: 'open', rooms })).status, 400);
  const opened = await moderator({ action: 'open', rooms, selfSelect: true });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.selfSelect, true);
  const [design, planning] = opened.json.rooms;
  assert.deepEqual((await placement(key)).json.breakoutChoices, [
    { id: design.id, name: 'Design' }, { id: planning.id, name: 'Planning' },
  ]);
  assert.equal((await placement(host.routingKey, id, design.id)).status, 403);

  await connect(id, 'stranger');
  await moderate(id, { action: 'decide', identity: 'stranger', admit: true });
  const coHostKey = (await connect(id, 'stranger')).json.routingKey;
  livePeople.set('stranger', { sid: 'PA_cohost', state: ParticipantInfo_State.ACTIVE, tracks: [] });
  await moderate(id, { action: 'co-host', identity: 'stranger', sid: 'PA_cohost', enabled: true });
  assert.equal((await placement(coHostKey)).json.breakoutChoices, undefined);
  assert.equal((await placement(coHostKey, id, design.id)).status, 403);
  await connect(anotherMeeting, 'owner');
  const foreign = await api('/meetings/' + anotherMeeting + '/breakouts', {
    method: 'POST', body: { action: 'open', rooms: [rooms[0]], selfSelect: true },
  });
  assert.equal((await placement(key, id, foreign.json.rooms[0].id)).status, 404);

  failedRemovals.add(identity);
  assert.equal((await placement(key, id, design.id)).status, 502);
  assert.equal((await placement(key)).json.roomId, id);
  failedRemovals.delete(identity);
  assert.equal((await placement(key, id, design.id)).status, 200);
  const verifier = new TokenVerifier(livekitKey, livekitSecret);
  const designGrant = (await placement(key)).json;
  assert.equal((await verifier.verify(designGrant.token)).video.room, design.id);
  assert.equal(designGrant.breakoutName, 'Design');
  assert.ok(calls.some(([action, room, subject, options]) =>
    action === 'remove' && room === id && subject === identity && typeof options?.revokeTokenTs === 'bigint'));
  assert.equal((await placement(key, id, planning.id)).status, 409);
  assert.equal((await placement(key, design.id, planning.id)).status, 200);
  const planningGrant = (await placement(key, design.id)).json;
  assert.equal((await verifier.verify(planningGrant.token)).video.room, planning.id);
  assert.equal(planningGrant.breakoutName, 'Planning');
  assert.equal((await placement(key, planning.id, null)).status, 200);
  assert.equal((await verifier.verify((await placement(key, planning.id)).json.token)).video.room, id);

  assert.equal((await moderate(id, { action: 'wait', identity })).status, 200);
  assert.equal((await placement(key, id, design.id)).status, 403);
  assert.equal((await placement(key)).json.waiting, true);
  assert.equal((await moderate(id, { action: 'decide', identity, admit: true })).status, 200);
  assert.equal((await moderate(id, { action: 'remove', identity })).status, 200);
  assert.equal((await placement(key, id, design.id)).status, 403);
  const closed = await moderator({ action: 'close' });
  assert.equal(closed.status, 200);
  assert.equal(closed.json.selfSelect, false);
  assert.equal((await placement(coHostKey)).json.breakoutChoices, undefined);
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

test('moderator visits require matching credentials and bind co-host access to the new room connection', async t => {
  const { api, create, connect, moderate, calls, livePeople, failedRemovals } = await fixture(t);
  const { id } = (await create({ lobby: false })).json;
  const path = '/meetings/' + id;
  const post = (endpoint, body, token) => api(path + endpoint, { method: 'POST', body, token });
  const publish = (identity, sid, metadata, tracks = []) =>
    livePeople.set(identity, { identity, sid, metadata, tracks, state: ParticipantInfo_State.ACTIVE });
  const placement = (session, roomId = id) => ({ key: session.routingKey, roomId, placementEpoch: session.placementEpoch });
  const move = (session, destination, token, roomId = id) =>
    post('/moderator-location', { ...placement(session, roomId), destination }, token);
  const grant = (sid, enabled = true) => moderate(id, { action: 'co-host', identity: 'guest', sid, enabled });
  const verifier = new TokenVerifier(livekitKey, livekitSecret);
  const lobby = () => api(path + '/lobby', { token: 'guest' });
  const owner = (await connect(id, 'owner')).json;
  const delegate = (await connect(id, 'guest')).json;
  const attendee = (await connect(id, 'attendee')).json;
  await connect(id, 'stranger');
  publish('owner', 'PA_owner');
  publish('guest', 'PA_main');
  publish('attendee', 'PA_attendee', '', [{ sid: 'TR_attendee', source: TrackSource.MICROPHONE }]);
  assert.equal((await grant('PA_main')).status, 200);
  const opened = await post('/breakouts', { action: 'open', rooms: [{ name: 'Review', members: ['attendee'] }] }, 'owner');
  const roomId = opened.json.rooms[0].id;
  assert.equal((await move(attendee, roomId, 'attendee', roomId)).status, 403);
  assert.equal((await move(delegate, roomId, 'owner')).status, 403);
  assert.equal((await move(delegate, roomId, '')).status, 401);
  assert.equal((await move(delegate, 'breakout_aaaaaaaaaaaaaaaa', 'guest')).status, 404);
  failedRemovals.add('guest');
  assert.equal((await move(delegate, roomId, 'guest')).status, 502);
  assert.equal((await post('/placement', placement(delegate), 'guest')).json.roomId, id);
  failedRemovals.delete('guest');

  assert.equal((await move(delegate, roomId, 'guest')).status, 200);
  assert.equal((await move(delegate, roomId, 'guest')).status, 409);
  const removed = calls.find(call => call[0] === 'remove' && call[1] === id && call[2] === 'guest');
  assert.equal(typeof removed[3].revokeTokenTs, 'bigint');
  assert.equal((await post('/placement', placement(delegate), '')).status, 403);
  assert.equal((await post('/placement', placement(delegate), 'stranger')).status, 403);
  const visit = (await post('/placement', placement(delegate), 'guest')).json;
  assert.equal(visit.moderatorVisit, true);
  const claims = await verifier.verify(visit.token);
  assert.equal(claims.video.room, roomId);
  assert.equal(claims.video.canUpdateOwnMetadata, false);
  assert.ok(!claims.video.roomAdmin && !claims.video.roomRecord);
  publish('guest', 'PA_unrelated', 'forged');
  assert.equal((await lobby()).status, 403);
  publish('guest', 'PA_visit', claims.metadata);
  assert.deepEqual((await lobby()).json.coHosts, [{ identity: 'guest', sid: 'PA_visit' }]);
  assert.equal((await moderate(id, { action: 'mute', identity: 'stranger' }, 'guest')).status, 409);
  assert.equal((await moderate(id, { action: 'mute', identity: 'attendee' }, 'guest')).status, 200);
  assert.deepEqual(calls.at(-1), ['mute', roomId, 'attendee', 'TR_attendee']);

  assert.equal((await move(owner, roomId, 'owner')).status, 200);
  const help = await post('/breakout-help', { key: attendee.routingKey }, 'attendee');
  assert.equal(help.json.requested, true);
  assert.deepEqual(calls.at(-1), ['data', roomId, { topic: breakoutHelpTopic, destinationIdentities: ['owner'] }]);
  const rooms = (await api(path + '/breakouts')).json.rooms;
  assert.deepEqual(rooms[0].visitors.map(visitor => [visitor.identity, visitor.isHost]), [['guest', false], ['owner', true]]);
  assert.equal((await grant('PA_visit', false)).status, 200);
  const revoked = (await post('/placement', placement(delegate, roomId), 'guest')).json;
  assert.equal(revoked.roomId, id);
  assert.equal(revoked.moderatorVisit, false);
  const revokedClaims = await verifier.verify(revoked.token);
  assert.ok(!revokedClaims.metadata);
  publish('guest', 'PA_return', claims.metadata);
  assert.equal((await lobby()).status, 403);
  assert.equal((await post('/breakouts', { action: 'close' }, 'owner')).status, 200);
  assert.equal((await post('/placement', placement(owner, roomId), 'owner')).json.roomId, id);
});

test('moderators can reassign an admitted attendee while breakouts are open', async t => {
  const { api, create, connect, moderate, calls, livePeople } = await fixture(t);
  const { id } = (await create({ lobby: false })).json;
  const path = '/meetings/' + id;
  const post = (body, token = 'owner') => api(path + '/breakouts', { method: 'POST', body, token });
  await connect(id, 'owner');
  const guest = (await connect(id, 'guest')).json;
  await connect(id, 'attendee');
  livePeople.set('guest', { identity: 'guest', sid: 'PA_guest', state: ParticipantInfo_State.ACTIVE });
  await moderate(id, { action: 'co-host', identity: 'guest', sid: 'PA_guest', enabled: true });
  const opened = await post({ action: 'open', rooms: [{ name: 'Review', members: ['attendee'] }, { name: 'Discussion', members: [] }] });
  const [review, discussion] = opened.json.rooms;
  const move = { action: 'move-attendee', identity: 'attendee', from: review.id, destination: discussion.id };
  assert.equal((await post(move, 'attendee')).status, 403);
  assert.equal((await post({ ...move, identity: 'guest', from: id })).status, 403);
  assert.equal((await post({ ...move, destination: 'breakout_aaaaaaaaaaaaaaaa' })).status, 404);
  const reassigned = await post(move, 'guest');
  assert.equal(reassigned.status, 200);
  assert.deepEqual(reassigned.json.rooms[0].members, []);
  assert.deepEqual(reassigned.json.rooms[1].members.map(member => member.identity), ['attendee']);
  assert.equal((await post(move)).status, 409);
  const returned = await post({ ...move, from: discussion.id, destination: null });
  assert.equal(returned.status, 200);
  assert.equal(returned.json.rooms[1].members.length, 0);
  assert.deepEqual(calls.filter(call => call[0] === 'remove').map(call => call.slice(1, 3)),
    [[review.id, 'attendee'], [discussion.id, 'attendee']]);
  const delegate = await api(path + '/placement', { method: 'POST', body: { key: guest.routingKey, roomId: id } });
  assert.equal(delegate.json.roomId, id);
});

test('a live host transfer preserves the organizer and replaces in-room authority', async t => {
  const { api, create, connect, moderate, calls, livePeople } = await fixture(t);
  const { id } = (await create({ lobby: false })).json;
  const path = '/meetings/' + id;
  const owner = (await connect(id, 'owner')).json;
  const guest = (await connect(id, 'guest')).json;
  const place = key => api(path + '/placement', { token: '', method: 'POST', body: { key, roomId: id } });
  const transfer = (identity, sid, token = 'owner') => moderate(id, { action: 'transfer-host', identity, sid }, token);
  assert.equal((await transfer('guest', 'PA_guest')).status, 409);
  livePeople.set('guest', { sid: 'PA_guest', state: ParticipantInfo_State.ACTIVE });
  livePeople.set('owner', { sid: 'PA_owner', state: ParticipantInfo_State.ACTIVE });
  assert.equal((await transfer('guest', 'PA_previous')).status, 409);
  assert.equal((await transfer('guest', 'PA_guest', 'guest')).status, 403);
  await moderate(id, { action: 'co-host', identity: 'guest', sid: 'PA_guest', enabled: true });
  assert.deepEqual((await transfer('guest', 'PA_guest')).json, {
    ok: true, hostIdentity: 'guest', hostVersion: 1, coHosts: [],
  });
  assert.ok(calls.some(([kind, room, options]) => kind === 'data' && room === id && options.topic === 'meetrix.host-roles'));
  assert.equal((await place(owner.routingKey)).json.hostIdentity, 'guest');
  assert.equal((await place(guest.routingKey)).json.hostVersion, 1);
  assert.equal((await api(path + '/lobby', { token: 'owner' })).status, 403);
  assert.equal((await moderate(id, { action: 'end' })).status, 403);
  assert.equal((await moderate(id, { action: 'remove', identity: 'guest' }, 'guest')).status, 403);
  assert.equal((await api(path + '/lobby', { token: 'guest' })).status, 200);
  assert.equal((await moderate(id, { action: 'lock', locked: true }, 'guest')).status, 200);
  assert.equal((await connect(id, 'owner')).status, 423);
  const currentHost = (await connect(id, 'guest')).json;
  assert.equal(currentHost.meeting.isHost, true);
  assert.equal(currentHost.meeting.ownerName, 'Owner');
  assert.equal((await api(path + '/breakouts', { method: 'POST', token: 'guest',
    body: { action: 'open', rooms: [{ name: 'Review', members: ['guest'] }] } })).status, 409);
  assert.equal((await moderate(id, { action: 'lock', locked: false }, 'guest')).status, 200);
  const formerHost = (await connect(id, 'owner')).json;
  assert.equal(formerHost.meeting.isHost, false);
  assert.equal((await transfer('owner', 'PA_owner', 'guest')).json.hostVersion, 2);
  assert.equal((await place(owner.routingKey)).json.hostIdentity, 'owner');
  assert.equal((await moderate(id, { action: 'end' })).status, 200);
});

test('host succession waits for confirmed absence and elects only an active, preauthorized co-host', async t => {
  const { api, create, connect, moderate, livePeople, failedLookups, checkHostContinuity } = await fixture(t);
  const { id } = (await create({ lobby: false })).json;
  const path = '/meetings/' + id;
  const owner = (await connect(id, 'owner')).json;
  const publish = (identity, sid, state = ParticipantInfo_State.ACTIVE) => livePeople.set(identity, { identity, sid, state });
  const place = async () => (await api(path + '/placement', { token: '', method: 'POST', body: { key: owner.routingKey, roomId: id } })).json;
  const grant = (identity, sid) => moderate(id, { action: 'co-host', identity, sid, enabled: true });
  for (const identity of ['guest', 'stranger', 'attendee']) {
    await connect(id, identity);
    publish(identity, 'PA_' + identity);
  }
  assert.equal((await grant('guest', 'PA_guest')).status, 200);
  assert.equal((await grant('stranger', 'PA_stranger')).status, 200);
  publish('guest', 'PA_reconnected');
  livePeople.delete('stranger');

  await checkHostContinuity(0);
  await checkHostContinuity(29999);
  assert.equal((await place()).hostVersion, 0);
  publish('owner', 'PA_owner', ParticipantInfo_State.JOINED);
  await checkHostContinuity(30000);
  livePeople.delete('owner');
  await checkHostContinuity(35000);
  failedLookups.add('owner');
  await checkHostContinuity(65000);
  failedLookups.delete('owner');
  publish('stranger', 'PA_stranger');
  await checkHostContinuity(70000);
  assert.equal((await place()).hostVersion, 0);
  livePeople.delete('stranger');
  await checkHostContinuity(100000);
  assert.equal((await place()).hostIdentity, 'owner');
  publish('stranger', 'PA_stranger');
  await Promise.all([checkHostContinuity(105000), checkHostContinuity(105000)]);
  assert.equal((await place()).hostIdentity, 'stranger');
  assert.equal((await place()).hostVersion, 1);
  assert.equal((await moderate(id, { action: 'end' })).status, 403);
  assert.equal((await moderate(id, { action: 'end' }, 'guest')).status, 403);
  assert.equal((await api(path + '/lobby', { token: 'stranger' })).status, 200);
  publish('owner', 'PA_returning');
  await checkHostContinuity(140000);
  assert.equal((await place()).hostIdentity, 'stranger');
  assert.equal((await place()).hostVersion, 1);
  assert.equal((await moderate(id, { action: 'end' }, 'stranger')).status, 200);
});

test('host succession follows moderators into breakout rooms and signals both room populations', async t => {
  const { api, create, connect, moderate, calls, livePeople, checkHostContinuity } = await fixture(t);
  const { id } = (await create({ lobby: false })).json;
  const path = '/meetings/' + id;
  const owner = (await connect(id, 'owner')).json;
  const delegate = (await connect(id, 'guest')).json;
  const publish = (identity, sid, roomId, metadata) => livePeople.set(identity, { identity, sid, roomId, metadata, state: ParticipantInfo_State.ACTIVE });
  publish('owner', 'PA_owner', id);
  publish('guest', 'PA_guest', id);
  await moderate(id, { action: 'co-host', identity: 'guest', sid: 'PA_guest', enabled: true });
  const post = (endpoint, body, token) => api(path + endpoint, { token, method: 'POST', body });
  const open = await post('/breakouts', { action: 'open', selfSelect: true, rooms: [{ name: 'Review', members: [] }] }, 'owner');
  const roomId = open.json.rooms[0].id;
  const placement = session => ({ key: session.routingKey, roomId: id, placementEpoch: session.placementEpoch });
  for (const [token, session] of [['owner', owner], ['guest', delegate]]) {
    const start = placement(session);
    assert.equal((await post('/moderator-location', { ...start, destination: roomId }, token)).status, 200);
    const moved = (await post('/placement', start, token)).json;
    const claims = await new TokenVerifier(livekitKey, livekitSecret).verify(moved.token);
    publish(token, 'PA_visit_' + token, roomId, claims.metadata);
  }
  await checkHostContinuity(0);
  await checkHostContinuity(35000);
  const status = () => post('/placement', { ...placement(delegate), roomId }, 'guest');
  assert.equal((await status()).json.hostIdentity, 'owner');
  livePeople.delete('owner');
  await checkHostContinuity(40000);
  await checkHostContinuity(70000);
  assert.equal((await status()).json.hostIdentity, 'guest');
  assert.ok(calls.some(([kind, room, options]) => kind === 'data' && room === roomId && options.topic === 'meetrix.host-roles'));
  assert.ok(calls.some(([kind, room, options]) => kind === 'data' && room === id && options.topic === 'meetrix.host-roles'));
  assert.equal((await post('/breakouts', { action: 'close' }, 'guest')).status, 200);
  assert.equal((await status()).json.roomId, id);
});

test('encrypted host transfer and readmission preserve session, room and role boundaries', async t => {
  const { api, create, connect, moderate, calls, livePeople } = await fixture(t);
  const { id } = (await create({ encrypted: true, allowGuests: true })).json;
  const path = '/meetings/' + id;
  const owner = (await connect(id, 'owner', { keyReady: true })).json;
  assert.equal((await connect(id, 'guest', { keyReady: true })).json.state, 'waiting');
  assert.equal((await moderate(id, { action: 'decide', identity: 'guest', admit: true })).status, 200);
  assert.equal((await connect(id, 'guest')).json.state, 'key-required');
  const guest = (await connect(id, 'guest', { keyReady: true })).json;
  const place = (session, token, options = {}) => api(path + '/placement', {
    method: 'POST', token, body: { key: session.routingKey, roomId: id, placementEpoch: session.placementEpoch, ...options },
  });
  assert.equal((await place(guest, '')).status, 403);
  assert.equal((await place(guest, 'owner')).status, 403);
  assert.equal((await place(guest, 'guest', { roomId: 'aaaaaaaaaaaaaaaa' })).status, 403);
  assert.equal((await place(guest, 'guest', { breakoutRoomId: null })).status, 403);
  assert.equal((await place(guest, 'guest', { placementEpoch: 100 })).status, 409);
  assert.equal((await place(guest, 'guest')).json.token, undefined);

  const device = { name: 'Anonymous attendee', proof: '2532e017fbe74e198d11f4422be6bc8e', keyReady: true };
  const joinGuest = () => api(path + '/guest', { method: 'POST', token: '', body: device });
  assert.equal((await joinGuest()).json.state, 'waiting');
  const lobby = (await api(path + '/lobby')).json;
  const visitorIdentity = lobby.guests.find(visitor => visitor.accountless).identity;
  await moderate(id, { action: 'decide', identity: visitorIdentity, admit: true });
  const visitor = (await joinGuest()).json;
  assert.equal((await place(visitor, '')).status, 200);
  assert.equal((await moderate(id, { action: 'transfer-host', identity: visitorIdentity, sid: 'PA_visitor' })).status, 409);
  assert.equal((await moderate(id, { action: 'co-host', identity: 'guest', sid: 'PA_guest', enabled: true })).status, 403);

  assert.equal((await moderate(id, { action: 'wait', identity: 'guest' })).status, 200);
  assert.deepEqual((await place(guest, 'guest')).json, { waiting: true, placementEpoch: 1 });
  assert.equal((await connect(id, 'guest', { keyReady: true })).json.state, 'waiting');
  assert.ok(calls.some(([kind, room, actor, options]) => kind === 'remove' && room === id && actor === 'guest' && typeof options.revokeTokenTs === 'bigint'));
  await moderate(id, { action: 'decide', identity: 'guest', admit: true });
  const resumed = (await place(guest, 'guest')).json;
  const claims = await new TokenVerifier(livekitKey, livekitSecret).verify(resumed.token);
  assert.equal(resumed.placementEpoch, 1);
  assert.equal(claims.sub, 'guest');
  assert.equal(claims.video.room, id);
  assert.ok(!claims.video.roomAdmin && !claims.video.roomRecord);
  livePeople.set('guest', { sid: 'PA_readmitted', state: ParticipantInfo_State.ACTIVE });
  const transfer = { action: 'transfer-host', identity: 'guest', sid: 'PA_readmitted' };
  assert.equal((await moderate(id, transfer, 'guest')).status, 403);
  assert.equal((await moderate(id, { ...transfer, sid: 'PA_old' })).status, 409);
  assert.equal((await moderate(id, transfer)).status, 200);
  const roles = (await place(owner, 'owner')).json;
  assert.equal(roles.hostVersion, 1);
  assert.equal(roles.hostIdentity, 'guest');
  assert.equal(roles.token, undefined);
  assert.equal((await moderate(id, { action: 'end' })).status, 403);
  assert.equal((await moderate(id, { action: 'wait', identity: 'owner' }, 'guest')).status, 200);
  assert.ok((await place(owner, 'owner')).json.waiting);
  await moderate(id, { action: 'decide', identity: 'owner', admit: false }, 'guest');
  assert.equal((await place(owner, 'owner')).status, 403);
  assert.equal((await api(path + '/notes', { token: 'guest' })).status, 403);
  assert.equal((await moderate(id, { action: 'end' }, 'guest')).status, 200);
  assert.equal((await place(guest, 'guest')).status, 410);
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
