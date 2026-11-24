import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createClient } from '@insforge/sdk';
import { openDatabase } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { authenticationScope } from '../server/auth.mjs';

const origin = 'https://meetrix.test';
const insforgeUrl = 'https://auth.meetrix.test';
const makeVerifier = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
const user = { id: 'ba012345-8b22-45c1-a642-4edf2abcc820', email: 'test@example.test', emailVerified: true,
  profile: { name: 'InsForge QA' } };
const expectedId = authenticationScope(insforgeUrl) + user.id;
const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'test'].join('.');

async function fixture(t) {
  const db = openDatabase(':memory:');
  let callback;
  let authorizationChallenge;
  const createAuth = accessToken => createClient({
    baseUrl: insforgeUrl, accessToken, isServerMode: true,
    fetch: async (input, options) => {
      const url = new URL(input.toString());
      assert.equal(url.origin, insforgeUrl);
      switch (url.pathname) {
        case '/api/auth/public-config':
          return Response.json({ oAuthProviders: ['google', 'github'], allowEmailOtp: true });
        case '/api/auth/oauth/google':
          callback = new URL(url.searchParams.get('redirect_uri'));
          authorizationChallenge = url.searchParams.get('code_challenge');
          return Response.json({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth' });
        case '/api/auth/oauth/exchange': {
          const { code, code_verifier } = JSON.parse(options.body);
          assert.equal(code, 'oauth-approval');
          assert.equal(digest(code_verifier), authorizationChallenge);
          return Response.json({ user, accessToken: fakeJwt, refreshToken: 'simulated-local-token' });
        }
        case '/api/auth/sessions':
          return Response.json({ user, accessToken: fakeJwt });
        default:
          return Response.json({ error: 'Not found' }, { status: 404 });
      }
    },
  }).auth;
  const { app, close } = createApp({ origin, insforgeUrl }, { db, createAuth });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); close(); });
  const root = 'http://127.0.0.1:' + server.address().port + '/api';

  async function call(path, { body, site = origin, token, cookie } = {}) {
    const response = await fetch(root + path, {
      method: body ? 'POST' : 'GET', redirect: 'manual',
      headers: { ...(site ? { Origin: site } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: response.status === 303 ? null : await response.json(),
      cookies: response.headers.getSetCookie(), location: response.headers.get('location') };
  }
  async function browserSignIn() {
    const result = await call('/auth/email/password', { body: { email: 'test@example.test', password: 'fake-test-password' } });
    assert.equal(result.status, 200);
    return result.cookies[0].split(';')[0];
  }
  return { call, db, browserSignIn, getCallback: () => callback };
}

test('InsForge OAuth uses PKCE and a single browser state before creating a Meetrix cookie', async t => {
  const { call, getCallback } = await fixture(t);
  const methods = await call('/auth/methods');
  assert.deepEqual(methods.body.providers, [{ key: 'google', name: 'Google' }, { key: 'github', name: 'GitHub' }]);
  assert.equal((await call('/auth/oauth', { body: { provider: 'apple', next: '/' } })).status, 400);
  const next = '/desktop-sign-in?request=' + randomBytes(16).toString('base64url');
  const started = await call('/auth/oauth', { body: { provider: 'google', next } });
  assert.equal(started.status, 200);
  assert.equal(new URL(started.body.url).hostname, 'accounts.google.com');
  assert.match(started.cookies[0], /SameSite=Lax/);
  const cookie = started.cookies[0].split(';')[0];
  const callback = getCallback();
  assert.equal(callback.origin, origin);
  assert.equal(callback.pathname, '/api/auth/callback');
  callback.searchParams.set('insforge_code', 'oauth-approval');
  const path = '/auth/callback' + callback.search;
  assert.equal((await call(path)).location, '/?auth_error=expired');
  const callbackResult = await call(path, { cookie, site: null });
  assert.equal(callbackResult.location, next);
  const issued = callbackResult.cookies.find(value => value.startsWith('__Host-meetrix-auth='));
  assert.match(issued, /HttpOnly/);
  assert.match(issued, /SameSite=Strict/);
  const session = await call('/desktop-auth/session', { cookie: issued.split(';')[0] });
  assert.deepEqual(session.body.user, { id: expectedId, fullName: 'InsForge QA' });
  assert.equal((await call(path, { cookie })).location, '/?auth_error=expired');
});

test('only the requesting desktop claims an approved InsForge browser session once', async t => {
  const { call, db, browserSignIn } = await fixture(t);
  const browserCookie = await browserSignIn();
  const verifier = makeVerifier();
  const begin = { body: { challenge: digest(verifier) } };
  assert.equal((await call('/desktop-auth/requests', { ...begin, site: 'https://elsewhere.test' })).status, 403);
  const started = await call('/desktop-auth/requests', begin);
  const { id, code } = started.body;
  const request = '/desktop-auth/requests/' + id;
  const claim = body => call(request + '/claim', { body });
  const approve = (body, cookie) => call(request + '/approve', { body, cookie });
  assert.equal((await claim({ verifier })).status, 202);
  assert.equal((await approve({ code })).status, 401);
  const wrongCode = code === 'AAAA-AAAA' ? 'AAAA-AAAB' : 'AAAA-AAAA';
  assert.equal((await approve({ code: wrongCode }, browserCookie)).status, 403);
  assert.equal((await approve({ code }, browserCookie)).status, 200);
  assert.equal((await claim({ verifier: makeVerifier() })).status, 410);
  const results = await Promise.all([claim({ verifier }), claim({ verifier })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 410]);
  const signedIn = results.find(result => result.status === 200);
  assert.deepEqual(signedIn.body, { user: { id: expectedId, fullName: 'InsForge QA' } });
  const matchedKeys = db.prepare('SELECT breakout_email_key AS key FROM desktop_sessions WHERE identity = ? ORDER BY kind').all(expectedId);
  assert.equal(matchedKeys.length, 2);
  assert.match(matchedKeys[0].key, /^[a-f0-9]{64}$/);
  assert.equal(matchedKeys[0].key, matchedKeys[1].key);
  assert.match(signedIn.cookies[0], /^__Host-meetrix-auth=/);
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(signedIn.cookies[0].includes(attribute));

  const cookie = signedIn.cookies[0].split(';')[0];
  assert.equal((await call('/desktop-auth/session')).body.user, null);
  assert.equal((await call('/meetings', { cookie })).status, 200);
  assert.equal((await call('/meetings', { cookie, token: 'untrusted' })).status, 401);
  const meeting = { name: 'Test User', title: 'My first desktop meeting' };
  assert.equal((await call('/meetings', { cookie, body: meeting, site: null })).status, 403);
  assert.equal((await call('/meetings', { cookie, body: meeting, site: 'https://elsewhere.test' })).status, 403);
  assert.equal((await call('/meetings', { cookie, body: meeting })).status, 201);
  const second = await call('/desktop-auth/requests', { body: { challenge: digest(makeVerifier()) } });
  assert.equal((await call('/desktop-auth/requests/' + second.body.id + '/approve', {
    cookie, body: { code: second.body.code },
  })).status, 401);
  assert.equal((await call('/desktop-auth/sign-out', { cookie, body: {} })).status, 200);
  assert.equal((await call('/meetings', { cookie })).status, 401);

  const legacyToken = makeVerifier();
  db.prepare("INSERT INTO desktop_sessions(credential, identity, name, expires_at, kind) VALUES (?, 'user_ClerkLegacy', 'Old user', ?, 'desktop')")
    .run(digest(legacyToken), Date.now() + 60000);
  assert.equal((await call('/meetings', { cookie: '__Host-meetrix-auth=' + legacyToken })).status, 401);
});

test('pairing expires and stops accepting guesses after six attempts', async t => {
  const { call, db, browserSignIn } = await fixture(t);
  const cookie = await browserSignIn();
  const verifier = makeVerifier();
  const create = () => call('/desktop-auth/requests', { body: { challenge: digest(verifier) } });
  const first = await create();
  const path = '/desktop-auth/requests/' + first.body.id;
  const wrongCode = first.body.code === 'AAAA-AAAA' ? 'AAAA-AAAB' : 'AAAA-AAAA';
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.equal((await call(path + '/approve', { cookie, body: { code: wrongCode } })).status, 403);
  }
  assert.equal((await call(path + '/approve', { cookie, body: { code: first.body.code } })).status, 410);
  const second = await create();
  db.prepare('UPDATE desktop_sign_ins SET expires_at = 0 WHERE id = ?').run(second.body.id);
  assert.equal((await call('/desktop-auth/requests/' + second.body.id + '/claim', { body: { verifier } })).status, 410);
});
