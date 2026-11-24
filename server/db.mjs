import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename, { timeout: 4000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS team_channels (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      title TEXT NOT NULL,
      invite_hash TEXT UNIQUE,
      invite_until INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS team_channels_owner ON team_channels(owner);
    CREATE TABLE IF NOT EXISTS team_members (
      channel TEXT NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
      identity TEXT NOT NULL,
      id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      PRIMARY KEY (channel, identity)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS team_members_identity ON team_members(identity);
    CREATE TABLE IF NOT EXISTS team_messages (
      id INTEGER PRIMARY KEY,
      channel TEXT NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
      sender TEXT NOT NULL,
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS team_messages_channel ON team_messages(channel, id DESC);
    CREATE TABLE IF NOT EXISTS workspace_items (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('tasks', 'canvases')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      due_date TEXT,
      completed INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workspace_items_owner ON workspace_items(owner, kind, updated_at DESC);
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
      expires_at INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'desktop'
    ) STRICT;
    CREATE TABLE IF NOT EXISTS oauth_requests (
      id TEXT PRIMARY KEY,
      verifier TEXT NOT NULL,
      return_to TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS oauth_requests_expiry ON oauth_requests(expires_at);
    CREATE INDEX IF NOT EXISTS desktop_sessions_expiry ON desktop_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      host_identity TEXT,
      host_version INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      start_at INTEGER NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      created_at INTEGER NOT NULL,
      lobby INTEGER NOT NULL,
      allow_guests INTEGER NOT NULL DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS google_calendar_flows (
      state TEXT PRIMARY KEY,
      nonce TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      code TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS google_calendar_flows_expiry ON google_calendar_flows(expires_at);
    CREATE TABLE IF NOT EXISTS google_calendar_connections (
      owner TEXT PRIMARY KEY,
      refresh_token TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS google_calendar_events (
      meeting TEXT PRIMARY KEY REFERENCES meetings(id),
      event TEXT NOT NULL,
      etag TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS calendar_automation (
      meeting TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('google', 'outlook')),
      baseline TEXT NOT NULL,
      next_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('synced', 'unavailable', 'conflict'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS calendar_automation_due ON calendar_automation(provider, next_at);
    CREATE TABLE IF NOT EXISTS outlook_flows (
      state TEXT PRIMARY KEY,
      nonce TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('calendar', 'mail')),
      verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      code TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS outlook_flows_expiry ON outlook_flows(expires_at);
    CREATE TABLE IF NOT EXISTS outlook_connections (
      owner TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('calendar', 'mail')),
      refresh_token TEXT NOT NULL,
      PRIMARY KEY (owner, kind)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS outlook_events (
      meeting TEXT PRIMARY KEY REFERENCES meetings(id),
      event TEXT NOT NULL,
      etag TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS calendar_removals (
      meeting TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('google', 'outlook')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'removed', 'attention')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL,
      PRIMARY KEY (meeting, provider)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS calendar_removals_due ON calendar_removals(provider, status, next_at);
    CREATE TABLE IF NOT EXISTS calendar_feeds (
      owner TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS booking_pages (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      title TEXT NOT NULL,
      duration INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE INDEX IF NOT EXISTS booking_pages_owner ON booking_pages(owner, active, created_at DESC);
    CREATE TABLE IF NOT EXISTS booking_slots (
      id TEXT PRIMARY KEY,
      page TEXT NOT NULL REFERENCES booking_pages(id),
      start_at INTEGER NOT NULL,
      meeting TEXT UNIQUE REFERENCES meetings(id),
      guest_name TEXT,
      UNIQUE (page, start_at)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS attendance (
      meeting TEXT NOT NULL REFERENCES meetings(id),
      identity TEXT NOT NULL,
      name TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('pending', 'admitted', 'denied')),
      requested_at INTEGER NOT NULL,
      placement_epoch INTEGER NOT NULL DEFAULT 0,
      waiting_evicting INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (meeting, identity)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS attendance_by_identity ON attendance(identity);
    CREATE TABLE IF NOT EXISTS cloud_recordings (
      id TEXT PRIMARY KEY,
      meeting TEXT NOT NULL REFERENCES meetings(id),
      host_identity TEXT NOT NULL,
      host_version INTEGER NOT NULL,
      requested_at INTEGER NOT NULL,
      started_at INTEGER,
      state TEXT NOT NULL CHECK(state IN ('requesting', 'recording', 'stopping', 'ready', 'failed')),
      ticket_hash TEXT UNIQUE,
      egress_id TEXT UNIQUE,
      file_key TEXT NOT NULL,
      reason TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS cloud_recordings_by_meeting ON cloud_recordings(meeting, requested_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS one_live_cloud_recording
      ON cloud_recordings(meeting) WHERE state IN ('requesting', 'recording', 'stopping');
    CREATE TABLE IF NOT EXISTS cloud_recording_consent (
      recording TEXT NOT NULL REFERENCES cloud_recordings(id) ON DELETE CASCADE,
      identity TEXT NOT NULL,
      sid TEXT NOT NULL,
      allowed INTEGER CHECK(allowed IN (0, 1)),
      PRIMARY KEY (recording, identity)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS meeting_cohosts (
      meeting TEXT NOT NULL,
      identity TEXT NOT NULL,
      sid TEXT NOT NULL,
      PRIMARY KEY (meeting, identity),
      FOREIGN KEY (meeting, identity) REFERENCES attendance(meeting, identity) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS breakout_rooms (
      id TEXT PRIMARY KEY,
      meeting TEXT NOT NULL REFERENCES meetings(id),
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      closed_at INTEGER,
      cleaned_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS breakout_rooms_by_meeting ON breakout_rooms(meeting, closed_at, position);
    CREATE TABLE IF NOT EXISTS breakout_choice_sets (
      meeting TEXT PRIMARY KEY REFERENCES meetings(id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS breakout_deadlines (
      meeting TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
      closes_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS breakout_deadlines_by_time ON breakout_deadlines(closes_at);
    CREATE TABLE IF NOT EXISTS breakout_members (
      room TEXT NOT NULL REFERENCES breakout_rooms(id) ON DELETE CASCADE,
      identity TEXT NOT NULL,
      PRIMARY KEY (room, identity)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS breakout_members_by_identity ON breakout_members(identity);
    CREATE TABLE IF NOT EXISTS meeting_routing_keys (
      meeting TEXT NOT NULL REFERENCES meetings(id),
      identity TEXT NOT NULL,
      key_hash TEXT PRIMARY KEY
    ) STRICT;
    CREATE INDEX IF NOT EXISTS routing_keys_by_identity ON meeting_routing_keys(meeting, identity);
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
  if (!db.prepare('PRAGMA table_info(desktop_sessions)').all().some(column => column.name === 'kind')) {
    db.exec("ALTER TABLE desktop_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'desktop'");
  }
  const columns = new Set(db.prepare('PRAGMA table_info(meetings)').all().map(column => column.name));
  if (!columns.has('host_identity')) db.exec('ALTER TABLE meetings ADD COLUMN host_identity TEXT');
  if (!columns.has('host_version')) db.exec('ALTER TABLE meetings ADD COLUMN host_version INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('alternative_hosts')) db.exec('ALTER TABLE meetings ADD COLUMN alternative_hosts TEXT');
  if (!columns.has('alternative_host_started')) db.exec('ALTER TABLE meetings ADD COLUMN alternative_host_started INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('duration_minutes')) db.exec('ALTER TABLE meetings ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 60');
  if (!columns.has('series_id')) db.exec('ALTER TABLE meetings ADD COLUMN series_id TEXT');
  if (!columns.has('series_index')) db.exec('ALTER TABLE meetings ADD COLUMN series_index INTEGER');
  if (!columns.has('calendar_revision')) db.exec('ALTER TABLE meetings ADD COLUMN calendar_revision INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('encrypted')) {
    db.exec('ALTER TABLE meetings ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('allow_guests')) {
    db.exec('ALTER TABLE meetings ADD COLUMN allow_guests INTEGER NOT NULL DEFAULT 0');
  }
  const attendanceColumns = new Set(db.prepare('PRAGMA table_info(attendance)').all().map(column => column.name));
  if (!db.prepare('PRAGMA table_info(breakout_members)').all().some(column => column.name === 'moderator_visit')) {
    db.exec('ALTER TABLE breakout_members ADD COLUMN moderator_visit INTEGER NOT NULL DEFAULT 0');
  }
  if (!attendanceColumns.has('placement_epoch')) db.exec('ALTER TABLE attendance ADD COLUMN placement_epoch INTEGER NOT NULL DEFAULT 0');
  if (!attendanceColumns.has('waiting_evicting')) db.exec('ALTER TABLE attendance ADD COLUMN waiting_evicting INTEGER NOT NULL DEFAULT 0');
  for (const table of ['desktop_sign_ins', 'desktop_sessions', 'attendance']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'breakout_email_key')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN breakout_email_key TEXT`);
    }
  }
  if (!db.prepare('PRAGMA table_info(team_messages)').all().some(column => column.name === 'reply_to')) {
    db.exec('ALTER TABLE team_messages ADD COLUMN reply_to INTEGER REFERENCES team_messages(id) ON DELETE CASCADE');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS meetings_by_series ON meetings(series_id, series_index) WHERE series_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS meeting_breakout_plans (
      meeting TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
      plan TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workspace_secrets (
      name TEXT PRIMARY KEY,
      value BLOB NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS breakout_scheduled_routes (
      meeting TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      room TEXT NOT NULL REFERENCES breakout_rooms(id) ON DELETE CASCADE,
      email_key TEXT NOT NULL,
      claimed INTEGER NOT NULL CHECK(claimed IN (0, 1)),
      PRIMARY KEY (meeting, email_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS breakout_help_requests (
      room TEXT PRIMARY KEY REFERENCES breakout_rooms(id) ON DELETE CASCADE,
      requested_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS moderator_room_handoffs (
      meeting TEXT NOT NULL,
      identity TEXT NOT NULL,
      room TEXT NOT NULL,
      nonce TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (meeting, identity),
      FOREIGN KEY (meeting, identity) REFERENCES meeting_cohosts(meeting, identity) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS team_message_threads ON team_messages(channel, reply_to, id DESC);
    CREATE INDEX IF NOT EXISTS team_message_replies ON team_messages(reply_to) WHERE reply_to IS NOT NULL;
    CREATE TABLE IF NOT EXISTS team_attachments (
      message INTEGER PRIMARY KEY REFERENCES team_messages(id) ON DELETE CASCADE,
      channel TEXT NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 1048576),
      contents BLOB NOT NULL CHECK(length(contents) = size)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS team_attachments_channel ON team_attachments(channel);
  `);
  return db;
}
