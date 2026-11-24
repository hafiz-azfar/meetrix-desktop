import { createHash, randomBytes } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { credentialSeal } from './credential-seal.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const assertion = /^[A-Za-z0-9_-]{43}$/;
const label = '__Host-meetrix-outlook';
const cookie = { path: '/', secure: true, httpOnly: true, sameSite: 'lax' };
const lifetime = 10 * 60_000;
const scopes = { calendar: ['Calendars.ReadWrite'], mail: ['Mail.Read', 'Mail.Send'] };
const capability = z.object({ capability: z.enum(['calendar', 'mail']) }).strict();
const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');

export function outlookSettings(env, origin) {
  const clientId = env.MEETRIX_OUTLOOK_CLIENT_ID;
  const clientSecret = env.MEETRIX_OUTLOOK_CLIENT_SECRET;
  const key = env.MEETRIX_OUTLOOK_KEY;
  if (![clientId, clientSecret, key].some(Boolean)) return undefined;
  const tenant = env.MEETRIX_OUTLOOK_TENANT || 'common';
  if (origin.protocol !== 'https:' || !uuid.test(clientId || '') || !clientSecret || !assertion.test(key || '') ||
      (!['common', 'organizations', 'consumers'].includes(tenant) && !uuid.test(tenant))) {
    throw new Error('Outlook requires HTTPS, Microsoft OAuth credentials, and a 32-byte base64url encryption key.');
  }
  return { clientId, clientSecret, key, tenant };
}

function authorized(payload, kind) {
  if (typeof payload.scope !== 'string') return false;
  const granted = payload.scope.split(/\s+/).map(scope => scope.split('/').at(-1).toLowerCase());
  return scopes[kind].every(scope => granted.includes(scope.toLowerCase()));
}

