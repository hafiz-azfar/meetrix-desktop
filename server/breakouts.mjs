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

  return {
    list(meeting) {
      return active.all(meeting).map(room => ({ ...room, members: members.all(room.id).map(member => member.identity) }));
    },
    assigned(meeting, identity) { return assigned.get(meeting, identity); },
    assignedUncleaned(meeting, identity) { return assignedUncleaned.all(meeting, identity); },
    open(meeting, plan) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [position, room] of plan.entries()) {
          const id = 'breakout_' + randomBytes(12).toString('base64url');
          insertRoom.run(id, meeting, room.name, position);
          for (const identity of room.members) insertMember.run(id, identity);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close(meeting) { return closeRooms.run(Date.now(), meeting).changes; },
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
