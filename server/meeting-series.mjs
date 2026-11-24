import { createHash } from 'node:crypto';
import { z } from 'zod';

const scope = z.enum(['following', 'upcoming']);
const version = { scope, revision: z.string().regex(/^[a-f0-9]{64}$/) };

export function registerMeetingSeries(api, { db, byIdentity, meetingFor, view, serial, scheduledTime, reschedule, log, cancelScheduled, error }) {
  const route = '/meetings/:id/series';
  const members = db.prepare('SELECT * FROM meetings WHERE series_id = ? AND owner = ? ORDER BY series_index');
  const update = db.prepare(`UPDATE meetings SET title = ?, duration_minutes = ?, start_at = ?,
    calendar_revision = calendar_revision + 1 WHERE id = ?`);
  const change = z.discriminatedUnion('action', [
    z.object({ ...version, action: z.literal('cancel'), removeLinkedEvents: z.boolean().default(false) }).strict(),
    z.object({ ...version, action: z.literal('reschedule'), title: reschedule.shape.title, duration: reschedule.shape.duration,
      startTimes: z.array(z.iso.datetime()).min(1).max(52) }).strict(),
  ]);

  function organizerMeeting(req) {
    const meeting = meetingFor(req);
    if (!meeting.series_id || req.identity !== meeting.owner) throw error(404, 'Meeting series unavailable.');
    return meeting;
  }

  function snapshot(meeting, now) {
    const all = members.all(meeting.series_id, meeting.owner);
    const upcoming = all.filter(row => !row.opened_at && !row.stopped_at && row.start_at >= now - 60000);
    const revision = createHash('sha256').update(JSON.stringify([
      all.map(row => [row.id, row.calendar_revision, row.opened_at, row.stopped_at]), upcoming.map(row => row.id),
    ])).digest('hex');
    return { all, upcoming, revision };
  }

  function withMeetingLocks(ids, index, operation) {
    if (index === ids.length) return operation();
    return serial(ids[index], () => withMeetingLocks(ids, index + 1, operation));
  }

  api.get(route, (req, res) => {
    const meeting = organizerMeeting(req);
    const state = snapshot(meeting, Date.now());
    res.json({ revision: state.revision, total: state.all.length,
      meetings: state.upcoming.map(row => view(row, req.identity)) });
  });

  api.patch(route, byIdentity(16), async (req, res) => {
    const meeting = organizerMeeting(req);
    const command = change.parse(req.body);
    const result = await serial('series:' + meeting.series_id, () => {
      const ids = members.all(meeting.series_id, meeting.owner).map(row => row.id).sort();
      return withMeetingLocks(ids, 0, () => {
        const now = Date.now();
        const state = snapshot(meeting, now);
        if (state.revision !== command.revision) throw error(409, 'The series changed. Reload it before saving.');
        const affected = command.scope === 'upcoming' ? state.upcoming :
          state.upcoming.filter(row => row.series_index >= meeting.series_index);
        if (!affected.length) throw error(409, 'No unopened meetings remain in this selection.');

        const editing = command.action === 'reschedule';
        let times;
        if (editing) {
          if (command.startTimes.length !== affected.length) throw error(409, 'The submitted dates do not match the selected meetings.');
          times = command.startTimes.map(value => scheduledTime(value, now));
          const selected = new Set(affected.map(row => row.id));
          const unchanged = new Set(state.all.filter(row => !row.stopped_at && !selected.has(row.id)).map(row => row.start_at));
          if (new Set(times).size !== times.length || times.some(time => unchanged.has(time))) {
            throw error(400, 'Two occurrences would start at the same time. Adjust the proposed dates.');
          }
        }

        let calendarRemovals = 0;
        db.exec('BEGIN IMMEDIATE');
        try {
          affected.forEach((row, index) => {
            if (editing) update.run(command.title, command.duration, times[index], row.id);
            else calendarRemovals += cancelScheduled(row.id, now, command.removeLinkedEvents);
            log.run(row.id, req.identity, command.action + '-series', meeting.series_id, now);
          });
          db.exec('COMMIT');
        } catch (failure) { db.exec('ROLLBACK'); throw failure; }
        const after = snapshot(meeting, now);
        return { updated: affected.length, meetings: after.upcoming.map(row => view(row, req.identity)),
          ...(calendarRemovals ? { calendarRemovals } : {}) };
      });
    });
    res.json(result);
  });
}
