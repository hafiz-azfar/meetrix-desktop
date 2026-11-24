import { createHash, randomBytes } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { meetingCalendar } from './calendar.mjs';

const subscriptionPath = '/workspace/calendar-feed';
const digest = value => createHash('sha256').update(value).digest('hex');

export function calendarFeedRoutes(db, origin, limits) {
  const enabled = new URL(origin).protocol === 'https:';
  const findOwner = db.prepare('SELECT owner FROM calendar_feeds WHERE token_hash = ?');
  const ownerFeed = db.prepare('SELECT 1 FROM calendar_feeds WHERE owner = ?');
  const save = db.prepare('INSERT INTO calendar_feeds(owner, token_hash) VALUES(?, ?) ON CONFLICT(owner) DO UPDATE SET token_hash = excluded.token_hash');
  const remove = db.prepare('DELETE FROM calendar_feeds WHERE owner = ?');
  const meetings = db.prepare(
    'SELECT id, title, start_at AS startAt, duration_minutes AS duration FROM meetings WHERE owner = ? AND stopped_at IS NULL AND start_at + duration_minutes * 60000 >= ? ORDER BY start_at LIMIT 200',
  );
  return {
    public(api) {
      api.get('/calendar/:token.ics', rateLimit({ ...limits, limit: 120 }), (req, res) => {
        const { token } = req.params;
        const row = enabled && /^[A-Za-z0-9_-]{43}$/.test(token) && findOwner.get(digest(token));
        if (!row) return res.status(404).json({ error: 'Calendar subscription unavailable.' });
        res.set({
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'inline; filename="meetrix.ics"',
          'Referrer-Policy': 'no-referrer',
          'X-Robots-Tag': 'noindex, nofollow',
        }).send(meetingCalendar(meetings.all(row.owner, Date.now()), origin));
      });
    },
    owner(api, byIdentity) {
      api.get(subscriptionPath, (req, res) => res.json({ available: enabled, active: Boolean(ownerFeed.get(req.identity)) }));
      api.post(subscriptionPath, byIdentity(8), (req, res) => {
        if (!enabled) return res.status(409).json({ error: 'Calendar subscriptions require a hosted HTTPS workspace.' });
        const token = randomBytes(32).toString('base64url');
        save.run(req.identity, digest(token));
        res.status(201).json({ url: new URL('/api/calendar/' + token + '.ics', origin).href });
      });
      api.delete(subscriptionPath, byIdentity(8), (req, res) => {
        remove.run(req.identity);
        res.json({ ok: true });
      });
    },
  };
}
