import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createGoogleOAuth } from './google-calendar-oauth.mjs';

const route = '/meetings/:id/google-calendar';
const directionSchema = z.object({ direction: z.enum(['push', 'pull']) }).strict();
const etag = value => typeof value === 'string' && value.length <= 256 && /^"[^"\r\n]+"$/.test(value);

export function googleCalendarRoutes({ db, origin, settings, limits, error, serial, scheduledTime, request = fetch }) {
  if (!settings) return null;
  const find = db.prepare('SELECT * FROM meetings WHERE id = ? AND owner = ?');
  const link = db.prepare('SELECT event, etag FROM google_calendar_events WHERE meeting = ?');
  const save = db.prepare('INSERT INTO google_calendar_events(meeting, event, etag) VALUES(?, ?, ?) ON CONFLICT(meeting) DO UPDATE SET etag=excluded.etag');
  const revise = db.prepare('UPDATE meetings SET title = ?, start_at = ?, duration_minutes = ? WHERE id = ?');
  const audit = db.prepare('INSERT INTO audit(meeting, actor, event, subject, created_at) VALUES(?, ?, ?, NULL, ?)');

  async function call(url, options) {
    try { return await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw error(502, 'Google Calendar could not be reached.'); }
  }
  const oauth = createGoogleOAuth({ db, origin, settings, limits, error, serial, call });

  async function event(token, method, id, body, match) {
    const endpoint = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
    const response = await call(endpoint + (id ? '/' + id : '') + (method === 'GET' ? '' : '?sendUpdates=none'), {
      method,
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(match ? { 'If-Match': match } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 404 && method === 'GET') return null;
    if ([409, 412].includes(response.status)) throw error(409, 'The Google event changed. Pull the changes before pushing again.');
    if (!response.ok) throw error(502, 'Google Calendar could not complete the event request.');
    return response.json();
  }

  async function sync(owner, id, direction) {
    const meeting = find.get(id, owner);
    if (!meeting) throw error(404, 'Meeting not found.');
    if (meeting.opened_at || meeting.stopped_at) throw error(409, 'Only unopened meetings can be synchronized.');
    const existing = link.get(id);
    const eventId = existing?.event || createHash('sha256').update(origin + ':' + id).digest('hex');
    if (direction === 'pull' && !existing) throw error(409, 'Publish this meeting to Google Calendar first.');
    const token = await oauth.access(owner);
    const remote = await event(token, 'GET', eventId);
    if (remote && (remote.extendedProperties?.private?.meetrixEvent !== eventId || !etag(remote.etag))) {
      throw error(409, 'The Google event is no longer linked to this meeting.');
    }
    if (remote?.status === 'cancelled') throw error(409, 'The linked Google event was canceled.');
    if (direction === 'pull') {
      if (!remote || remote.recurrence?.length || !remote.start?.dateTime || !remote.end?.dateTime) {
        throw error(409, 'The linked Google event must be a single timed event.');
      }
      const startAt = scheduledTime(remote.start.dateTime, Date.now());
      const duration = (Date.parse(remote.end.dateTime) - startAt) / 60_000;
      const title = typeof remote.summary === 'string' ? remote.summary.trim() : '';
      if (!Number.isSafeInteger(duration) || duration < 15 || duration > 1800 || !title || title.length > 100) {
        throw error(400, 'Google events need a title up to 100 characters and a duration between 15 minutes and 30 hours.');
      }
      db.exec('BEGIN IMMEDIATE');
      try { revise.run(title, startAt, duration, id); save.run(id, eventId, remote.etag); db.exec('COMMIT'); }
      catch (failure) { db.exec('ROLLBACK'); throw failure; }
    } else {
      if (remote && existing && remote.etag !== existing.etag) throw error(409, 'The Google event changed. Pull those changes before pushing again.');
      const fields = {
        summary: meeting.title,
        start: { dateTime: new Date(meeting.start_at).toISOString() },
        end: { dateTime: new Date(meeting.start_at + meeting.duration_minutes * 60_000).toISOString() },
      };
      const updated = remote
        ? await event(token, 'PATCH', eventId, fields, remote.etag)
        : await event(token, 'POST', null, {
          id: eventId, ...fields, description: 'Join in Meetrix: ' + new URL('/join?m=' + id, origin),
          extendedProperties: { private: { meetrixEvent: eventId } },
        });
      if (!etag(updated.etag)) throw error(502, 'Google Calendar did not confirm the event update.');
      save.run(id, eventId, updated.etag);
    }
    audit.run(id, owner, 'calendar-' + direction, Date.now());
    return { linked: true };
  }
  return {
    public: oauth.public,
    authenticated(api, byIdentity) {
      oauth.authenticated(api, byIdentity);
      api.get(route, (req, res) => {
        if (!find.get(req.params.id, req.identity)) throw error(404, 'Meeting not found.');
        res.json({ linked: Boolean(link.get(req.params.id)), connected: oauth.connected(req.identity) });
      });
      api.post(route, byIdentity(25), async (req, res) => {
        const { direction } = directionSchema.parse(req.body);
        const id = req.params.id;
        const owner = req.identity;
        res.json(await serial('calendar:' + owner, () => serial(id, () => sync(owner, id, direction))));
      });
    },
  };
}
