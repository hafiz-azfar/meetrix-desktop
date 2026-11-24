import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';

export const calendarScope = 'https://www.googleapis.com/auth/calendar.events.owned';
const route = '/workspace/google-calendar';
const pattern = /^[A-Za-z0-9_-]{43}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const cookie = '__Host-meetrix-calendar';
const sameSite = { path: '/', secure: true, httpOnly: true, sameSite: 'lax' };
const age = 10 * 60_000;

export function googleCalendarSettings(env, origin) {
  const clientId = env.MEETRIX_GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = env.MEETRIX_GOOGLE_CALENDAR_CLIENT_SECRET;
  const key = env.MEETRIX_GOOGLE_CALENDAR_KEY;
  if (![clientId, clientSecret, key].some(Boolean)) return undefined;
  if (origin.protocol !== 'https:' || !/^[A-Za-z0-9.-]+\.apps\.googleusercontent\.com$/.test(clientId || '') ||
      !clientSecret || !pattern.test(key || '')) {
    throw new Error('Google Calendar requires HTTPS, OAuth credentials, and a 32-byte base64url encryption key.');
  }
  return { clientId, clientSecret, key };
}

export function createGoogleOAuth({ db, origin, settings, limits, error, serial, call }) {
  const callback = '/google-calendar/callback';
  const redirect = new URL('/api' + callback, origin).href;
  const key = Buffer.from(settings.key, 'base64url');
  const start = db.prepare('INSERT INTO google_calendar_flows(state, nonce, owner, verifier, expires_at) VALUES (?, ?, ?, ?, ?)');
  const byState = db.prepare('SELECT * FROM google_calendar_flows WHERE state = ? AND expires_at > ?');
  const byOwner = db.prepare('SELECT * FROM google_calendar_flows WHERE nonce = ? AND owner = ? AND expires_at > ?');
  const submit = db.prepare('UPDATE google_calendar_flows SET code = ? WHERE state = ? AND code IS NULL');
  const remove = db.prepare('DELETE FROM google_calendar_flows WHERE state = ?');
  const sweep = db.prepare('DELETE FROM google_calendar_flows WHERE owner = ? OR expires_at <= ?');
  const credentials = db.prepare('SELECT refresh_token AS token FROM google_calendar_connections WHERE owner = ?');
  const save = db.prepare('INSERT INTO google_calendar_connections(owner, refresh_token) VALUES(?, ?) ON CONFLICT(owner) DO UPDATE SET refresh_token=excluded.refresh_token');
  const clear = db.prepare('DELETE FROM google_calendar_connections WHERE owner = ?');
  const unlink = db.prepare('DELETE FROM google_calendar_events WHERE meeting IN (SELECT id FROM meetings WHERE owner = ?)');

  function nonce(req) {
    const prefix = cookie + '=';
    const values = (req.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(prefix));
    const raw = values.length === 1 ? values[0].slice(prefix.length) : '';
    return pattern.test(raw) ? digest(raw) : null;
  }
  function seal(text, owner) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(owner));
    return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  }
  function unseal(text, owner) {
    const data = Buffer.from(text, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    cipher.setAAD(Buffer.from(owner));
    cipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString();
  }
  async function token(parameters) {
    const response = await call('https://oauth2.googleapis.com/token', {
      method: 'POST', body: new URLSearchParams({
        client_id: settings.clientId, client_secret: settings.clientSecret, ...parameters,
      }),
    });
    if (!response.ok) throw error(409, 'Google authorization was rejected. Connect the calendar again.');
    return response.json();
  }
  async function access(owner) {
    const row = credentials.get(owner);
    if (!row) throw error(409, 'Connect a Google Calendar account first.');
    let refresh;
    try { refresh = unseal(row.token, owner); }
    catch { throw error(409, 'Reconnect the calendar to restore access.'); }
    const result = await token({ grant_type: 'refresh_token', refresh_token: refresh });
    if (typeof result.access_token !== 'string' || !result.access_token) throw error(502, 'Google did not return an access token.');
    return result.access_token;
  }

  return {
    access,
    connected(owner) { return Boolean(credentials.get(owner)); },
    public(api) {
      api.get(callback, rateLimit({ ...limits, limit: 20 }), (req, res) => {
        const { state, code } = req.query;
        const session = nonce(req);
        const item = session && typeof state === 'string' && pattern.test(state) && byState.get(digest(state), Date.now());
        if (!item || item.nonce !== session || typeof code !== 'string' || !code || code.length > 1024 ||
            !submit.run(seal(code, item.owner), item.state).changes) return res.redirect(303, '/?googleCalendar=failed');
        res.redirect(303, '/?googleCalendar=complete');
      });
    },
    authenticated(api, byIdentity) {
      api.get(route, (req, res) => res.json({ connected: Boolean(credentials.get(req.identity)) }));
      api.post(route + '/start', byIdentity(8), (req, res) => {
        const browser = random();
        const state = random();
        const verifier = random();
        const now = Date.now();
        sweep.run(req.identity, now);
        start.run(digest(state), digest(browser), req.identity, verifier, now + age);
        res.cookie(cookie, browser, { ...sameSite, maxAge: age });
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: redirect, response_type: 'code',
          scope: calendarScope, access_type: 'offline', prompt: 'consent', state,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
        res.json({ url: url.href });
      });
      api.post(route + '/complete', byIdentity(8), async (req, res) => {
        const owner = req.identity;
        const browser = nonce(req);
        const item = browser && byOwner.get(browser, owner, Date.now());
        if (!item?.code) throw error(409, 'This connection expired. Start again in the same browser.');
        res.clearCookie(cookie, sameSite);
        await serial('calendar:' + owner, async () => {
          if (!remove.run(item.state).changes) throw error(409, 'This connection already finished or expired.');
          const result = await token({ grant_type: 'authorization_code', code: unseal(item.code, owner),
            code_verifier: item.verifier, redirect_uri: redirect });
          if (typeof result.refresh_token !== 'string' || !result.refresh_token || !result.scope?.split(' ').includes(calendarScope)) {
            throw error(409, 'Google did not grant calendar event access.');
          }
          const sealed = seal(result.refresh_token, owner);
          db.exec('BEGIN IMMEDIATE');
          try { unlink.run(owner); save.run(owner, sealed); db.exec('COMMIT'); }
          catch (failure) { db.exec('ROLLBACK'); throw failure; }
        });
        res.json({ connected: true });
      });
      api.delete(route, byIdentity(8), async (req, res) => {
        await serial('calendar:' + req.identity, () => {
          db.exec('BEGIN IMMEDIATE');
          try { sweep.run(req.identity, Date.now()); unlink.run(req.identity); clear.run(req.identity); db.exec('COMMIT'); }
          catch (failure) { db.exec('ROLLBACK'); throw failure; }
        });
        res.json({ connected: false });
      });
    },
  };
}
