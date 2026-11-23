import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { EgressStatus, EncodedFileType, ParticipantInfo_State } from 'livekit-server-sdk';
import { createApp } from '../server/app.mjs';
import { readConfig } from '../server/config.mjs';

const origin = 'https://meetrix.test';
const livekitUrl = 'wss://rtc.meetrix.test';
const s3 = { bucket: 'private-recordings', accessKey: 'test-access', secret: 'test-secret', region: 'us-east-1' };

async function fixture(t, enabled = true) {
  const sessions = new Map();
  const started = [];
  const stopped = [];
  const jobs = new Map();
  const retrieved = [];
  const { app, close } = createApp({
    origin, livekitUrl, livekitKey: 'test-key', livekitSecret: 'test-signature-secret-long-enough',
    insforgeUrl: 'https://auth.meetrix.test', databasePath: ':memory:', cloudRecording: enabled ? s3 : undefined,
  }, {
    authenticate: async identity => {
      if (!['host', 'guest', 'stranger'].includes(identity)) throw new Error('No such user.');
      return identity;
    },
    cloudStorage: {
      async download(key) {
        retrieved.push(key);
        return { Body: Readable.from([Buffer.from('private mp4 fixture')]), ContentLength: 19 };
      },
    },
    rooms: {
      async createRoom() {},
      async deleteRoom() {},
      async listParticipants() { return [...sessions.values()]; },
      async getParticipant(_room, identity) { return sessions.get(identity); },
    },
    egress: {
      async startRoomCompositeEgress(room, output, options) {
        const info = {
          egressId: 'EG_' + (started.length + 1), status: EgressStatus.EGRESS_ACTIVE,
          request: { case: 'roomComposite', value: { fileOutputs: [output] } },
        };
        started.push({ room, output, options });
        jobs.set(info.egressId, info);
        return info;
      },
      async listEgress({ egressId }) { return [...jobs.values()].filter(job => !egressId || job.egressId === egressId); },
      async stopEgress(egressId) {
        const info = jobs.get(egressId);
        stopped.push(egressId);
        info.status = EgressStatus.EGRESS_COMPLETE;
        info.fileResults = [{ filename: info.request.value.fileOutputs[0].filepath, size: 1024n }];
        return info;
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    close();
  });
  const root = 'http://127.0.0.1:' + server.address().port + '/api';

  async function api(path, identity, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(root + path, { method,
      headers: { Origin: origin, ...(identity ? { Authorization: 'Bearer ' + identity } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, json: await response.json() };
  }

  async function meeting(extra = {}) {
    const result = await api('/meetings', 'host', { title: 'Review', name: 'Host', lobby: false, ...extra });
    assert.equal(result.status, 201);
    const path = '/meetings/' + result.json.id;
    for (const identity of ['host', 'guest']) await api(path + '/connect', identity, { name: identity });
    return path;
  }

  function setSession(identity, suffix = identity) {
    sessions.set(identity, { identity, sid: 'PA_' + suffix, state: ParticipantInfo_State.ACTIVE, kind: 0 });
  }
  setSession('host');
  setSession('guest');

  const download = (id, identity) => fetch(root + '/cloud-recordings/' + id + '/download', {
    headers: identity ? { Authorization: 'Bearer ' + identity } : {},
  });
  return { api, meeting, setSession, started, stopped, download, retrieved };
}

test('cloud recording is opt-in, hosted only, and validates the private storage configuration', async t => {
  const { api, meeting } = await fixture(t, false);
  const path = await meeting();
  assert.equal((await api('/config')).json.cloudRecording, false);
  assert.equal((await api(path + '/cloud-recording', 'host')).status, 404);
  const hosted = {
    APP_ORIGIN: origin, LIVEKIT_URL: livekitUrl, LIVEKIT_API_KEY: 'test-key', LIVEKIT_API_SECRET: 'test-signature-secret-long-enough',
    INSFORGE_URL: 'https://auth.meetrix.test', MEETRIX_CLOUD_RECORDING: 'true',
  };
  assert.throws(() => readConfig({ ...hosted, APP_ORIGIN: 'http://localhost' }), /hosted HTTPS/);
  assert.throws(() => readConfig(hosted), /private S3 bucket/);
  assert.equal(readConfig({
    ...hosted, MEETRIX_EGRESS_S3_BUCKET: s3.bucket, MEETRIX_EGRESS_S3_REGION: s3.region,
    MEETRIX_EGRESS_S3_ACCESS_KEY: s3.accessKey, MEETRIX_EGRESS_S3_SECRET: s3.secret,
  }).cloudRecording.bucket, s3.bucket);
});

test('only one room composite starts after every matching participant consents', async t => {
  const { api, meeting, started, stopped, download, retrieved } = await fixture(t);
  const meetingPath = await meeting();
  const path = meetingPath + '/cloud-recording';
  assert.equal((await api('/config')).json.cloudRecording, true);
  assert.equal((await api(path, 'stranger')).status, 403);
  assert.equal((await api(path, 'guest', { action: 'request' })).status, 403);
  const requests = await Promise.all([api(path, 'host', { action: 'request' }), api(path, 'host', { action: 'request' })]);
  assert.deepEqual(requests.map(response => response.status).sort(), [200, 409]);
  const id = requests.find(response => response.status === 200).json.id;
  assert.equal((await download(id, 'host')).status, 404);
  assert.deepEqual((await api(path, 'guest')).json, {
    id, state: 'requesting', total: 2, approved: 1, consent: null, canConsent: true, canStart: false,
  });
  assert.equal((await api(path, 'host', { action: 'start', id })).status, 409);
  assert.equal((await api(path, 'guest', { action: 'consent', id, allow: false })).status, 200);
  assert.equal((await api(path, 'host', { action: 'start', id })).status, 409);
  assert.equal((await api(path, 'guest', { action: 'consent', id, allow: true })).json.approved, 2);
  const launches = await Promise.all([api(path, 'host', { action: 'start', id }), api(path, 'host', { action: 'start', id })]);
  assert.deepEqual(launches.map(response => response.status).sort(), [200, 409]);
  assert.equal(started.length, 1);
  assert.equal(started[0].output.fileType, EncodedFileType.MP4);
  assert.equal(started[0].output.disableManifest, true);
  assert.equal(started[0].output.output.value.bucket, s3.bucket);
  assert.equal(started[0].room, meetingPath.split('/').at(-1));
  const templateUrl = new URL(started[0].options.customBaseUrl);
  assert.equal(templateUrl.origin, origin);
  assert.equal(templateUrl.pathname, '/recording.html');
  const ticket = templateUrl.searchParams.get('access');
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await api('/recording-template', 'guest')).status, 404);
  assert.deepEqual((await api('/recording-template', ticket)).json, {
    room: started[0].room, serverUrl: livekitUrl,
    participants: [{ identity: 'guest', sid: 'PA_guest' }, { identity: 'host', sid: 'PA_host' }],
  });
  assert.ok(!JSON.stringify(launches).includes(ticket));
  assert.ok(!JSON.stringify(launches).includes(s3.secret));
  assert.equal((await api(path, 'guest', { action: 'stop', id })).status, 403);
  assert.equal((await api(path, 'guest', { action: 'consent', id, allow: false })).json.state, 'ready');
  assert.equal((await api('/recording-template', ticket)).status, 404);
  assert.deepEqual(stopped, ['EG_1']);
  assert.equal((await api(path, 'guest')).json.file, undefined);
  assert.equal((await api(path, 'host')).json.file, started[0].output.filepath);
  assert.equal((await download(id)).status, 401);
  assert.equal((await download(id, 'guest')).status, 404);
  assert.deepEqual((await api('/cloud-recordings', 'guest')).json, []);
  assert.deepEqual((await api('/cloud-recordings', 'host')).json.map(recording => recording.id), [id]);
  const file = await download(id, 'host');
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-disposition'), 'attachment; filename="meetrix-' + id + '.mp4"');
  assert.equal(await file.text(), 'private mp4 fixture');
  assert.deepEqual(retrieved, [started[0].output.filepath]);
  await api(meetingPath + '/moderate', 'host', { action: 'end' });
  assert.equal((await api(path, 'guest')).status, 403);
  assert.equal((await api(path, 'host')).json.file, started[0].output.filepath);
});

test('reconnecting invalidates a participant consent and cloud work is blocked in restricted rooms', async t => {
  const { api, meeting, setSession, started } = await fixture(t);
  const path = (await meeting()) + '/cloud-recording';
  const { json: { id } } = await api(path, 'host', { action: 'request' });
  assert.equal((await api(path, 'guest', { action: 'consent', id, allow: true })).status, 200);
  setSession('guest', 'replacement');
  assert.equal((await api(path, 'guest', { action: 'consent', id, allow: true })).status, 403);
  assert.equal((await api(path, 'host', { action: 'start', id })).status, 409);
  assert.equal((await api(path, 'host')).json.state, 'failed');
  assert.equal(started.length, 0);
  for (const config of [{ encrypted: true }, { allowGuests: true, lobby: true }]) {
    const restricted = (await meeting(config)) + '/cloud-recording';
    assert.equal((await api(restricted, 'host', { action: 'request' })).status, 404);
  }
});

test('host transfer ends cloud capture and preserves the requesting host’s private object key', async t => {
  const { api, meeting, started, stopped } = await fixture(t);
  const meetingPath = await meeting();
  const path = meetingPath + '/cloud-recording';
  const { json: { id } } = await api(path, 'host', { action: 'request' });
  await api(path, 'guest', { action: 'consent', id, allow: true });
  assert.equal((await api(path, 'host', { action: 'start', id })).json.state, 'recording');
  const ticket = new URL(started[0].options.customBaseUrl).searchParams.get('access');
  const transfer = await api(meetingPath + '/moderate', 'host', { action: 'transfer-host', identity: 'guest', sid: 'PA_guest' });
  assert.equal(transfer.status, 200);
  assert.deepEqual(stopped, ['EG_1']);
  assert.equal((await api('/recording-template', ticket)).status, 404);
  assert.equal((await api(path, 'host')).json.file, started[0].output.filepath);
  assert.equal((await api(path, 'guest')).json.file, undefined);
  assert.equal((await api(path, 'host', { action: 'request' })).status, 403);
  assert.equal((await api(path, 'guest', { action: 'request' })).json.state, 'requesting');
  await api(meetingPath + '/moderate', 'guest', { action: 'end' });
  assert.equal((await api(path, 'host')).json.file, started[0].output.filepath);
});
