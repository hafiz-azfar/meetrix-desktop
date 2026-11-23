import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

const requestLifetime = 5 * 60 * 1000;
const sessionLifetime = 12 * 60 * 60 * 1000;
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const requestIdPattern = /^[A-Za-z0-9_-]{22}$/;
const opaque = z.string().regex(tokenPattern);
const startBody = z.object({ challenge: opaque }).strict();
const approveBody = z.object({
  code: z.string().trim().max(20).transform(code => code.toUpperCase().replace(/[ -]/g, ''))
    .pipe(z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/)),
}).strict();
const claimBody = z.object({ verifier: opaque }).strict();

function digest(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function matches(left, right) {
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function fail(res, status, error) {
  return res.status(status).json({ error });
}

export function createDesktopAuth({ db, origin, scope, limitOptions }) {
  const router = Router();
  const secure = new URL(origin).protocol === 'https:';
  const cookieName = secure ? '__Host-meetrix-auth' : 'meetrix_auth';
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure, path: '/' };
  const getRequest = db.prepare('SELECT * FROM desktop_sign_ins WHERE id = ? AND expires_at > ?');
  const getSession = db.prepare('SELECT identity, name, expires_at, kind FROM desktop_sessions WHERE credential = ? AND expires_at > ?');
  const login = db.prepare('INSERT INTO desktop_sessions(credential, identity, name, expires_at, kind) VALUES (?, ?, ?, ?, ?)');
  const deleteRequest = db.prepare('DELETE FROM desktop_sign_ins WHERE id = ?');
  const revoke = db.prepare('DELETE FROM desktop_sessions WHERE credential = ?');
  const expireRequests = db.prepare('DELETE FROM desktop_sign_ins WHERE expires_at <= ?');
  const expireSessions = db.prepare('DELETE FROM desktop_sessions WHERE expires_at <= ?');

  function cookie(req) {
    const prefix = cookieName + '=';
    const candidates = (req.get('cookie') || '').split(';').map(field => field.trim()).filter(field => field.startsWith(prefix));
    const token = candidates.length === 1 ? candidates[0].slice(prefix.length) : '';
    return tokenPattern.test(token) ? digest(token) : null;
  }

  function session(req) {
    const credential = cookie(req);
    const row = credential ? getSession.get(credential, Date.now()) : null;
    return row?.identity.startsWith(scope) ? row : null;
  }

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function issue(req, res, account, kind, consumedRequest) {
    const token = randomBytes(32).toString('base64url');
    const prior = cookie(req);
    transaction(() => {
      if (consumedRequest) deleteRequest.run(consumedRequest);
      if (prior) revoke.run(prior);
      login.run(digest(token), account.identity, account.name, Date.now() + sessionLifetime, kind);
    });
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionLifetime });
  }

  function sweep() {
    const now = Date.now();
    expireRequests.run(now);
    expireSessions.run(now);
  }

  function user(row) {
    return row ? { id: row.identity, fullName: row.name } : null;
  }

  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('origin') !== origin) {
      return fail(res, 403, 'This sign-in request comes from a different origin.');
    }
    next();
  });
  router.param('id', (_req, res, next, id) => {
    if (!requestIdPattern.test(id)) return fail(res, 404, 'Sign-in request not found.');
    next();
  });

  router.get('/session', (req, res) => res.json({ user: user(session(req)) }));

  router.post('/requests', rateLimit({ ...limitOptions, limit: 12 }), (req, res) => {
    const { challenge } = startBody.parse(req.body);
    const id = randomBytes(16).toString('base64url');
    const code = Array.from(randomBytes(8), byte => codeAlphabet[byte & 31]).join('');
    const expiresAt = Date.now() + requestLifetime;
    db.prepare('INSERT INTO desktop_sign_ins(id, challenge, code, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, challenge, digest(id + ':' + code), expiresAt);
    res.status(201).json({ id, code: code.slice(0, 4) + '-' + code.slice(4), expiresAt });
  });

  router.post('/requests/:id/approve', rateLimit({ ...limitOptions, limit: 20 }), (req, res) => {
    const { code } = approveBody.parse(req.body);
    const browser = session(req);
    if (browser?.kind !== 'browser') return fail(res, 401, 'Sign in with InsForge in your browser to approve this request.');
    const now = Date.now();
    const row = getRequest.get(req.params.id, now);
    if (!row || row.identity || row.attempts >= 6) return fail(res, 410, 'This sign-in request has expired. Start again in Meetrix.');
    if (!matches(row.code, digest(row.id + ':' + code))) {
      db.prepare('UPDATE desktop_sign_ins SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      return fail(res, 403, 'The code does not match the one shown in Meetrix.');
    }
    db.prepare('UPDATE desktop_sign_ins SET identity = ?, name = ? WHERE id = ?').run(browser.identity, browser.name, row.id);
    res.json({ ok: true });
  });

  router.post('/requests/:id/claim', rateLimit({ ...limitOptions, limit: 230 }), (req, res) => {
    const { verifier } = claimBody.parse(req.body);
    const now = Date.now();
    const row = getRequest.get(req.params.id, now);
    if (!row || !matches(row.challenge, digest(verifier)) || row.attempts >= 6) {
      return fail(res, 410, 'This sign-in request has expired. Start again in Meetrix.');
    }
    if (!row.identity) return res.status(202).json({ pending: true });
    if (!row.identity.startsWith(scope)) return fail(res, 410, 'Start sign-in again in Meetrix.');
    issue(req, res, row, 'desktop', row.id);
    res.json({ user: user(row) });
  });

  router.post('/sign-out', (req, res) => {
    const credential = cookie(req);
    if (credential) revoke.run(credential);
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });

  return { router, session, sweep, issue };
}
