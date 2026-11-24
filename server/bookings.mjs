import { randomBytes } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{16}$/);
const publication = z.object({
  title: z.string().trim().min(1).max(100),
  ownerName: z.string().trim().min(1).max(60),
  duration: z.literal([15, 30, 45, 60]),
  slots: z.array(z.iso.datetime()).min(1).max(20),
}).strict();
const reservation = z.object({ slot: idSchema, name: z.string().trim().min(1).max(60) }).strict();
const minute = 60_000;

export function bookingRoutes(db, origin, limits) {
  const ref = () => randomBytes(12).toString('base64url');
  const pages = db.prepare('SELECT * FROM booking_pages WHERE owner = ? AND active = 1 ORDER BY created_at DESC');
  const page = db.prepare('SELECT * FROM booking_pages WHERE id = ? AND active = 1');
  const slots = db.prepare('SELECT * FROM booking_slots WHERE page = ? ORDER BY start_at');
  const addPage = db.prepare('INSERT INTO booking_pages(id, owner, owner_name, title, duration, created_at) VALUES(?, ?, ?, ?, ?, ?)');
  const addSlot = db.prepare('INSERT INTO booking_slots(id, page, start_at) VALUES(?, ?, ?)');
  const findSlot = db.prepare('SELECT * FROM booking_slots WHERE page = ? AND id = ?');
  const disable = db.prepare('UPDATE booking_pages SET active = 0 WHERE owner = ? AND id = ? AND active = 1');
  const clear = db.prepare('DELETE FROM booking_slots WHERE page = ? AND meeting IS NULL');
  const makeMeeting = db.prepare('INSERT INTO meetings(id, owner, owner_name, title, start_at, duration_minutes, created_at, lobby, allow_guests) VALUES(?, ?, ?, ?, ?, ?, ?, 1, 1)');
  const claimSlot = db.prepare('UPDATE booking_slots SET meeting = ?, guest_name = ? WHERE id = ? AND meeting IS NULL');
  const conflicts = db.prepare('SELECT 1 FROM meetings WHERE owner = ? AND stopped_at IS NULL AND start_at < ? AND start_at + duration_minutes * 60000 > ? LIMIT 1');

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function snapshot(value, owner = false) {
    const now = Date.now();
    const entries = slots.all(value.id);
    return {
      id: value.id, title: value.title, ownerName: value.owner_name, duration: value.duration,
      slots: (owner ? entries : entries.filter(slot => !slot.meeting && slot.start_at > now + 5 * minute &&
        !conflicts.get(value.owner, slot.start_at + value.duration * minute, slot.start_at)))
        .map(slot => ({
          id: slot.id, startAt: slot.start_at, ...(owner ? { meeting: slot.meeting, guestName: slot.guest_name } : {}),
        })),
    };
  }
  const missing = res => res.status(404).json({ error: 'This booking page is unavailable.' });

  return {
    public(api) {
      api.get('/bookings/:id', rateLimit({ ...limits, limit: 60 }), (req, res) => {
        const result = idSchema.safeParse(req.params.id).success && page.get(req.params.id);
        return result ? res.json(snapshot(result)) : missing(res);
      });
      api.post('/bookings/:id', rateLimit({ ...limits, limit: 10 }), (req, res) => {
        if (req.get('origin') !== origin) return res.status(403).json({ error: 'This origin is not allowed.' });
        if (!idSchema.safeParse(req.params.id).success) return missing(res);
        const { slot, name } = reservation.parse(req.body);
        const result = transaction(() => {
          const current = page.get(req.params.id);
          if (!current) return { missing: true };
          const chosen = findSlot.get(current.id, slot);
          const now = Date.now();
          if (!chosen || chosen.meeting || chosen.start_at <= now + 5 * minute ||
              conflicts.get(current.owner, chosen.start_at + current.duration * minute, chosen.start_at)) return null;
          const id = ref();
          makeMeeting.run(id, current.owner, current.owner_name, current.title, chosen.start_at, current.duration, now);
          claimSlot.run(id, name, chosen.id);
          return { id, title: current.title, startAt: chosen.start_at, duration: current.duration };
        });
        if (result?.missing) return missing(res);
        if (!result) return res.status(409).json({ error: 'That time is no longer available. Choose another time.' });
        res.status(201).json(result);
      });
    },
    owner(api, byIdentity) {
      api.get('/workspace/bookings', (req, res) => res.json(pages.all(req.identity).map(value => snapshot(value, true))));
      api.post('/workspace/bookings', byIdentity(10), (req, res) => {
        const input = publication.parse(req.body);
        const times = input.slots.map(Date.parse).sort((a, b) => a - b);
        const now = Date.now();
        if (times.some((time, index) => time <= now + 5 * minute || time > now + 180 * 1440 * minute ||
            (index > 0 && time < times[index - 1] + input.duration * minute))) {
          return res.status(400).json({ error: 'Choose separate start times between 5 minutes and 180 days from now.' });
        }
        const result = transaction(() => {
          if (pages.all(req.identity).length >= 20) return null;
          const id = ref();
          addPage.run(id, req.identity, input.ownerName, input.title, input.duration, now);
          for (const time of times) addSlot.run(ref(), id, time);
          return snapshot(page.get(id), true);
        });
        if (!result) return res.status(409).json({ error: 'You already have 20 active booking pages.' });
        res.status(201).json(result);
      });
      api.delete('/workspace/bookings/:id', byIdentity(12), (req, res) => {
        if (!idSchema.safeParse(req.params.id).success) return missing(res);
        const removed = transaction(() => {
          if (!disable.run(req.identity, req.params.id).changes) return false;
          clear.run(req.params.id);
          return true;
        });
        return removed ? res.json({ ok: true }) : missing(res);
      });
    },
  };
}
