import { createHash } from 'node:crypto';

const interval = 3 * 60_000;
const inactive = { enabled: false, status: null };
export const meetingFields = meeting => ({ title: meeting.title, startAt: meeting.start_at, duration: meeting.duration_minutes });
const fingerprint = fields => createHash('sha256').update(JSON.stringify([fields.title, fields.startAt, fields.duration])).digest('hex');

export function calendarAutomation(db, provider, error) {
  const row = db.prepare('SELECT provider, baseline, status, updated_at AS updatedAt FROM calendar_automation WHERE meeting = ?');
  const count = db.prepare(`
    SELECT count(*) AS total FROM calendar_automation a JOIN meetings m ON m.id = a.meeting
    WHERE m.owner = ? AND m.opened_at IS NULL AND m.stopped_at IS NULL AND m.start_at > ?
  `);
  const insert = db.prepare('INSERT INTO calendar_automation(meeting, provider, baseline, next_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?)');
  const refresh = db.prepare('UPDATE calendar_automation SET baseline = ?, next_at = ?, updated_at = ?, status = ? WHERE meeting = ? AND provider = ?');
  const mark = db.prepare('UPDATE calendar_automation SET next_at = ?, updated_at = ?, status = ? WHERE meeting = ? AND provider = ?');
  const remove = db.prepare('DELETE FROM calendar_automation WHERE meeting = ? AND provider = ?');
  const dropOwner = db.prepare('DELETE FROM calendar_automation WHERE provider = ? AND meeting IN (SELECT id FROM meetings WHERE owner = ?)');
  const pending = db.prepare(`
    SELECT a.meeting AS id, m.owner FROM calendar_automation a JOIN meetings m ON m.id = a.meeting
    WHERE a.provider = ? AND a.status <> 'conflict' AND a.next_at <= ?
      AND m.opened_at IS NULL AND m.stopped_at IS NULL AND m.start_at > ?
    ORDER BY a.next_at LIMIT 8
  `);
  const status = id => {
    const found = row.get(id);
    return found?.provider === provider ? { enabled: true, status: found.status, updatedAt: found.updatedAt } : inactive;
  };
  function settled(id, fields) {
    const now = Date.now();
    refresh.run(fingerprint(fields), now + interval, now, 'synced', id, provider);
  }
  function failed(id, reason) {
    const now = Date.now();
    mark.run(now + interval, now, reason?.status === 409 || reason?.status === 400 ? 'conflict' : 'unavailable', id, provider);
  }
  return {
    status, settled, failed,
    same(left, right) { return fingerprint(left) === fingerprint(right); },
    enable(owner, id, fields) {
      const existing = row.get(id);
      if (existing?.provider !== provider && existing) throw error(409, 'Another calendar already synchronizes this meeting.');
      if (!existing) {
        const now = Date.now();
        if (count.get(owner, now).total >= 50) throw error(409, 'Automatic sync supports up to 50 upcoming meetings per organizer.');
        insert.run(id, provider, fingerprint(fields), now + interval, now, 'synced');
      } else settled(id, fields);
      return status(id);
    },
    disable(id) {
      remove.run(id, provider);
      return inactive;
    },
    removeOwner(owner) { dropOwner.run(provider, owner); },
    due() { const now = Date.now(); return pending.all(provider, now, now); },
    direction(id, local, remote) {
      const existing = row.get(id);
      if (existing?.provider !== provider || existing.status === 'conflict') return null;
      const localHash = fingerprint(local);
      const remoteHash = fingerprint(remote);
      if (localHash === remoteHash) return 'unchanged';
      if (existing.baseline === remoteHash) return 'push';
      if (existing.baseline === localHash) return 'pull';
      throw error(409, 'Both copies of the event changed. Choose which version to keep.');
    },
  };
}