export function createOutlookOAuth({ db, origin, settings, limits, error, serial, call, resetCalendar }) {
  const root = '/workspace/outlook';
  const callback = '/outlook/callback';
  const redirect = new URL('/api' + callback, origin).href;
  const microsoft = 'https://login.microsoftonline.com/' + settings.tenant + '/oauth2/v2.0/';
  const { seal, unseal } = credentialSeal(settings.key);
  const add = db.prepare('INSERT INTO outlook_flows(state, nonce, owner, kind, verifier, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
  const byState = db.prepare('SELECT * FROM outlook_flows WHERE state = ? AND expires_at > ?');
  const byOwner = db.prepare('SELECT * FROM outlook_flows WHERE nonce = ? AND owner = ? AND expires_at > ?');
  const code = db.prepare('UPDATE outlook_flows SET code = ? WHERE state = ? AND code IS NULL');
  const consume = db.prepare('DELETE FROM outlook_flows WHERE state = ?');
  const clear = db.prepare('DELETE FROM outlook_flows WHERE owner = ? OR expires_at <= ?');
  const credential = db.prepare('SELECT refresh_token AS token FROM outlook_connections WHERE owner = ? AND kind = ?');
  const save = db.prepare('INSERT INTO outlook_connections(owner, kind, refresh_token) VALUES (?, ?, ?) ON CONFLICT(owner, kind) DO UPDATE SET refresh_token=excluded.refresh_token');
  const remove = db.prepare('DELETE FROM outlook_connections WHERE owner = ? AND kind = ?');
  const binding = (owner, kind) => 'outlook:' + owner + ':' + kind;
  const serialize = (owner, kind, operation) => serial(binding(owner, kind), operation);
  const status = owner => Object.fromEntries(Object.keys(scopes).map(kind => [kind, Boolean(credential.get(owner, kind))]));

  function nonce(req) {
    const prefix = label + '=';
    const values = (req.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(prefix));
    const entry = values.length === 1 ? values[0].slice(prefix.length) : '';
    return assertion.test(entry) ? hash(entry) : null;
  }
  async function token(kind, fields) {
    const response = await call(microsoft + 'token', {
      method: 'POST', body: new URLSearchParams({
        client_id: settings.clientId, client_secret: settings.clientSecret,
        scope: ['offline_access', ...scopes[kind]].join(' '), ...fields,
      }),
    });
    if (!response.ok) throw error(409, 'Outlook authorization failed. Reconnect your account.');
    const result = await response.json();
    if (typeof result.access_token !== 'string' || !authorized(result, kind)) {
      throw error(409, 'Outlook did not grant the requested access.');
    }
    return result;
  }
  async function run(owner, kind, operation) {
    return serialize(owner, kind, async () => {
      const row = credential.get(owner, kind);
      if (!row) throw error(409, 'Connect Outlook ' + kind + ' first.');
      let refresh;
      try { refresh = unseal(row.token, binding(owner, kind)); }
      catch { throw error(409, 'Reconnect Outlook to restore access.'); }
      const result = await token(kind, { grant_type: 'refresh_token', refresh_token: refresh });
      if (result.refresh_token) save.run(owner, kind, seal(result.refresh_token, binding(owner, kind)));
      return operation(result.access_token);
    });
  }
  function replaceConnection(owner, kind, refresh) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (kind === 'calendar') resetCalendar(owner);
      if (refresh) save.run(owner, kind, seal(refresh, binding(owner, kind)));
      else remove.run(owner, kind);
      db.exec('COMMIT');
    } catch (failure) { db.exec('ROLLBACK'); throw failure; }
  }

  return {
    run, status,
    public(api) {
      api.get(callback, rateLimit({ ...limits, limit: 20 }), (req, res) => {
        const { state, code: value } = req.query;
        const browser = nonce(req);
        const flow = browser && typeof state === 'string' && assertion.test(state) && byState.get(hash(state), Date.now());
        if (!flow || flow.nonce !== browser || typeof value !== 'string' || !value || value.length > 4096 ||
            !code.run(seal(value, binding(flow.owner, flow.kind)), flow.state).changes) {
          return res.redirect(303, '/?outlook=failed');
        }
        res.redirect(303, '/?outlook=complete&outlookApp=' + flow.kind);
      });
    },
    authenticated(api, byIdentity) {
      api.get(root, (req, res) => res.json(status(req.identity)));
      api.post(root + '/start', byIdentity(8), (req, res) => {
        const { capability: kind } = capability.parse(req.body);
        const state = random();
        const browser = random();
        const verifier = random();
        const now = Date.now();
        clear.run(req.identity, now);
        add.run(hash(state), hash(browser), req.identity, kind, verifier, now + lifetime);
        res.cookie(label, browser, { ...cookie, maxAge: lifetime });
        const url = new URL(microsoft + 'authorize');
        url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: redirect,
          response_type: 'code', response_mode: 'query', scope: ['offline_access', ...scopes[kind]].join(' '),
          state, code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url') });
        res.json({ url: url.href });
      });
      api.post(root + '/complete', byIdentity(8), async (req, res) => {
        const owner = req.identity;
        const browser = nonce(req);
        const flow = browser && byOwner.get(browser, owner, Date.now());
        if (!flow?.code) throw error(409, 'This Outlook connection expired. Start again in the same browser.');
        res.clearCookie(label, cookie);
        await serialize(owner, flow.kind, async () => {
          if (!consume.run(flow.state).changes) throw error(409, 'This Outlook connection already finished or expired.');
          const result = await token(flow.kind, { grant_type: 'authorization_code', redirect_uri: redirect,
            code: unseal(flow.code, binding(owner, flow.kind)), code_verifier: flow.verifier });
          if (typeof result.refresh_token !== 'string' || !result.refresh_token) throw error(409, 'Outlook did not provide offline access.');
          replaceConnection(owner, flow.kind, result.refresh_token);
        });
        res.json(status(owner));
      });
      api.delete(root, byIdentity(8), async (req, res) => {
        const { capability: kind } = capability.parse(req.body);
        await serialize(req.identity, kind, () => {
          clear.run(req.identity, Date.now());
          replaceConnection(req.identity, kind, null);
        });
        res.json(status(req.identity));
      });
    },
  };
}
