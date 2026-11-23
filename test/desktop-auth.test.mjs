import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { openDatabase } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';

const origin = 'https://meetrix.test';
const clerkPublishableKey = 'pk_test_' + Buffer.from('clerk.meetrix.test$').toString('base64url');
const makeVerifier = () => randomBytes(32).toString('base64url');
const challenge = verifier => createHash('sha256').update(verifier).digest('base64url');

async function fixture(t) {
  const db = openDatabase(':memory:');
  const { app, close } = createApp({ origin, clerkPublishableKey }, {
    db, authenticate: async token => {
      if (token !== 'clerk-browser') throw new Error('Wrong token');
      return 'user_Browser';
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    close();
  });
  const root = 'http://127.0.0.1:' + server.address().port + '/api';
  async function call(path, { body, site = origin, token, cookie } = {}) {
    const response = await fetch(root + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...(site ? { Origin: site } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  return { call, db };
}

test('only the requesting desktop can claim an approved Clerk sign-in once', async t => {
  const { call } = await fixture(t);
  const verifier = makeVerifier();
  const begin = { body: { challenge: challenge(verifier) } };
  assert.equal((await call('/desktop-auth/requests', { ...begin, site: 'https://elsewhere.test' })).status, 403);
  const started = await call('/desktop-auth/requests', begin);
  assert.equal(started.status, 201);
  const { id, code } = started.body;
  const request = '/desktop-auth/requests/' + id;
  const claim = body => call(request + '/claim', { body });
  const approve = (body, token) => call(request + '/approve', { body, token });
  assert.equal((await claim({ verifier })).status, 202);
  assert.equal((await approve({ code, name: 'Test User' })).status, 401);
  const wrongCode = code === 'AAAA-AAAA' ? 'AAAA-AAAB' : 'AAAA-AAAA';
  assert.equal((await approve({ code: wrongCode, name: 'Test User' }, 'clerk-browser')).status, 403);
  assert.equal((await approve({ code, name: 'Test User' }, 'clerk-browser')).status, 200);
  assert.equal((await claim({ verifier: makeVerifier() })).status, 410);
  const results = await Promise.all([claim({ verifier }), claim({ verifier })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 410]);
  const signedIn = results.find(result => result.status === 200);
  assert.deepEqual(signedIn.body, { user: { id: 'user_Browser', fullName: 'Test User' } });
  assert.match(signedIn.cookie, /^__Host-meetrix-desktop=/);
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(signedIn.cookie.includes(attribute));

  const cookie = signedIn.cookie.split(';')[0];
  assert.equal((await call('/desktop-auth/session')).body.user, null);
  assert.equal((await call('/desktop-auth/session', { cookie })).body.user.id, 'user_Browser');
  assert.equal((await call('/meetings', { cookie })).status, 200);
  assert.equal((await call('/meetings', { cookie, token: 'untrusted' })).status, 401);
  const meeting = { name: 'Test User', title: 'My first desktop meeting' };
  assert.equal((await call('/meetings', { cookie, body: meeting, site: null })).status, 403);
  assert.equal((await call('/meetings', { cookie, body: meeting, site: 'https://elsewhere.test' })).status, 403);
  assert.equal((await call('/meetings', { cookie, body: meeting })).status, 201);

  const second = await call('/desktop-auth/requests', { body: { challenge: challenge(makeVerifier()) } });
  assert.equal((await call('/desktop-auth/requests/' + second.body.id + '/approve', {
    cookie, body: { code: second.body.code, name: 'Test User' },
  })).status, 401);
  assert.equal((await call('/desktop-auth/sign-out', { cookie, body: {} })).status, 200);
  assert.equal((await call('/meetings', { cookie })).status, 401);
});

test('pairing expires and stops accepting guesses after six attempts', async t => {
  const { call, db } = await fixture(t);
  const verifier = makeVerifier();
  const create = () => call('/desktop-auth/requests', { body: { challenge: challenge(verifier) } });
  const first = await create();
  const path = '/desktop-auth/requests/' + first.body.id;
  const wrongCode = first.body.code === 'AAAA-AAAA' ? 'AAAA-AAAB' : 'AAAA-AAAA';
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.equal((await call(path + '/approve', {
      body: { code: wrongCode, name: 'Test' }, token: 'clerk-browser',
    })).status, 403);
  }
  assert.equal((await call(path + '/approve', {
    body: { code: first.body.code, name: 'Test' }, token: 'clerk-browser',
  })).status, 410);
  const second = await create();
  db.prepare('UPDATE desktop_sign_ins SET expires_at = 0 WHERE id = ?').run(second.body.id);
  assert.equal((await call('/desktop-auth/requests/' + second.body.id + '/claim', { body: { verifier } })).status, 410);
});
