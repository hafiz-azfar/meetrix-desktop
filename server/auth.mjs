import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createClient } from '@insforge/sdk';
import { z } from 'zod';

const lifetime = 5 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const knownNames = { google: 'Google', github: 'GitHub', apple: 'Apple', discord: 'Discord', linkedin: 'LinkedIn',
  facebook: 'Facebook', microsoft: 'Microsoft', x: 'X', gitlab: 'GitLab', spotify: 'Spotify' };
const providerKey = z.string().regex(/^[a-z0-9_-]{1,50}$/);
const start = z.object({ provider: providerKey, next: z.string().max(140) }).strict();
const email = z.email().max(254);
const send = z.object({ email }).strict();
const verify = z.object({ email, otp: z.string().regex(/^\d{6}$/) }).strict();
const login = z.object({ email, password: z.string().min(1).max(256) }).strict();

export function insforgeSettings(baseUrl, anonKey) {
  if (!baseUrl) throw new Error('Set INSFORGE_URL to your InsForge project URL.');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.href !== url.origin + '/') throw new Error('INSFORGE_URL must be an HTTPS origin.');
  if (anonKey) {
    const encoded = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(anonKey)?.[2];
    let role;
    try { role = JSON.parse(Buffer.from(encoded ?? '', 'base64url').toString('utf8')).role; } catch { /* Reject invalid keys. */ }
    if (role !== 'anon') throw new Error('Use an InsForge ANON_KEY for this application.');
  }
  return { insforgeUrl: url.origin, insforgeAnonKey: anonKey };
}

export function authenticationScope(insforgeUrl) {
  return 'insforge_' + createHash('sha256').update(insforgeUrl).digest('hex').slice(0, 20) + '_';
}

function accountOf(user, scope) {
  if (!user || typeof user.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(user.id)) return null;
  const name = [user.profile?.name, user.name].find(value => typeof value === 'string' && value.trim());
  return { identity: scope + user.id.toLowerCase(), name: name?.trim().slice(0, 60) || 'Participant' };
}

function returnPath(input, origin) {
  if (!URL.canParse(input, origin)) return '/';
  const url = new URL(input, origin);
  if (url.origin !== origin) return '/';
  if (url.pathname === '/desktop-sign-in' && /^[A-Za-z0-9_-]{22}$/.test(url.searchParams.get('request') || '')) {
    return '/desktop-sign-in?request=' + url.searchParams.get('request');
  }
  if (url.pathname === '/join' && /^[A-Za-z0-9_-]{16}$/.test(url.searchParams.get('m') || '')) {
    return '/join?m=' + url.searchParams.get('m');
  }
  return '/';
}

