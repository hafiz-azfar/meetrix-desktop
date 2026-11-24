import { createHash, randomBytes } from 'node:crypto';

const keyDigest = value => createHash('sha256').update(value).digest('hex');

export function breakoutStore(db) {
  const active = db.prepare('SELECT id, name FROM breakout_rooms WHERE meeting = ? AND closed_at IS NULL ORDER BY position');
  const members = db.prepare('SELECT identity FROM breakout_members WHERE room = ? ORDER BY identity');
  const assigned = db.prepare(`
    SELECT breakout_rooms.id, breakout_rooms.name FROM breakout_rooms
    JOIN breakout_members ON breakout_members.room = breakout_rooms.id
    WHERE breakout_rooms.meeting = ? AND breakout_rooms.closed_at IS NULL AND breakout_members.identity = ?
  `);
  const assignedUncleaned = db.prepare(`
    SELECT breakout_rooms.id FROM breakout_rooms
    JOIN breakout_members ON breakout_members.room = breakout_rooms.id
    WHERE breakout_rooms.meeting = ? AND breakout_rooms.cleaned_at IS NULL AND breakout_members.identity = ?
  `);
  const insertRoom = db.prepare('INSERT INTO breakout_rooms(id, meeting, name, position) VALUES(?, ?, ?, ?)');
  const insertMember = db.prepare('INSERT INTO breakout_members(room, identity) VALUES(?, ?)');
  const removeMember = db.prepare('DELETE FROM breakout_members WHERE identity = ? AND room IN (SELECT id FROM breakout_rooms WHERE meeting = ?)');
  const removeActiveMember = db.prepare(`DELETE FROM breakout_members WHERE identity = ?
    AND room IN (SELECT id FROM breakout_rooms WHERE meeting = ? AND closed_at IS NULL)`);
  const selectionEnabled = db.prepare('SELECT 1 FROM breakout_choice_sets WHERE meeting = ?');
  const enableSelection = db.prepare('INSERT INTO breakout_choice_sets(meeting) VALUES (?)');
  const disableSelection = db.prepare('DELETE FROM breakout_choice_sets WHERE meeting = ?');
  const readDeadline = db.prepare('SELECT closes_at AS closesAt FROM breakout_deadlines WHERE meeting = ?');
  const saveDeadline = db.prepare(`INSERT INTO breakout_deadlines(meeting, closes_at) VALUES (?, ?)
    ON CONFLICT(meeting) DO UPDATE SET closes_at = min(breakout_deadlines.closes_at, excluded.closes_at)`);
  const clearDeadline = db.prepare('DELETE FROM breakout_deadlines WHERE meeting = ?');
  const dueDeadlines = db.prepare('SELECT meeting FROM breakout_deadlines WHERE closes_at <= ? ORDER BY closes_at LIMIT 50');
  const closeRooms = db.prepare('UPDATE breakout_rooms SET closed_at = ? WHERE meeting = ? AND closed_at IS NULL');
  const pending = db.prepare('SELECT id FROM breakout_rooms WHERE meeting = ? AND closed_at IS NOT NULL AND cleaned_at IS NULL');
  const pendingMeetings = db.prepare('SELECT DISTINCT meeting FROM breakout_rooms WHERE closed_at IS NOT NULL AND cleaned_at IS NULL LIMIT 50');
  const markCleaned = db.prepare('UPDATE breakout_rooms SET cleaned_at = ? WHERE id = ?');
  const getKey = db.prepare('SELECT identity FROM meeting_routing_keys WHERE meeting = ? AND key_hash = ?');
  const saveKey = db.prepare(`
    INSERT INTO meeting_routing_keys(meeting, identity, key_hash) VALUES(?, ?, ?)
  `);
  const pruneKeys = db.prepare(`
    DELETE FROM meeting_routing_keys WHERE meeting = ? AND identity = ?
    AND key_hash NOT IN (
      SELECT key_hash FROM meeting_routing_keys WHERE meeting = ? AND identity = ? ORDER BY rowid DESC LIMIT 4
    )
  `);
  const dropMeetingKeys = db.prepare('DELETE FROM meeting_routing_keys WHERE meeting = ?');
  const saveScheduled = db.prepare('INSERT INTO breakout_scheduled_routes(meeting, room, email_key, claimed) VALUES(?, ?, ?, ?)');
  const pendingScheduled = db.prepare(`SELECT s.room FROM breakout_scheduled_routes s JOIN breakout_rooms room ON room.id = s.room
    WHERE s.meeting = ? AND s.email_key = ? AND s.claimed = 0 AND room.closed_at IS NULL`);
  const claimScheduled = db.prepare('UPDATE breakout_scheduled_routes SET claimed = 1 WHERE meeting = ? AND email_key = ?');
  const clearScheduled = db.prepare('DELETE FROM breakout_scheduled_routes WHERE meeting = ?');
  const requestHelp = db.prepare('INSERT OR IGNORE INTO breakout_help_requests(room, requested_at) VALUES(?, ?)');
  const getHelp = db.prepare('SELECT requested_at AS requestedAt FROM breakout_help_requests WHERE room = ?');
  const resolveHelp = db.prepare('DELETE FROM breakout_help_requests WHERE room = ?');
  const clearHelp = db.prepare('DELETE FROM breakout_help_requests WHERE room IN (SELECT id FROM breakout_rooms WHERE meeting = ?)');

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

  return {
    list(meeting) {
      return active.all(meeting).map(room => ({ ...room, members: members.all(room.id).map(member => member.identity) }));
    },
    assigned(meeting, identity) { return assigned.get(meeting, identity); },
    assignedUncleaned(meeting, identity) { return assignedUncleaned.all(meeting, identity); },
    removeMember(meeting, identity) { removeMember.run(identity, meeting); },
    choices(meeting) { return selectionEnabled.get(meeting) ? active.all(meeting) : []; },
    closesAt(meeting) { return readDeadline.get(meeting)?.closesAt ?? null; },
    scheduleClose(meeting, closesAt) { saveDeadline.run(meeting, closesAt); },
    due(now) { return dueDeadlines.all(now); },
    askForHelp(room) { return !!requestHelp.run(room, Date.now()).changes; },
    helpRequestedAt(room) { return getHelp.get(room)?.requestedAt ?? null; },
    resolveHelp(room) { resolveHelp.run(room); },
    open(meeting, plan, selfSelect, closesAt, scheduled = []) {
      transaction(() => {
        if (selfSelect) enableSelection.run(meeting);
        if (closesAt != null) saveDeadline.run(meeting, closesAt);
        for (const [position, room] of plan.entries()) {
          const id = 'breakout_' + randomBytes(12).toString('base64url');
          insertRoom.run(id, meeting, room.name, position);
          for (const identity of room.members) insertMember.run(id, identity);
          for (const entry of scheduled.filter(item => item.room === position)) {
            saveScheduled.run(meeting, id, entry.key, Number(entry.claimed));
          }
        }
      });
    },
    assignScheduled(meeting, identity, emailKey) {
      const scheduled = emailKey && pendingScheduled.get(meeting, emailKey);
      if (!scheduled) return;
      transaction(() => {
        claimScheduled.run(meeting, emailKey);
        if (!assigned.get(meeting, identity)) insertMember.run(scheduled.room, identity);
      });
    },
    select(meeting, identity, room) {
      transaction(() => {
        removeActiveMember.run(identity, meeting);
        if (room) insertMember.run(room, identity);
      });
    },
    close(meeting) {
      return transaction(() => {
        const result = closeRooms.run(Date.now(), meeting).changes;
        disableSelection.run(meeting);
        clearDeadline.run(meeting);
        clearScheduled.run(meeting);
        clearHelp.run(meeting);
        return result;
      });
    },
    pending(meeting) { return pending.all(meeting); },
    pendingMeetings() { return pendingMeetings.all(); },
    markCleaned(id) { markCleaned.run(Date.now(), id); },
    issueKey(meeting, identity) {
      const key = randomBytes(32).toString('base64url');
      saveKey.run(meeting, identity, keyDigest(key));
      // An admission response can race a retry while the client is switching screens.
      pruneKeys.run(meeting, identity, meeting, identity);
      return key;
    },
    identity(meeting, key) { return getKey.get(meeting, keyDigest(key))?.identity; },
    dropMeetingKeys(meeting) { dropMeetingKeys.run(meeting); },
  };
}
