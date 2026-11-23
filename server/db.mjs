import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename, { timeout: 4000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS desktop_sign_ins (
      id TEXT PRIMARY KEY,
      challenge TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      identity TEXT,
      name TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS desktop_sign_ins_expiry ON desktop_sign_ins(expires_at);
    CREATE TABLE IF NOT EXISTS desktop_sessions (
      credential TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      name TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS desktop_sessions_expiry ON desktop_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      title TEXT NOT NULL,
      start_at INTEGER NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      created_at INTEGER NOT NULL,
      lobby INTEGER NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0,
      passcode TEXT,
      locked INTEGER NOT NULL DEFAULT 0,
      opened_at INTEGER,
      stopped_at INTEGER,
      cleaned_at INTEGER,
      notes TEXT NOT NULL DEFAULT '',
      notes_version INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS meetings_by_owner ON meetings(owner, start_at);
    CREATE TABLE IF NOT EXISTS attendance (
      meeting TEXT NOT NULL REFERENCES meetings(id),
      identity TEXT NOT NULL,
      name TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('pending', 'admitted', 'denied')),
      requested_at INTEGER NOT NULL,
      PRIMARY KEY (meeting, identity)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS attendance_by_identity ON attendance(identity);
    CREATE TABLE IF NOT EXISTS board_versions (
      meeting TEXT PRIMARY KEY REFERENCES meetings(id),
      version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS board_strokes (
      id INTEGER PRIMARY KEY,
      meeting TEXT NOT NULL REFERENCES meetings(id),
      stroke TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS strokes_by_meeting ON board_strokes(meeting, id);
    CREATE TABLE IF NOT EXISTS polls (
      id INTEGER PRIMARY KEY,
      meeting TEXT NOT NULL REFERENCES meetings(id),
      question TEXT NOT NULL,
      choices TEXT NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS polls_by_meeting ON polls(meeting, id);
    CREATE TABLE IF NOT EXISTS votes (
      poll INTEGER NOT NULL REFERENCES polls(id),
      identity TEXT NOT NULL,
      choice INTEGER NOT NULL,
      PRIMARY KEY (poll, identity)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY,
      meeting TEXT NOT NULL REFERENCES meetings(id),
      actor TEXT NOT NULL,
      event TEXT NOT NULL,
      subject TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(meetings)').all().map(column => column.name));
  if (!columns.has('duration_minutes')) db.exec('ALTER TABLE meetings ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 60');
  if (!columns.has('encrypted')) {
    db.exec('ALTER TABLE meetings ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0');
  }
  return db;
}
