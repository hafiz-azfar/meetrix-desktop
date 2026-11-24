const retryInterval = 3 * 60_000;
const attemptLimit = 6;

export function calendarRemovalQueue(db) {
  const enqueue = db.prepare(`
    INSERT OR IGNORE INTO calendar_removals(meeting, provider, next_at)
    SELECT meeting, 'google', ? FROM google_calendar_events WHERE meeting = ?
    UNION ALL
    SELECT meeting, 'outlook', ? FROM outlook_events WHERE meeting = ?
  `);
  const due = db.prepare(`
    SELECT r.meeting AS id, m.owner, r.attempts FROM calendar_removals r JOIN meetings m ON m.id = r.meeting
    WHERE r.provider = ? AND r.status = 'pending' AND r.next_at <= ?
    ORDER BY r.next_at, r.meeting LIMIT 8
  `);
  const pending = db.prepare("SELECT 1 FROM calendar_removals WHERE meeting = ? AND provider = ? AND status = 'pending'");
  const status = db.prepare('SELECT provider, status FROM calendar_removals WHERE meeting = ? ORDER BY provider');
  const settle = db.prepare("UPDATE calendar_removals SET status = ? WHERE meeting = ? AND provider = ? AND status = 'pending'");
  const retry = db.prepare(`
    UPDATE calendar_removals SET attempts = attempts + 1, next_at = ?
    WHERE meeting = ? AND provider = ? AND status = 'pending'
  `);
  const detach = db.prepare(`
    UPDATE calendar_removals SET status = 'attention' WHERE provider = ? AND status = 'pending'
      AND meeting IN (SELECT id FROM meetings WHERE owner = ?)
  `);
  return {
    enqueue(id, now) { return Number(enqueue.run(now, id, now, id).changes); },
    status(id) { return status.all(id); },
    pending(provider, id) { return Boolean(pending.get(id, provider)); },
    removed(provider, id) { settle.run('removed', id, provider); },
    detach(provider, owner) { detach.run(provider, owner); },
    async drain(provider, removeEvent, closed) {
      for (const { id, owner, attempts } of due.all(provider, Date.now())) {
        if (closed()) return;
        try { await removeEvent(owner, id); }
        catch (failure) {
          if (closed()) return;
          if (failure?.status === 409 || attempts + 1 >= attemptLimit) settle.run('attention', id, provider);
          else retry.run(Date.now() + retryInterval * 2 ** attempts, id, provider);
        }
      }
    },
  };
}
