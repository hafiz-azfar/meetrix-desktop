import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { AccessToken, DataPacket_Kind, RoomServiceClient } from 'livekit-server-sdk';
import { z } from 'zod';
import { authenticationScope, createInsforgeAuth, insforgeSettings } from './auth.mjs';
import { openDatabase } from './db.mjs';
import { createDesktopAuth } from './desktop-auth.mjs';
import { breakoutStore } from './breakouts.mjs';

const scrypt = promisify(scryptCallback);
const maxDuration = 30 * 60 * 60 * 1000;
const optionalPasscode = z.string().min(8).max(128).optional();
const person = z.string().trim().min(1).max(60);
const participantIdentity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const meetingTitle = z.string().trim().min(1).max(100);
const duration = z.number().int().min(15).max(1800);
const schedule = z.object({
  title: meetingTitle,
  name: person,
  startAt: z.iso.datetime().optional(),
  duration: duration.default(60),
  additionalStarts: z.array(z.iso.datetime()).max(11).default([]),
  lobby: z.boolean().default(true),
  allowGuests: z.boolean().default(false),
  encrypted: z.boolean().default(false),
  passcode: optionalPasscode,
}).strict();
const reschedule = z.object({ title: meetingTitle, startAt: z.iso.datetime(), duration }).strict();
const join = z.object({ name: person, passcode: optionalPasscode, keyReady: z.boolean().optional() }).strict();
const guestJoin = join.extend({ proof: z.string().regex(/^[a-f0-9]{32}$/) });
const routingRequest = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  roomId: z.string().regex(/^(?:breakout_)?[A-Za-z0-9_-]{16}$/),
}).strict();
const breakoutCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), rooms: z.array(z.object({
    name: z.string().trim().min(1).max(40), members: z.array(participantIdentity).max(99),
  }).strict()).min(1).max(8) }).strict(),
  z.object({ action: z.literal('close') }).strict(),
  z.object({ action: z.literal('announce'), text: z.string().trim().min(1).max(300) }).strict(),
]);
const placementTopic = 'meetrix.room-placement';
const breakoutMessageTopic = 'meetrix.breakout-announcement';
const moderation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('decide'), identity: participantIdentity, admit: z.boolean() }).strict(),
  z.object({ action: z.literal('lock'), locked: z.boolean() }).strict(),
  z.object({ action: z.literal('mute'), identity: participantIdentity }).strict(),
  z.object({ action: z.literal('remove'), identity: participantIdentity }).strict(),
  z.object({ action: z.literal('end') }).strict(),
]);
const pollInput = z.object({ question: z.string().trim().min(1).max(200), choices: z.array(z.string().trim().min(1).max(80)).min(2).max(6) }).strict();
const voteInput = z.object({ poll: z.number().int().positive().safe(), choice: z.number().int().nonnegative() }).strict();
const closePollInput = z.object({ poll: z.number().int().positive().safe() }).strict();
const coordinate = z.number().min(0).max(1);
const pen = z.object({ color: z.enum(['mint', 'sky', 'peach', 'white']), points: z.array(z.tuple([coordinate, coordinate])).min(1).max(192) }).strict();
const note = z.object({ text: z.string().max(12000), version: z.number().int().nonnegative().safe() }).strict();

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function encodePasscode(value) {
  const salt = randomBytes(16);
  const key = await scrypt(value, salt, 32);
  return salt.toString('hex') + ':' + key.toString('hex');
}

async function checkPasscode(value, stored) {
  if (!value) return false;
  const [salt, expected] = stored.split(':').map(part => Buffer.from(part, 'hex'));
  return timingSafeEqual(expected, await scrypt(value, salt, expected.length));
}

function scheduledTime(input, now) {
  const time = input ? Date.parse(input) : now;
  if (!Number.isFinite(time) || time < now - 60000 || time > now + 366 * 86400000) {
    throw new RequestError(400, 'Choose a start time within the next year.');
  }
  return time;
}