export function createInsforgeAuth({ db, origin, insforgeUrl, insforgeAnonKey, sessions, limitOptions, createAuth }) {
  const router = Router();
  const scope = authenticationScope(insforgeUrl);
  const client = createAuth ?? (accessToken => createClient({
    baseUrl: insforgeUrl, anonKey: insforgeAnonKey, accessToken, isServerMode: true, timeout: 8000,
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
  }).auth);
  const secure = new URL(origin).protocol === 'https:';
  const cookieName = secure ? '__Host-meetrix-oauth' : 'meetrix_oauth';
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure, path: '/' };
  const insert = db.prepare('INSERT INTO oauth_requests(id, verifier, return_to, expires_at) VALUES (?, ?, ?, ?)');
  const consume = db.prepare('DELETE FROM oauth_requests WHERE id = ? AND expires_at > ? RETURNING verifier, return_to');
  const expire = db.prepare('DELETE FROM oauth_requests WHERE expires_at <= ?');
  let cache;

  async function capabilities() {
    if (cache && cache.expires > Date.now()) return cache.value;
    const { data, error } = await client().getPublicAuthConfig();
    if (error || !data) throw new Error('InsForge configuration could not be loaded.');
    const entries = (Array.isArray(data.oAuthProviders) ? data.oAuthProviders : []).filter(key => providerKey.safeParse(key).success)
      .map(key => [key, knownNames[key] ?? key]);
    for (const provider of Array.isArray(data.customOAuthProviders) ? data.customOAuthProviders : []) {
      if (providerKey.safeParse(provider?.key).success && typeof provider.name === 'string' && provider.name.trim()) {
        entries.push([provider.key, provider.name.trim().slice(0, 50)]);
      }
    }
    const value = { providers: [...new Map(entries)].map(([key, name]) => ({ key, name })),
      emailOtp: data.allowEmailOtp === true, emailPassword: data.allowEmailPassword !== false };
    cache = { value, expires: Date.now() + 60000 };
    return value;
  }

  const restrict = limit => rateLimit({ ...limitOptions, limit });
  router.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && req.get('origin') !== origin) {
      return res.status(403).json({ error: 'This origin is not allowed.' });
    }
    next();
  });
  router.get('/methods', async (_req, res) => {
    try { res.json(await capabilities()); }
    catch { return res.status(502).json({ error: 'Could not load sign-in methods from InsForge.' }); }
  });

  router.post('/oauth', restrict(12), async (req, res) => {
    const { provider, next } = start.parse(req.body);
    let methods;
    try { methods = await capabilities(); }
    catch { return res.status(502).json({ error: 'Could not reach InsForge. Try again.' }); }
    if (!methods.providers.some(item => item.key === provider)) return res.status(400).json({ error: 'This sign-in provider is unavailable.' });
    const nonce = randomBytes(32).toString('base64url');
    const callback = new URL('/api/auth/callback', origin);
    callback.searchParams.set('meetrix_state', nonce);
    const { data, error } = await client().signInWithOAuth(provider, { redirectTo: callback.href, skipBrowserRedirect: true });
    const redirect = URL.canParse(data?.url) ? new URL(data.url) : null;
    if (error || redirect?.protocol !== 'https:' || redirect.username || redirect.password || !tokenPattern.test(data?.codeVerifier || '')) {
      return res.status(502).json({ error: 'InsForge could not start this sign-in. Try again.' });
    }
    insert.run(nonce, data.codeVerifier, returnPath(next, origin), Date.now() + lifetime);
    res.cookie(cookieName, nonce, { ...cookieOptions, maxAge: lifetime });
    res.json({ url: redirect.href });
  });

  router.get('/callback', restrict(30), async (req, res) => {
    const { meetrix_state: state, insforge_code: code } = req.query;
    const prefix = cookieName + '=';
    const matches = (req.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(prefix));
    if (typeof state !== 'string' || !tokenPattern.test(state) || matches.length !== 1 || matches[0] !== prefix + state) {
      return res.redirect(303, '/?auth_error=expired');
    }
    res.clearCookie(cookieName, cookieOptions);
    const flow = consume.get(state, Date.now());
    if (!flow) return res.redirect(303, '/?auth_error=expired');
    const target = new URL(flow.return_to, origin);
    const fail = () => {
      target.searchParams.set('auth_error', 'oauth');
      res.redirect(303, target.pathname + target.search);
    };
    if (typeof code !== 'string' || code.length < 1 || code.length > 1024) return fail();
    const { data, error } = await client().exchangeOAuthCode(code, flow.verifier);
    const account = accountOf(data?.user, scope);
    if (error || !account || !data.accessToken) return fail();
    sessions.issue(req, res, account, 'browser');
    res.redirect(303, target.pathname + target.search);
  });

  router.post('/email/send', restrict(10), async (req, res) => {
    const input = send.parse(req.body);
    const { error } = await client().signInWithOtp(input);
    if (error) return res.status(400).json({ error: 'Could not send an email code. Check your address and try again.' });
    res.json({ ok: true });
  });

  router.post('/email/verify', restrict(15), async (req, res) => {
    const input = verify.parse(req.body);
    const { data, error } = await client().verifyOtp(input);
    const account = accountOf(data?.user, scope);
    if (error || !account || !data.accessToken) return res.status(401).json({ error: 'The sign-in code is invalid or expired.' });
    sessions.issue(req, res, account, 'browser');
    res.json({ ok: true });
  });

  router.post('/email/password', restrict(12), async (req, res) => {
    const input = login.parse(req.body);
    const { data, error } = await client().signInWithPassword(input);
    const account = accountOf(data?.user, scope);
    if (error || !account || !data.accessToken) return res.status(401).json({ error: 'The email or password could not be verified.' });
    sessions.issue(req, res, account, 'browser');
    res.json({ ok: true });
  });

  async function currentIdentity(token) {
    const { data, error } = await client(token).getCurrentUser();
    const account = accountOf(data?.user, scope);
    if (error || !account) throw new Error('Session could not be verified.');
    return account.identity;
  }

  return { router, currentIdentity, sweep: () => expire.run(Date.now()) };
}
