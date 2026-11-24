import { z } from 'zod';
import { breakoutEmail } from './breakout-identity.mjs';

const plan = z.object({
  names: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
  selfSelect: z.boolean(),
  durationMinutes: z.number().int().min(1).max(120).nullable(),
  assignments: z.array(z.object({ email: breakoutEmail, room: z.number().int().min(0).max(7) }).strict()).max(99).optional(),
}).strict().refine(value => new Set(value.names.map(name => name.toLowerCase())).size === value.names.length,
  { message: 'Breakout room names must be distinct.' })
  .refine(value => !value.assignments || (value.assignments.every(entry => entry.room < value.names.length) &&
    new Set(value.assignments.map(entry => entry.email)).size === value.assignments.length),
  { message: 'Assign each email address to one of the planned rooms.' });

export function registerBreakoutPlans(api, { db, byIdentity, meetingFor, serial, error }) {
  const route = '/meetings/:id/breakout-plan';
  const read = db.prepare('SELECT plan FROM meeting_breakout_plans WHERE meeting = ?');
  const save = db.prepare(`INSERT INTO meeting_breakout_plans(meeting, plan) VALUES(?, ?)
    ON CONFLICT(meeting) DO UPDATE SET plan = excluded.plan`);
  const remove = db.prepare('DELETE FROM meeting_breakout_plans WHERE meeting = ?');
  const body = z.object({ plan: plan.nullable() }).strict();

  function load(id) {
    const row = read.get(id);
    return row ? JSON.parse(row.plan) : null;
  }

  function requireOwner(req) {
    const current = meetingFor(req);
    if (req.identity !== current.owner || current.encrypted) throw error(404, 'Breakout plan unavailable.');
    return current;
  }

  api.get(route, (req, res) => res.json({ plan: load(requireOwner(req).id) }));
  api.patch(route, byIdentity(20), async (req, res) => {
    const id = requireOwner(req).id;
    const input = body.parse(req.body);
    const saved = await serial(id, () => {
      const current = requireOwner(req);
      if (current.opened_at || current.stopped_at) throw error(409, 'Edit the plan before opening the meeting.');
      if (input.plan) save.run(id, JSON.stringify(input.plan));
      else remove.run(id);
      return load(id);
    });
    res.json({ plan: saved });
  });
  return load;
}