function view(meeting, userId) {
  return {
    id: meeting.id, title: meeting.title, ownerName: meeting.owner_name, startAt: meeting.start_at, duration: meeting.duration_minutes,
    openedAt: meeting.opened_at, stoppedAt: meeting.stopped_at, lobby: !!meeting.lobby,
    locked: !!meeting.locked, encrypted: !!meeting.encrypted, hasPasscode: !!meeting.passcode, isHost: meeting.owner === userId,
  };
}

export function createApp(options, dependencies = {}) {
  const { origin, livekitUrl, livekitKey, livekitSecret,
    databasePath, assets, trustProxyHops = 0, dev = false, desktop = false } = options;
  const db = dependencies.db ?? openDatabase(databasePath);
  const breakouts = breakoutStore(db);
  const settings = insforgeSettings(options.insforgeUrl, options.insforgeAnonKey);
  const scope = authenticationScope(settings.insforgeUrl);
  const rooms = dependencies.rooms ?? (livekitKey && new RoomServiceClient(
    livekitUrl.replace(/^ws/, 'http'), livekitKey, livekitSecret, { requestTimeout: 7 },
  ));
  const app = express();
  const publicConfig = { authProvider: 'insforge', desktop, desktopBrowserSignIn: true, mediaReady: Boolean(rooms) };
  const mediaOrigin = livekitUrl ? new URL(livekitUrl).origin : null;
  const localLoopback = new URL(origin).protocol === 'http:';
  const api = express.Router();
  const queues = new Map();
  const findMeeting = db.prepare('SELECT * FROM meetings WHERE id = ?');
  const findGuest = db.prepare('SELECT * FROM attendance WHERE meeting = ? AND identity = ?');
  const setDecision = db.prepare('UPDATE attendance SET decision = ? WHERE meeting = ? AND identity = ?');
  const log = db.prepare('INSERT INTO audit(meeting, actor, event, subject, created_at) VALUES(?, ?, ?, ?, ?)');
  const start = db.prepare('UPDATE meetings SET opened_at = ? WHERE id = ? AND opened_at IS NULL');
  const markEnded = db.prepare('UPDATE meetings SET stopped_at = COALESCE(stopped_at, ?) WHERE id = ?');
  const markCleaned = db.prepare('UPDATE meetings SET cleaned_at = ? WHERE id = ?');
  const expired = db.prepare('SELECT id, owner FROM meetings WHERE (stopped_at IS NOT NULL AND cleaned_at IS NULL) OR (stopped_at IS NULL AND opened_at <= ?) LIMIT 50');

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxyHops || false);
  app.use((req, res, next) => {
    if (localLoopback && req.get('host') !== new URL(origin).host) return res.sendStatus(421);
    next();
  });
  if (!dev) app.use(helmet({
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: localLoopback ? false : undefined,
    referrerPolicy: { policy: 'no-referrer' },
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", ...(mediaOrigin ? [mediaOrigin, mediaOrigin.replace(/^ws/, 'http')] : [])],
      imgSrc: ["'self'", 'data:', 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      frameSrc: ["'none'"],
      workerSrc: ["'self'", 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: localLoopback ? null : [],
    } },
  }));
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), usb=()');
    next();
  });
  app.get('/api/config', (_req, res) => res.set('Cache-Control', 'no-store').json(publicConfig));
  app.use('/api', api);
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const limitOptions = { windowMs: 60000, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Try again shortly.' } };
  api.use(rateLimit({ ...limitOptions, limit: 700 }));
  api.use((req, _res, next) => {
    const requestOrigin = req.get('origin');
    if (requestOrigin && requestOrigin !== origin) throw new RequestError(403, 'This origin is not allowed.');
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) throw new RequestError(415, 'Send a JSON request.');
    next();
  });
  api.use(express.json({ limit: '56kb' }));
  const desktopAuth = createDesktopAuth({ db, origin, scope, limitOptions });
  const auth = createInsforgeAuth({ db, origin, ...settings, sessions: desktopAuth, limitOptions, createAuth: dependencies.createAuth });
  const authenticate = dependencies.authenticate ?? auth.currentIdentity;
  api.use('/auth', auth.router);
  api.use('/desktop-auth', desktopAuth.router);
  api.post('/meetings/:id/guest', rateLimit({ ...limitOptions, limit: 45 }), async (req, res) => {
    if (req.get('origin') !== origin) throw new RequestError(403, 'This origin is not allowed.');
    const { proof, ...input } = guestJoin.parse(req.body);
    const meeting = meetingFor(req);
    if (!meeting.allow_guests || !meeting.lobby) throw new RequestError(403, 'Sign in to join this meeting.');
    const identity = 'guest_' + createHash('sha256').update(meeting.id + ':' + proof).digest('base64url');
    res.json(await connectMeeting(meeting, identity, input, true));
  });
  api.post('/meetings/:id/placement', async (req, res) => {
    if (req.get('origin') !== origin) throw new RequestError(403, 'This origin is not allowed.');
    const input = routingRequest.parse(req.body);
    const initial = meetingFor(req);
    const grant = await serial(initial.id, async () => {
      const current = findMeeting.get(initial.id);
      if (meetingEnded(current)) throw new RequestError(410, 'This meeting has ended.');
      const identity = breakouts.identity(current.id, input.key);
      const participant = identity && findGuest.get(current.id, identity);
      if (!participant || participant.decision !== 'admitted' || current.encrypted) {
        throw new RequestError(403, 'Your meeting session is no longer active.');
      }
      const target = currentLocation(current.id, identity);
      if (target.roomId === input.roomId) return { roomId: target.roomId };
      await ensureMediaRoom(target.roomId);
      return { ...target, token: await mediaToken(target.roomId, identity, participant.name) };
    });
    res.json(grant);
  });
  async function bearerIdentity(req) {
    const token = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(req.get('authorization') || '')?.[1];
    if (!token) throw new RequestError(401, 'Sign in to continue.');
    try { return await authenticate(token); }
    catch { throw new RequestError(401, 'Your sign-in has expired or could not be verified.'); }
  }
  api.use(async (req, _res, next) => {
    if (req.get('authorization')) {
      req.identity = await bearerIdentity(req);
    } else {
      const session = desktopAuth.session(req);
      if (!session) throw new RequestError(401, 'Sign in to continue.');
      if (!['GET', 'HEAD'].includes(req.method) && req.get('origin') !== origin) {
        throw new RequestError(403, 'This origin is not allowed.');
      }
      req.identity = session.identity;
    }
    next();
  });
  const byIdentity = (limit) => rateLimit({ ...limitOptions, limit, keyGenerator: req => req.identity });

  function meetingFor(req) {
    if (!/^[A-Za-z0-9_-]{16}$/.test(req.params.id)) throw new RequestError(404, 'Meeting not found.');
    const meeting = findMeeting.get(req.params.id);
    if (!meeting) throw new RequestError(404, 'Meeting not found.');
    return meeting;
  }
  function requireHost(meeting, actor) {
    if (meeting.owner !== actor) throw new RequestError(403, 'Only the host can do that.');
  }
  function requireAccess(meeting, actor) {
    if (meeting.encrypted) throw new RequestError(403, 'Server-stored collaboration is disabled for encrypted meetings.');
    if (meeting.owner !== actor && findGuest.get(meeting.id, actor)?.decision !== 'admitted') {
      throw new RequestError(403, 'Join the meeting to use this feature.');
    }
    if (breakouts.assigned(meeting.id, actor)) {
      throw new RequestError(403, 'Meeting notes, polls, and boards are available in the main room.');
    }
  }
  function serial(id, operation) {
    const work = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(id, work);
    return work.finally(() => { if (queues.get(id) === work) queues.delete(id); });
  }
  async function media(operation) {
    if (!rooms) throw new RequestError(503, 'This server needs LiveKit configuration.');
    try { return await operation(rooms); }
    catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(502, 'LiveKit could not complete the request. Try again.');
    }
  }
  async function disconnectRoom(meeting, actor) {
    if (!meeting.stopped_at) {
      markEnded.run(Date.now(), meeting.id);
      log.run(meeting.id, actor, 'end', null, Date.now());
    }
    if (meeting.cleaned_at) return;
    breakouts.close(meeting.id);
    breakouts.dropMeetingKeys(meeting.id);
    if (meeting.opened_at && rooms) await deleteMediaRoom(meeting.id);
    await cleanupBreakouts(meeting.id);
    markCleaned.run(Date.now(), meeting.id);
  }
  function isNotFound(error) {
    return error?.status === 404 || error?.code === 5 || error?.code === 'not_found';
  }
  function admit(meeting, identity) {
    const participant = findGuest.get(meeting.id, identity);
    if (participant?.decision !== 'admitted') throw new RequestError(404, 'Participant not found.');
    return participant;
  }
  function meetingEnded(meeting) {
    return meeting.stopped_at || (meeting.opened_at && Date.now() - meeting.opened_at >= maxDuration);
  }
  function currentLocation(meetingId, identity) {
    const assigned = breakouts.assigned(meetingId, identity);
    return assigned ? { roomId: assigned.id, breakoutName: assigned.name } : { roomId: meetingId, breakoutName: null };
  }
  function ensureMediaRoom(room) {
    return media(client => client.createRoom({ name: room, emptyTimeout: 120, departureTimeout: 60, maxParticipants: 100 }));
  }
  async function mediaToken(room, identity, name) {
    const token = new AccessToken(livekitKey, livekitSecret, { identity, name, ttl: '50s' });
    token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: false });
    return token.toJwt();
  }
  function deleteMediaRoom(id) {
    return media(async client => {
      try { await client.deleteRoom(id); }
      catch (error) { if (!isNotFound(error)) throw error; }
    });
  }
  async function cleanupBreakouts(meeting) {
    const results = await Promise.allSettled(breakouts.pending(meeting).map(async ({ id }) => {
      await deleteMediaRoom(id);
      breakouts.markCleaned(id);
    }));
    if (results.some(result => result.status === 'rejected')) {
      throw new RequestError(502, 'Breakout rooms are closed. LiveKit cleanup will be retried.');
    }
  }
  function signalPlacement(room, identities) {
    return media(client => client.sendData?.(room, Uint8Array.of(1), DataPacket_Kind.RELIABLE,
      { topic: placementTopic, destinationIdentities: identities })).catch(() => {});
  }

  api.get('/meetings', (req, res) => {
    const rows = db.prepare(`
      SELECT meetings.* FROM meetings WHERE owner = ?
      OR (id IN (SELECT meeting FROM attendance WHERE identity = ? AND decision = 'admitted'))
      ORDER BY start_at DESC LIMIT 200
    `).all(req.identity, req.identity);
    res.json(rows.map(row => view(row, req.identity)));
  });

  api.post('/meetings', byIdentity(20), async (req, res) => {
    const input = schedule.parse(req.body);
    if (input.allowGuests && !input.lobby) {
      throw new RequestError(400, 'Enable the waiting room to allow guests without an account.');
    }
    const now = Date.now();
    const times = [input.startAt, ...input.additionalStarts].map(startAt => scheduledTime(startAt, now));
    if (times.some((time, index) => index && time <= times[index - 1])) {
      throw new RequestError(400, 'Recurring meeting times must be in order.');
    }
    const passcodes = input.passcode ? await Promise.all(times.map(() => encodePasscode(input.passcode))) : times.map(() => null);
    const insert = db.prepare('INSERT INTO meetings(id, owner, owner_name, title, start_at, duration_minutes, created_at, lobby, allow_guests, passcode, encrypted) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const ids = times.map(() => randomBytes(12).toString('base64url'));
    db.exec('BEGIN IMMEDIATE');
    try {
      ids.forEach((id, index) => {
        insert.run(id, req.identity, input.name, input.title, times[index], input.duration, now, Number(input.lobby), Number(input.allowGuests), passcodes[index], Number(input.encrypted));
        log.run(id, req.identity, 'create', null, now);
      });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.status(201).json({ ...view(findMeeting.get(ids[0]), req.identity), scheduledCount: ids.length });
  });

  api.patch('/meetings/:id', byIdentity(30), async (req, res) => {
    const input = reschedule.parse(req.body);
    const initial = meetingFor(req);
    requireHost(initial, req.identity);
    const result = await serial(initial.id, () => {
      const current = findMeeting.get(initial.id);
      if (current.opened_at || current.stopped_at) throw new RequestError(409, 'Only unopened meetings can be rescheduled.');
      const now = Date.now();
      db.prepare('UPDATE meetings SET title = ?, start_at = ?, duration_minutes = ? WHERE id = ?')
        .run(input.title, scheduledTime(input.startAt, now), input.duration, current.id);
      log.run(current.id, req.identity, 'reschedule', null, now);
      return view(findMeeting.get(current.id), req.identity);
    });
    res.json(result);
  });

  async function connectMeeting(initial, identity, input, accountless = false) {
    const isHost = !accountless && initial.owner === identity;
    const verified = !isHost && initial.passcode && !findGuest.get(initial.id, identity)
      ? await checkPasscode(input.passcode, initial.passcode) : true;
    return serial(initial.id, async () => {
      const current = findMeeting.get(initial.id);
      if (meetingEnded(current)) {
        throw new RequestError(410, 'This meeting has ended.');
      }
      if (isHost && current.encrypted && !input.keyReady) return { state: 'key-required' };
      if (!isHost) {
        let guest = findGuest.get(current.id, identity);
        if (guest?.decision === 'denied') throw new RequestError(403, 'The host has declined your request.');
        if (current.locked) throw new RequestError(423, 'The host has locked the meeting.');
        if (!guest && !verified) throw new RequestError(403, 'Enter the correct meeting passcode.');
        if (!guest) {
          db.prepare('INSERT INTO attendance(meeting, identity, name, decision, requested_at) VALUES(?, ?, ?, ?, ?)')
            .run(current.id, identity, input.name, current.lobby ? 'pending' : 'admitted', Date.now());
          guest = findGuest.get(current.id, identity);
        }
        if (!current.opened_at || guest.decision !== 'admitted') return { state: 'waiting', hostPresent: !!current.opened_at };
        if (current.encrypted && !input.keyReady) return { state: 'key-required' };
      } else if (!current.opened_at) {
        await ensureMediaRoom(current.id);
        start.run(Date.now(), current.id);
        log.run(current.id, identity, 'open', null, Date.now());
      }
      const location = currentLocation(current.id, identity);
      // Recreate an idle room with the same capacity after LiveKit expires it.
      if (current.opened_at) await ensureMediaRoom(location.roomId);
      const name = isHost ? current.owner_name : findGuest.get(current.id, identity).name;
      const token = await mediaToken(location.roomId, identity, name);
      const routingKey = !isHost && !current.encrypted ? breakouts.issueKey(current.id, identity) : undefined;
      return { state: 'ready', serverUrl: livekitUrl, token, ...location, routingKey,
        meeting: view(findMeeting.get(current.id), identity), hostIdentity: current.owner, accountless };
    });
  }

  api.post('/meetings/:id/connect', byIdentity(34), async (req, res) => {
    res.json(await connectMeeting(meetingFor(req), req.identity, join.parse(req.body)));
  });

  api.get('/meetings/:id/lobby', (req, res) => {
    const meeting = meetingFor(req);
    requireHost(meeting, req.identity);
    const guests = db.prepare("SELECT identity, name, requested_at AS requestedAt FROM attendance WHERE meeting = ? AND decision = 'pending' ORDER BY requested_at LIMIT 100")
      .all(meeting.id).map(guest => ({ ...guest, accountless: guest.identity.startsWith('guest_') }));
    res.json({ guests, locked: !!meeting.locked });
  });

  function breakoutView(meeting) {
    return { rooms: breakouts.list(meeting).map(({ name, members }) => ({
      name, members: members.map(identity => findGuest.get(meeting, identity))
        .filter(guest => guest?.decision === 'admitted').map(({ identity, name }) => ({ identity, name })),
    })) };
  }

  api.get('/meetings/:id/breakouts', (req, res) => {
    const meeting = meetingFor(req);
    requireHost(meeting, req.identity);
    res.json(breakoutView(meeting.id));
  });

  api.post('/meetings/:id/breakouts', byIdentity(20), async (req, res) => {
    const command = breakoutCommand.parse(req.body);
    const meeting = meetingFor(req);
    requireHost(meeting, req.identity);
    const result = await serial(meeting.id, async () => {
      const current = findMeeting.get(meeting.id);
      if (!current.opened_at || meetingEnded(current)) throw new RequestError(409, 'Start the meeting before managing breakout rooms.');
      if (current.encrypted) throw new RequestError(403, 'Breakout rooms are unavailable in encrypted meetings.');
      const existing = breakouts.list(current.id);
      if (command.action === 'announce') {
        if (!existing.length) throw new RequestError(409, 'Open breakout rooms before sending an announcement.');
        const data = new TextEncoder().encode(command.text);
        const delivered = await media(async client => {
          const deliveries = await Promise.allSettled(existing.filter(room => room.members.length).map(room =>
            client.sendData(room.id, data, DataPacket_Kind.RELIABLE, { topic: breakoutMessageTopic })));
          return deliveries.filter(delivery => delivery.status === 'fulfilled').length;
        });
        if (!delivered) throw new RequestError(409, 'No breakout room accepted the announcement. Try again once participants have joined.');
        log.run(current.id, req.identity, 'announce-breakouts', null, Date.now());
        return { ...breakoutView(current.id), delivered };
      }
      if (command.action === 'close') {
        if (breakouts.close(current.id)) log.run(current.id, req.identity, 'close-breakouts', null, Date.now());
        await Promise.all(existing.filter(room => room.members.length).map(room => signalPlacement(room.id, room.members)));
        await cleanupBreakouts(current.id);
      } else {
        if (!rooms) throw new RequestError(503, 'This server needs LiveKit configuration.');
        if (existing.length) throw new RequestError(409, 'Close the current breakout rooms before opening another set.');
        const identities = command.rooms.flatMap(room => room.members);
        const names = new Set(command.rooms.map(room => room.name.toLowerCase()));
        if (names.size !== command.rooms.length || identities.length < 1 || identities.length > 99 || new Set(identities).size !== identities.length) {
          throw new RequestError(400, 'Use distinct room names and assign each participant to only one room.');
        }
        for (const identity of identities) admit(current, identity);
        breakouts.open(current.id, command.rooms);
        log.run(current.id, req.identity, 'open-breakouts', null, Date.now());
        await signalPlacement(current.id, identities);
      }
      return breakoutView(current.id);
    });
    res.json(result);
  });

  api.post('/meetings/:id/moderate', byIdentity(90), async (req, res) => {
    const command = moderation.parse(req.body);
    const initial = meetingFor(req);
    requireHost(initial, req.identity);
    await serial(initial.id, async () => {
      const current = findMeeting.get(initial.id);
      if (command.action === 'end') {
        await disconnectRoom(current, req.identity);
        return;
      }
      if (current.stopped_at) throw new RequestError(410, 'This meeting has ended.');
      if (command.action === 'lock') db.prepare('UPDATE meetings SET locked = ? WHERE id = ?').run(Number(command.locked), current.id);
      if (command.action === 'decide') {
        if (findGuest.get(current.id, command.identity)?.decision !== 'pending') throw new RequestError(409, 'This request has already been handled.');
        setDecision.run(command.admit ? 'admitted' : 'denied', current.id, command.identity);
      }
      if (command.action === 'remove') {
        const guest = findGuest.get(current.id, command.identity);
        if (!guest || guest.decision === 'pending') throw new RequestError(404, 'Participant not found.');
        setDecision.run('denied', current.id, command.identity);
        const roomIds = [current.id, ...breakouts.assignedUncleaned(current.id, command.identity).map(room => room.id)];
        await media(client => Promise.all(roomIds.map(async name => {
          try { await client.removeParticipant(name, command.identity); }
          catch (error) { if (!isNotFound(error)) throw error; }
        })));
      }
      if (command.action === 'mute') {
        admit(current, command.identity);
        await media(async client => {
          const target = await client.getParticipant(current.id, command.identity);
          for (const track of target.tracks.filter(track => track.source === 2 && !track.muted)) {
            await client.mutePublishedTrack(current.id, command.identity, track.sid, true);
          }
        });
      }
      log.run(current.id, req.identity, command.action, command.identity ?? null, Date.now());
    });
    res.json({ ok: true });
  });

  const latestPoll = db.prepare('SELECT * FROM polls WHERE meeting = ? ORDER BY id DESC LIMIT 1');
  const voterChoice = db.prepare('SELECT choice FROM votes WHERE poll = ? AND identity = ?');
  function pollView(meeting, actor) {
    const row = latestPoll.get(meeting.id);
    if (!row) return null;
    const choices = JSON.parse(row.choices);
    const votes = row.closed || meeting.owner === actor ? choices.map(() => 0) : null;
    if (votes) {
      for (const result of db.prepare('SELECT choice, count(*) AS count FROM votes WHERE poll = ? GROUP BY choice').all(row.id)) votes[result.choice] = result.count;
    }
    return {
      id: row.id, question: row.question, choices, closed: !!row.closed,
      voted: voterChoice.get(row.id, actor)?.choice ?? null, totals: votes,
    };
  }
  function activePoll(meeting, id) {
    const row = latestPoll.get(meeting.id);
    if (!row || row.id !== id || row.closed) throw new RequestError(409, 'This poll has closed.');
    return row;
  }
  function liveCollaboration(req) {
    const meeting = meetingFor(req);
    requireAccess(meeting, req.identity);
    if (!meeting.opened_at || meeting.stopped_at) throw new RequestError(409, 'The meeting room is closed.');
    return meeting;
  }
  api.get('/meetings/:id/poll', (req, res) => {
    const meeting = liveCollaboration(req);
    res.json(pollView(meeting, req.identity));
  });
  api.post('/meetings/:id/poll', byIdentity(15), (req, res) => {
    const meeting = liveCollaboration(req);
    requireHost(meeting, req.identity);
    const input = pollInput.parse(req.body);
    if (new Set(input.choices.map(choice => choice.toLowerCase())).size !== input.choices.length) throw new RequestError(400, 'Choose distinct options.');
    if (latestPoll.get(meeting.id)?.closed === 0) throw new RequestError(409, 'Close the current poll first.');
    db.prepare('INSERT INTO polls(meeting, question, choices) VALUES(?, ?, ?)').run(meeting.id, input.question, JSON.stringify(input.choices));
    res.status(201).json(pollView(meeting, req.identity));
  });
  api.post('/meetings/:id/poll/vote', byIdentity(25), (req, res) => {
    const meeting = liveCollaboration(req);
    const input = voteInput.parse(req.body);
    const row = activePoll(meeting, input.poll);
    if (input.choice >= JSON.parse(row.choices).length) throw new RequestError(400, 'Choose an option in this poll.');
    const vote = db.prepare('INSERT OR IGNORE INTO votes(poll, identity, choice) VALUES(?, ?, ?)').run(row.id, req.identity, input.choice);
    if (!vote.changes) throw new RequestError(409, 'You have already voted.');
    res.json(pollView(meeting, req.identity));
  });
  api.post('/meetings/:id/poll/close', byIdentity(15), (req, res) => {
    const meeting = liveCollaboration(req);
    requireHost(meeting, req.identity);
    const { poll } = closePollInput.parse(req.body);
    const row = activePoll(meeting, poll);
    db.prepare('UPDATE polls SET closed = 1 WHERE id = ?').run(row.id);
    res.json(pollView(meeting, req.identity));
  });

  const boardState = db.prepare('SELECT version FROM board_versions WHERE meeting = ?');
  const boardStrokes = db.prepare('SELECT stroke FROM board_strokes WHERE meeting = ? ORDER BY id');
  const boardBump = db.prepare('INSERT INTO board_versions(meeting, version) VALUES(?, 1) ON CONFLICT(meeting) DO UPDATE SET version = version + 1');
  function whiteboard(meeting) {
    return {
      version: boardState.get(meeting.id)?.version ?? 0,
      strokes: boardStrokes.all(meeting.id).map(row => JSON.parse(row.stroke)),
    };
  }
  function changeBoard(meeting, action) {
    db.exec('BEGIN IMMEDIATE');
    try { action(); boardBump.run(meeting.id); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    return whiteboard(meeting);
  }
  api.get('/meetings/:id/board', (req, res) => {
    const meeting = liveCollaboration(req);
    if (req.query.since === String(boardState.get(meeting.id)?.version ?? 0)) return res.json(null);
    res.json(whiteboard(meeting));
  });
  api.post('/meetings/:id/board', byIdentity(85), (req, res) => {
    const meeting = liveCollaboration(req);
    const stroke = pen.parse(req.body);
    if (db.prepare('SELECT count(*) AS count FROM board_strokes WHERE meeting = ?').get(meeting.id).count >= 360) {
      throw new RequestError(409, 'The board is full. Ask the host to export and clear it.');
    }
    res.status(201).json(changeBoard(meeting, () => {
      db.prepare('INSERT INTO board_strokes(meeting, stroke) VALUES(?, ?)').run(meeting.id, JSON.stringify(stroke));
    }));
  });
  api.delete('/meetings/:id/board', byIdentity(15), (req, res) => {
    const meeting = liveCollaboration(req);
    requireHost(meeting, req.identity);
    res.json(changeBoard(meeting, () => db.prepare('DELETE FROM board_strokes WHERE meeting = ?').run(meeting.id)));
  });

  api.get('/meetings/:id/notes', (req, res) => {
    const meeting = meetingFor(req);
    requireAccess(meeting, req.identity);
    res.json({ text: meeting.notes, version: meeting.notes_version });
  });
  api.put('/meetings/:id/notes', byIdentity(45), (req, res) => {
    const meeting = meetingFor(req);
    requireAccess(meeting, req.identity);
    if (meeting.stopped_at) throw new RequestError(410, 'This meeting has ended. Its notes are read-only.');
    const input = note.parse(req.body);
    const outcome = db.prepare('UPDATE meetings SET notes = ?, notes_version = notes_version + 1 WHERE id = ? AND notes_version = ?')
      .run(input.text, meeting.id, input.version);
    if (!outcome.changes) throw new RequestError(409, 'Someone saved a newer version. Reload the shared notes before saving.');
    res.json({ text: input.text, version: input.version + 1 });
  });

  api.use((_req, _res, next) => next(new RequestError(404, 'API route not found.')));
  if (assets) {
    app.use(express.static(resolve(assets), { index: false, dotfiles: 'deny', setHeaders(res, path) {
      if (path.includes('assets')) res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } }));
    app.get(['/', '/join', '/sign-in', '/sign-up', '/desktop-sign-in'], (_req, res) => res.sendFile(resolve(assets, 'index.html'), { headers: { 'Cache-Control': 'no-store' } }));
  }
  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'Check the submitted values and try again.' });
    if (error instanceof RequestError) return res.status(error.status).json({ error: error.message });
    if (error.status === 413 || error.status === 400) return res.status(error.status).json({ error: 'Invalid request body.' });
    console.error('Unhandled request error:', error.name);
    return res.status(500).json({ error: 'The server could not complete the request.' });
  });

  const timer = setInterval(async () => {
    desktopAuth.sweep();
    auth.sweep();
    for (const meeting of expired.all(Date.now() - maxDuration)) {
      try { await serial(meeting.id, () => disconnectRoom(findMeeting.get(meeting.id), meeting.owner)); }
      catch { console.error('Meeting cleanup is pending.'); }
    }
    for (const { meeting } of breakouts.pendingMeetings()) {
      try { await serial(meeting, () => cleanupBreakouts(meeting)); }
      catch { console.error('Breakout cleanup is pending.'); }
    }
  }, 30000);
  timer.unref();
  return { app, close() { clearInterval(timer); db.close(); } };
}
