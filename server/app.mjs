import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { AccessToken, DataPacket_Kind, EgressClient, ParticipantInfo_State, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { z } from 'zod';
import { authenticationScope, createInsforgeAuth, insforgeSettings } from './auth.mjs';
import { openDatabase } from './db.mjs';
import { createDesktopAuth } from './desktop-auth.mjs';
import { isTeamUpload, registerTeamChat } from './team-chat.mjs';
import { googleCalendarRoutes } from './google-calendar.mjs';
import { outlookRoutes } from './outlook.mjs';
import { calendarFeedRoutes } from './calendar-feed.mjs';
import { calendarRemovalQueue } from './calendar-removals.mjs';
import { bookingRoutes } from './bookings.mjs';
import { registerPersonalWorkspace } from './personal-workspace.mjs';
import { breakoutStore } from './breakouts.mjs';
import { registerBreakoutVoice } from './breakout-voice.mjs';
import { breakoutHelpTopic } from './breakout-voice-format.mjs';
import { breakoutEmail, breakoutEmailKey } from './breakout-identity.mjs';
import { registerBreakoutPlans } from './breakout-plans.mjs';
import { registerMeetingSeries } from './meeting-series.mjs';
import { meetingPolicySchema } from './meeting-policy.mjs';
import { checkPasscode, encodePasscode } from './meeting-passcode.mjs';
import { cloudCommand, cloudRecordingId, createCloudRecording } from './cloud-recording.mjs';
import { recordingStorage, streamRecording } from './cloud-recording-download.mjs';

const maxDuration = 30 * 60 * 60 * 1000;
const hostReconnectGrace = 30_000;
const hostCheckBatch = 12;
const optionalPasscode = z.string().min(8).max(128).optional();
const person = z.string().trim().min(1).max(60);
const participantIdentity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const meetingTitle = z.string().trim().min(1).max(100);
const duration = z.number().int().min(15).max(1800);
const alternativeHostList = z.array(breakoutEmail).max(5)
  .refine(emails => new Set(emails).size === emails.length, 'Use distinct alternative host addresses.');
const schedule = z.object({
  title: meetingTitle,
  name: person,
  startAt: z.iso.datetime().optional(),
  duration: duration.default(60),
  additionalStarts: z.array(z.iso.datetime()).max(51).default([]),
  lobby: z.boolean().default(true),
  allowGuests: z.boolean().default(false),
  encrypted: z.boolean().default(false),
  alternativeHosts: alternativeHostList.default([]),
  passcode: optionalPasscode,
}).strict();
const reschedule = z.object({ title: meetingTitle, startAt: z.iso.datetime(), duration, alternativeHosts: alternativeHostList.optional() }).strict();
const join = z.object({ name: person, passcode: optionalPasscode, keyReady: z.boolean().optional() }).strict();
const guestJoin = join.extend({ proof: z.string().regex(/^[a-f0-9]{32}$/) });
const roomIdSchema = z.string().regex(/^(?:breakout_)?[A-Za-z0-9_-]{16}$/);
const breakoutId = z.string().regex(/^breakout_[A-Za-z0-9_-]{16}$/);
const routingRequest = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  roomId: roomIdSchema,
  placementEpoch: z.number().int().nonnegative().safe().default(0),
  breakoutRoomId: breakoutId.nullable().optional(),
}).strict();
const moderatorRoomRequest = routingRequest.pick({ key: true, roomId: true, placementEpoch: true }).extend({
  destination: breakoutId.nullable(),
}).strict();
const breakoutCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open-plan') }).strict(),
  z.object({ action: z.literal('open'), selfSelect: z.boolean().default(false),
    durationSeconds: z.number().int().min(30).max(7200).optional(), rooms: z.array(z.object({
    name: z.string().trim().min(1).max(40), members: z.array(participantIdentity).max(99),
  }).strict()).min(1).max(8) }).strict(),
  z.object({ action: z.literal('close'), delaySeconds: z.number().int().min(1).max(120).optional() }).strict(),
  z.object({ action: z.literal('announce'), text: z.string().trim().min(1).max(300) }).strict(),
  z.object({ action: z.literal('resolve-help'), roomId: breakoutId }).strict(),
  z.object({ action: z.literal('move-attendee'), identity: participantIdentity, from: roomIdSchema, destination: breakoutId.nullable() }).strict(),
]);
const placementTopic = 'meetrix.room-placement';
const hostRolesTopic = 'meetrix.host-roles';
const breakoutMessageTopic = 'meetrix.breakout-announcement';
const microphoneRequestTopic = 'meetrix.microphone-request';
const moderation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('transfer-host'), identity: participantIdentity,
    sid: z.string().regex(/^PA_[A-Za-z0-9]{1,64}$/) }).strict(),
  z.object({ action: z.literal('reclaim-host') }).strict(),
  z.object({ action: z.literal('co-host'), identity: participantIdentity,
    sid: z.string().regex(/^PA_[A-Za-z0-9]{1,64}$/), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('decide'), identity: participantIdentity, admit: z.boolean() }).strict(),
  z.object({ action: z.literal('lock'), locked: z.boolean() }).strict(),
  z.object({ action: z.literal('mute'), identity: participantIdentity }).strict(),
  z.object({ action: z.literal('ask-unmute'), identity: participantIdentity }).strict(),
  z.object({ action: z.literal('stop-video'), identity: participantIdentity }).strict(),
  z.object({ action: z.literal('mute-all') }).strict(),
  z.object({ action: z.literal('wait'), identity: participantIdentity }).strict(),
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

function scheduledTime(input, now) {
  const time = input ? Date.parse(input) : now;
  if (!Number.isFinite(time) || time < now - 60000 || time > now + 366 * 86400000) {
    throw new RequestError(400, 'Choose a start time within the next year.');
  }
  return time;
}

const activeHost = meeting => meeting.host_identity ?? meeting.owner;
const reclaimOrganizer = meeting => !meeting.stopped_at && meeting.alternative_host_started && meeting.host_version === 1 ? meeting.owner : null;
const reservedMainRoom = (meeting, identity) => identity === activeHost(meeting) || identity === reclaimOrganizer(meeting);
const alternativeHosts = meeting => meeting.alternative_hosts ? JSON.parse(meeting.alternative_hosts) : [];

function view(meeting, userId) {
  return {
    id: meeting.id, title: meeting.title, ownerName: meeting.owner_name, startAt: meeting.start_at, duration: meeting.duration_minutes,
    openedAt: meeting.opened_at, stoppedAt: meeting.stopped_at, lobby: !!meeting.lobby,
    locked: !!meeting.locked, encrypted: !!meeting.encrypted, hasPasscode: !!meeting.passcode, isHost: activeHost(meeting) === userId,
    sequence: meeting.calendar_revision,
    ...(meeting.owner === userId && meeting.alternative_hosts && !meeting.opened_at && !meeting.stopped_at
      ? { alternativeHosts: alternativeHosts(meeting) } : {}),
    ...(reclaimOrganizer(meeting) ? { reclaimOrganizer: meeting.owner } : {}),
    ...(meeting.owner === userId && meeting.series_id ? { seriesIndex: meeting.series_index } : {}),
  };
}

export function createApp(options, dependencies = {}) {
  const { origin, livekitUrl, livekitKey, livekitSecret, cloudRecording, googleCalendar, outlook,
    databasePath, assets, trustProxyHops = 0, dev = false, desktop = false } = options;
  const meetingPolicy = meetingPolicySchema.parse(options.meetingPolicy ?? {});
  const db = dependencies.db ?? openDatabase(databasePath);
  const calendarRemovals = calendarRemovalQueue(db);
  const stopScheduled = db.prepare(`UPDATE meetings SET stopped_at = ?, cleaned_at = ?,
    calendar_revision = calendar_revision + 1 WHERE id = ?`);
  const stopCalendarSync = db.prepare('DELETE FROM calendar_automation WHERE meeting = ?');
  function cancelScheduled(id, now, removeLinkedEvents) {
    stopScheduled.run(now, now, id);
    stopCalendarSync.run(id);
    return removeLinkedEvents ? calendarRemovals.enqueue(id, now) : 0;
  }
  const breakouts = breakoutStore(db);
  const settings = insforgeSettings(options.insforgeUrl, options.insforgeAnonKey);
  const scope = authenticationScope(settings.insforgeUrl);
  const emailKey = breakoutEmailKey(db, scope);
  const rooms = dependencies.rooms ?? (livekitKey && new RoomServiceClient(
    livekitUrl.replace(/^ws/, 'http'), livekitKey, livekitSecret, { requestTimeout: 7 },
  ));
  const app = express();
  const egress = !desktop && cloudRecording && rooms && origin.startsWith('https://') && livekitUrl?.startsWith('wss://')
    ? dependencies.egress ?? new EgressClient(livekitUrl.replace(/^ws/, 'http'), livekitKey, livekitSecret, { requestTimeout: 15 })
    : null;
  const cloudStorage = egress ? dependencies.cloudStorage ?? recordingStorage(cloudRecording) : null;
  const publicConfig = { authProvider: 'insforge', desktop, desktopBrowserSignIn: true, mediaReady: Boolean(rooms),
    cloudRecording: Boolean(egress), googleCalendar: Boolean(googleCalendar), outlook: Boolean(outlook), meetingPolicy };
  const mediaOrigin = livekitUrl ? new URL(livekitUrl).origin : null;
  const localLoopback = new URL(origin).protocol === 'http:';
  const api = express.Router();
  const queues = new Map();
  const findMeeting = db.prepare('SELECT * FROM meetings WHERE id = ?');
  const findGuest = db.prepare('SELECT * FROM attendance WHERE meeting = ? AND identity = ?');
  const saveBreakoutEmailKey = db.prepare('UPDATE attendance SET breakout_email_key = ? WHERE meeting = ? AND identity = ?');
  const findCoHost = db.prepare('SELECT sid FROM meeting_cohosts WHERE meeting = ? AND identity = ?');
  const listCoHosts = db.prepare('SELECT identity, sid FROM meeting_cohosts WHERE meeting = ? ORDER BY identity');
  const meetingsWithCoHosts = db.prepare(`SELECT id FROM meetings WHERE id > ? AND opened_at > ? AND stopped_at IS NULL
    AND EXISTS (SELECT 1 FROM meeting_cohosts WHERE meeting = meetings.id) ORDER BY id LIMIT ?`);
  const absentHosts = new Map();
  const grantCoHost = db.prepare(`INSERT INTO meeting_cohosts(meeting, identity, sid) VALUES(?, ?, ?)
    ON CONFLICT(meeting, identity) DO UPDATE SET sid = excluded.sid`);
  const revokeCoHost = db.prepare('DELETE FROM meeting_cohosts WHERE meeting = ? AND identity = ?');
  const clearCoHosts = db.prepare('DELETE FROM meeting_cohosts WHERE meeting = ?');
  const readHandoff = db.prepare('SELECT room, nonce, expires_at FROM moderator_room_handoffs WHERE meeting = ? AND identity = ?');
  const saveHandoff = db.prepare(`INSERT INTO moderator_room_handoffs(meeting, identity, room, nonce, expires_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(meeting, identity) DO UPDATE SET room=excluded.room, nonce=excluded.nonce, expires_at=excluded.expires_at`);
  const dropHandoff = db.prepare('DELETE FROM moderator_room_handoffs WHERE meeting = ? AND identity = ?');
  const expireHandoffs = db.prepare('DELETE FROM moderator_room_handoffs WHERE expires_at <= ?');
  const setDecision = db.prepare('UPDATE attendance SET decision = ? WHERE meeting = ? AND identity = ?');
  const beginWaiting = db.prepare(`UPDATE attendance SET decision = 'pending', requested_at = ?,
    placement_epoch = placement_epoch + 1, waiting_evicting = 1 WHERE meeting = ? AND identity = ?`);
  const finishWaiting = db.prepare('UPDATE attendance SET waiting_evicting = 0 WHERE meeting = ? AND identity = ?');
  const waitingEvictions = db.prepare(`SELECT attendance.meeting, attendance.identity FROM attendance
    JOIN meetings ON meetings.id = attendance.meeting
    WHERE attendance.waiting_evicting = 1 AND meetings.stopped_at IS NULL LIMIT 50`);
  const log = db.prepare('INSERT INTO audit(meeting, actor, event, subject, created_at) VALUES(?, ?, ?, ?, ?)');
  const start = db.prepare('UPDATE meetings SET opened_at = ? WHERE id = ? AND opened_at IS NULL');
  const startAsAlternative = db.prepare(`UPDATE meetings SET opened_at = ?, host_identity = ?, host_version = host_version + 1,
    alternative_host_started = 1 WHERE id = ? AND opened_at IS NULL AND stopped_at IS NULL`);
  const admitAlternative = db.prepare(`INSERT INTO attendance(meeting, identity, name, decision, requested_at)
    VALUES(?, ?, ?, 'admitted', ?) ON CONFLICT(meeting, identity) DO UPDATE SET name = excluded.name, decision = 'admitted'`);
  const markEnded = db.prepare('UPDATE meetings SET stopped_at = COALESCE(stopped_at, ?) WHERE id = ?');
  const markCleaned = db.prepare('UPDATE meetings SET cleaned_at = ? WHERE id = ?');
  const expired = db.prepare('SELECT id FROM meetings WHERE (stopped_at IS NOT NULL AND cleaned_at IS NULL) OR (stopped_at IS NULL AND opened_at <= ?) LIMIT 50');
  const addPreviousHost = db.prepare(`INSERT INTO attendance(meeting, identity, name, decision, requested_at)
    VALUES(?, ?, ?, 'admitted', ?) ON CONFLICT(meeting, identity) DO NOTHING`);
  const assignHost = db.prepare('UPDATE meetings SET host_identity = ?, host_version = host_version + 1 WHERE id = ?');
  const cloud = egress && createCloudRecording({
    db, egress, settings: cloudRecording, origin, livekitUrl, activeHost, meetingEnded,
    getMeeting: id => findMeeting.get(id),
    hasBreakouts: id => breakouts.list(id).length > 0,
    isAttendee: (meeting, identity) => !identity.startsWith('guest_') &&
      (identity === activeHost(meeting) || findGuest.get(meeting.id, identity)?.decision === 'admitted' &&
        !breakouts.assigned(meeting.id, identity)),
    listParticipants: id => media(client => client.listParticipants(id)),
    log: (id, actor, event, subject) => log.run(id, actor, event, subject, Date.now()),
    error: (status, message) => new RequestError(status, message),
  });

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
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
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
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json') && !isTeamUpload(req)) {
      throw new RequestError(415, 'Send a JSON request.');
    }
    next();
  });
  api.use(express.json({ limit: '56kb' }));
  const bookings = bookingRoutes(db, origin, limitOptions, meetingPolicy);
  bookings.public(api);
  const calendarFeed = calendarFeedRoutes(db, origin, limitOptions);
  calendarFeed.public(api);
  const google = googleCalendarRoutes({ db, origin, settings: googleCalendar, limits: limitOptions, serial, scheduledTime, calendarRemovals,
    request: dependencies.googleCalendarRequest, error: (status, message) => new RequestError(status, message) });
  google?.public(api);
  const msOutlook = outlookRoutes({ db, origin, settings: outlook, limits: limitOptions, serial, scheduledTime, calendarRemovals,
    request: dependencies.outlookRequest, error: (status, message) => new RequestError(status, message) });
  msOutlook?.public(api);
  const desktopAuth = createDesktopAuth({ db, origin, scope, limitOptions });
  const auth = createInsforgeAuth({ db, origin, ...settings, sessions: desktopAuth, limitOptions, createAuth: dependencies.createAuth, emailKey });
  const authenticate = dependencies.authenticate ?? auth.currentAccount;
  api.use('/auth', auth.router);
  api.use('/desktop-auth', desktopAuth.router);
  api.get('/recording-template', rateLimit({ ...limitOptions, limit: 300 }), (req, res) => {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') ?? '')?.[1];
    const template = token && cloud?.template(token);
    if (!template) throw new RequestError(404, 'Recording template is unavailable.');
    res.json(template);
  });
  api.post('/meetings/:id/guest', rateLimit({ ...limitOptions, limit: 45 }), async (req, res) => {
    if (req.get('origin') !== origin) throw new RequestError(403, 'This origin is not allowed.');
    const { proof, ...input } = guestJoin.parse(req.body);
    const meeting = meetingFor(req);
    if (meetingPolicy.requireSignIn || !meeting.allow_guests || !meeting.lobby) throw new RequestError(403, 'Sign in to join this meeting.');
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
      if (!identity) throw new RequestError(403, 'Your meeting session is no longer active.');
      if (meetingPolicy.requireSignIn && (identity.startsWith('guest_') || await placementIdentity(req) !== identity)) {
        throw new RequestError(403, 'Use your signed-in account to continue in this meeting.');
      }
      if (current.encrypted) {
        if (input.roomId !== current.id || input.breakoutRoomId !== undefined) {
          throw new RequestError(403, 'Encrypted meetings only use their main room.');
        }
        if (!meetingPolicy.requireSignIn && !identity.startsWith('guest_') && await placementIdentity(req) !== identity) {
          throw new RequestError(403, 'Use your signed-in session to continue in the encrypted meeting.');
        }
      }
      const participant = findGuest.get(current.id, identity);
      if (input.breakoutRoomId === undefined && participant?.decision === 'pending') {
        return { waiting: true, placementEpoch: participant.placement_epoch };
      }
      if (identity !== activeHost(current) && participant?.decision !== 'admitted') {
        throw new RequestError(403, 'Your meeting session is no longer active.');
      }
      if (input.breakoutRoomId === undefined) assignScheduledBreakout(current, participant);
      const target = currentLocation(current.id, identity);
      const placementEpoch = participant?.placement_epoch ?? 0;
      if (current.encrypted && input.placementEpoch > placementEpoch) {
        throw new RequestError(409, 'Your meeting admission changed. Rejoin the meeting.');
      }
      if (input.breakoutRoomId !== undefined) {
        if (target.roomId !== input.roomId || placementEpoch !== input.placementEpoch) {
          throw new RequestError(409, 'Your breakout placement changed. Try again from your current room.');
        }
        return selectBreakout(current, identity, target.roomId, input.breakoutRoomId);
      }
      const handoff = moderatorRoomMetadata(current.id, identity, target.roomId);
      if (handoff) {
        if (await placementIdentity(req) !== identity) {
          throw new RequestError(403, 'Use your signed-in session to continue as co-host.');
        }
        await isActiveCoHost(current, identity);
      }
      const roles = meetingRoles(current, target.roomId);
      const breakoutChoices = await availableBreakouts(current, identity);
      const closesAt = target.breakoutName ? breakouts.closesAt(current.id) : null;
      const placement = { ...roles, placementEpoch, ...(closesAt ? { breakoutClosesAt: closesAt } : {}),
        ...(breakoutChoices.length ? { breakoutChoices } : {}) };
      if (target.roomId === input.roomId && placementEpoch === input.placementEpoch) {
        return { roomId: target.roomId, ...placement };
      }
      await ensureMediaRoom(target.roomId);
      return { ...target, ...placement, token: await mediaToken(target.roomId, identity, participant?.name ?? current.owner_name,
        moderatorRoomMetadata(current.id, identity, target.roomId)) };
    });
    res.json(grant);
  });
  api.post('/meetings/:id/breakout-help', rateLimit({ ...limitOptions, limit: 30 }), async (req, res) => {
    if (req.get('origin') !== origin) throw new RequestError(403, 'This origin is not allowed.');
    const { key } = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(req.body);
    const meeting = meetingFor(req);
    const requested = await serial(meeting.id, async () => {
      const current = findMeeting.get(meeting.id);
      const identity = breakouts.identity(current.id, key);
      if (meetingPolicy.requireSignIn && (!identity || identity.startsWith('guest_') || await placementIdentity(req) !== identity)) {
        throw new RequestError(403, 'Use your signed-in account to continue in this meeting.');
      }
      const assigned = identity && breakouts.assigned(current.id, identity);
      if (current.encrypted || meetingEnded(current) || !assigned || findGuest.get(current.id, identity)?.decision !== 'admitted') {
        throw new RequestError(403, 'Help requests are available from active breakout rooms.');
      }
      if (!breakouts.askForHelp(assigned.id)) return false;
      const hostRoom = currentLocation(current.id, activeHost(current)).roomId;
      await media(client => client.sendData(hostRoom, Uint8Array.of(1), DataPacket_Kind.RELIABLE,
        { topic: breakoutHelpTopic, destinationIdentities: [activeHost(current)] })).catch(() => {});
      return true;
    });
    res.json({ requested });
  });
  async function bearerAccount(req) {
    const token = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(req.get('authorization') || '')?.[1];
    if (!token) throw new RequestError(401, 'Sign in to continue.');
    try { return await authenticate(token); }
    catch { throw new RequestError(401, 'Your sign-in has expired or could not be verified.'); }
  }
  async function placementIdentity(req) {
    const account = req.get('authorization') ? await bearerAccount(req) : desktopAuth.session(req);
    return typeof account === 'string' ? account : account?.identity;
  }
  api.use(async (req, _res, next) => {
    if (req.get('authorization')) {
      const account = await bearerAccount(req);
      req.identity = typeof account === 'string' ? account : account.identity;
      req.breakoutEmailKey = account.breakout_email_key ?? null;
    } else {
      const session = desktopAuth.session(req);
      if (!session) throw new RequestError(401, 'Sign in to continue.');
      if (!['GET', 'HEAD'].includes(req.method) && req.get('origin') !== origin) {
        throw new RequestError(403, 'This origin is not allowed.');
      }
      req.identity = session.identity;
      req.breakoutEmailKey = session.breakout_email_key;
    }
    next();
  });
  const byIdentity = (limit) => rateLimit({ ...limitOptions, limit, keyGenerator: req => req.identity });
  const breakoutVoice = registerBreakoutVoice(api, {
    byIdentity, serial, meetingFor, getMeeting: id => findMeeting.get(id),
    activeRooms: meeting => {
      const closesAt = breakouts.closesAt(meeting.id);
      return closesAt && closesAt <= Date.now() ? [] : breakouts.list(meeting.id).filter(room => room.members.length);
    },
    async requireSpeaker(meeting, identity) {
      if (meeting.encrypted || meetingEnded(meeting) || !meeting.opened_at) {
        throw new RequestError(403, 'Voice announcements require an open standard meeting.');
      }
      const delegated = identity === activeHost(meeting) ? null : findCoHost.get(meeting.id, identity);
      if (breakouts.assigned(meeting.id, identity) || identity !== activeHost(meeting) &&
          (!delegated || findGuest.get(meeting.id, identity)?.decision !== 'admitted')) {
        throw new RequestError(403, 'Only a connected breakout moderator can send a voice announcement.');
      }
      const participant = await mainParticipant(meeting, identity);
      if (!participant?.sid || delegated && delegated.sid !== participant.sid) {
        throw new RequestError(403, 'Join the main meeting before sending a voice announcement.');
      }
      return participant;
    },
    send: (id, data, kind, options) => media(client => client.sendData(id, data, kind, options)),
    log: (meeting, actor, target) => log.run(meeting, actor, 'announce-breakout-voice', target, Date.now()),
    error: (status, message) => new RequestError(status, message),
  });
  registerPersonalWorkspace(api, db, byIdentity);
  registerTeamChat(api, db, byIdentity);
  bookings.owner(api, byIdentity);
  calendarFeed.owner(api, byIdentity);
  google?.authenticated(api, byIdentity);
  msOutlook?.authenticated(api, byIdentity);

  function meetingFor(req) {
    if (!/^[A-Za-z0-9_-]{16}$/.test(req.params.id)) throw new RequestError(404, 'Meeting not found.');
    const meeting = findMeeting.get(req.params.id);
    if (!meeting) throw new RequestError(404, 'Meeting not found.');
    return meeting;
  }
  function requireHost(meeting, actor) {
    if (activeHost(meeting) !== actor) throw new RequestError(403, 'Only the host can do that.');
  }
  function mainParticipant(meeting, identity) {
    return participantIn(meeting.id, identity);
  }
  async function participantIn(roomId, identity) {
    const participant = await lookupParticipant(roomId, identity);
    return participant?.state === ParticipantInfo_State.ACTIVE ? participant : null;
  }
  function lookupParticipant(roomId, identity) {
    return media(async client => {
      try { return await client.getParticipant(roomId, identity); }
      catch (error) { if (isNotFound(error)) return null; throw error; }
    });
  }
  async function isActiveCoHost(meeting, identity) {
    const grant = findCoHost.get(meeting.id, identity);
    if (!grant || findGuest.get(meeting.id, identity)?.decision !== 'admitted') return false;
    const { roomId } = currentLocation(meeting.id, identity);
    const participant = await participantIn(roomId, identity);
    if (!participant?.sid || findCoHost.get(meeting.id, identity)?.sid !== grant.sid ||
        findGuest.get(meeting.id, identity)?.decision !== 'admitted' || currentLocation(meeting.id, identity).roomId !== roomId) return false;
    if (participant.sid === grant.sid) return true;
    const expected = moderatorRoomMetadata(meeting.id, identity, roomId);
    if (!expected || participant.metadata !== expected) return false;
    grantCoHost.run(meeting.id, identity, participant.sid);
    dropHandoff.run(meeting.id, identity);
    return true;
  }
  async function requireModerator(meeting, actor) {
    if (activeHost(meeting) === actor) return;
    if (meetingEnded(meeting) || !(await isActiveCoHost(meeting, actor))) {
      throw new RequestError(403, 'Only the host or a connected co-host can do that.');
    }
  }
  function requireAccess(meeting, actor) {
    if (meeting.encrypted) throw new RequestError(403, 'Server-stored collaboration is disabled for encrypted meetings.');
    if (activeHost(meeting) !== actor && findGuest.get(meeting.id, actor)?.decision !== 'admitted') {
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
    absentHosts.delete(meeting.id);
    breakoutVoice.stop(meeting.id);
    await cloud?.stopMeeting(meeting, 'The meeting ended.');
    if (!meeting.stopped_at) {
      markEnded.run(Date.now(), meeting.id);
      log.run(meeting.id, actor, 'end', null, Date.now());
    }
    if (meeting.cleaned_at) return;
    clearCoHosts.run(meeting.id);
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
    return { roomId: assigned?.id ?? meetingId, breakoutName: assigned?.name ?? null, moderatorVisit: Boolean(assigned?.moderatorVisit) };
  }
  function prepareModeratorHandoff(meeting, identity, room) {
    if (findCoHost.get(meeting, identity)) {
      saveHandoff.run(meeting, identity, room, 'meetrix-handoff:' + randomBytes(24).toString('base64url'), Date.now() + 40000);
    }
  }
  function moderatorRoomMetadata(meeting, identity, room) {
    const handoff = readHandoff.get(meeting, identity);
    return handoff?.room === room && handoff.expires_at > Date.now() ? handoff.nonce : undefined;
  }
  function ensureMediaRoom(room) {
    return media(client => client.createRoom({ name: room, emptyTimeout: 120, departureTimeout: 60, maxParticipants: 100 }));
  }
  async function mediaToken(room, identity, name, metadata) {
    const token = new AccessToken(livekitKey, livekitSecret, { identity, name, metadata, ttl: '50s' });
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
  function participantRooms(meeting, identity) {
    return [meeting, ...breakouts.assignedUncleaned(meeting, identity).map(room => room.id)];
  }
  function removeFromRooms(roomIds, identity, options) {
    return media(async client => {
      const results = await Promise.allSettled(roomIds.map(room => client.removeParticipant(room, identity, options)));
      const failure = results.find(result => result.status === 'rejected' && !isNotFound(result.reason));
      if (failure) throw failure.reason;
    });
  }
  async function availableBreakouts(meeting, identity) {
    const location = currentLocation(meeting.id, identity);
    if (meeting.encrypted || reservedMainRoom(meeting, identity) || location.moderatorVisit) return [];
    const choices = breakouts.choices(meeting.id);
    if (choices.length && (moderatorRoomMetadata(meeting.id, identity, location.roomId) ||
        await isActiveCoHost(meeting, identity))) return [];
    return choices;
  }
  async function selectBreakout(meeting, identity, currentRoom, destination) {
    const choices = await availableBreakouts(meeting, identity);
    if (!choices.length) throw new RequestError(403, 'Attendee room selection is unavailable.');
    if (destination && !choices.some(room => room.id === destination)) {
      throw new RequestError(404, 'That breakout room is unavailable.');
    }
    return moveBetweenRooms(meeting, identity, currentRoom, destination);
  }
  async function moveBetweenRooms(meeting, identity, currentRoom, destination, { moderatorVisit = false, actor = identity } = {}) {
    const nextRoom = destination ?? meeting.id;
    if (nextRoom === currentRoom) return { ok: true };
    await ensureMediaRoom(nextRoom);
    // Disconnect the source before allowing a new media grant. The cutoff also
    // revokes older source grants on LiveKit Cloud.
    const cutoff = Math.floor(Date.now() / 1000) + 1;
    await removeFromRooms([currentRoom], identity, { revokeTokenTs: BigInt(cutoff) });
    const remaining = cutoff * 1000 - Date.now();
    if (remaining > 0) await delay(remaining);
    breakouts.select(meeting.id, identity, destination, moderatorVisit);
    if (moderatorVisit) prepareModeratorHandoff(meeting.id, identity, nextRoom);
    if (actor !== identity) log.run(meeting.id, actor, 'reassign-breakout', identity, Date.now());
    else log.run(meeting.id, identity, moderatorVisit ? 'moderator-room-move' : 'select-breakout', nextRoom, Date.now());
    return { ok: true };
  }
  async function completeWaitingEviction(meeting, identity) {
    if (!findGuest.get(meeting, identity)?.waiting_evicting) return;
    const roomIds = participantRooms(meeting, identity);
    // LiveKit Cloud rejects tokens issued before this timestamp. Wait for the
    // cutoff before allowing a moderator to issue a fresh admission.
    const cutoff = Math.floor(Date.now() / 1000) + 1;
    await Promise.all([
      removeFromRooms(roomIds, identity, { revokeTokenTs: BigInt(cutoff) }),
      ...roomIds.map(room => signalPlacement(room, [identity])),
    ]);
    const remaining = cutoff * 1000 - Date.now();
    if (remaining > 0) await delay(remaining);
    breakouts.removeMember(meeting, identity);
    finishWaiting.run(meeting, identity);
  }
  function meetingRoles(meeting, roomId = meeting.id) {
    return { hostIdentity: activeHost(meeting), hostVersion: meeting.host_version,
      coHosts: listCoHosts.all(meeting.id).filter(({ identity }) =>
        roomId === meeting.id || breakouts.assigned(meeting.id, identity)?.id === roomId) };
  }
  function signalHostTransfer(meeting) {
    if (meeting.encrypted) return signalPlacement(meeting.id);
    const data = new TextEncoder().encode(JSON.stringify({
      hostIdentity: activeHost(meeting), hostVersion: meeting.host_version,
    }));
    const roomIds = [meeting.id, ...breakouts.list(meeting.id).map(room => room.id)];
    return Promise.allSettled(roomIds.map(id => media(client => client.sendData?.(id, data, DataPacket_Kind.RELIABLE, { topic: hostRolesTopic }))));
  }
  async function changeHost(meeting, successor, event, { verify, actor = activeHost(meeting) } = {}) {
    await cloud?.stopMeeting(meeting, 'Meeting control changed.');
    if (verify && (!(await verify()) || meetingEnded(meeting))) return meeting;
    const previousHost = activeHost(meeting);
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      addPreviousHost.run(meeting.id, previousHost, meeting.owner_name, now);
      revokeCoHost.run(meeting.id, successor);
      assignHost.run(successor, meeting.id);
      log.run(meeting.id, actor, event, successor, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    absentHosts.delete(meeting.id);
    breakoutVoice.stop(meeting.id, previousHost);
    const updated = findMeeting.get(meeting.id);
    await signalHostTransfer(updated);
    return updated;
  }
  async function hostIsPresent(meeting) {
    const host = activeHost(meeting);
    const participant = await lookupParticipant(currentLocation(meeting.id, host).roomId, host);
    return Boolean(participant && participant.state !== ParticipantInfo_State.DISCONNECTED);
  }
  async function checkHost(meetingId, now) {
    const meeting = findMeeting.get(meetingId);
    const delegates = listCoHosts.all(meetingId);
    if (meetingEnded(meeting) || !delegates.length || await hostIsPresent(meeting)) {
      absentHosts.delete(meetingId);
      return;
    }
    const absence = absentHosts.get(meetingId);
    if (!absence || absence.version !== meeting.host_version) {
      absentHosts.set(meetingId, { version: meeting.host_version, since: now, checkedAt: now });
      return;
    }
    absence.checkedAt = now;
    if (now - absence.since < hostReconnectGrace) return;
    for (const { identity } of delegates) {
      if (identity.startsWith('guest_') || !(await isActiveCoHost(meeting, identity))) continue;
      await changeHost(meeting, identity, 'host-succession', { verify: async () => {
        if (!(await isActiveCoHost(meeting, identity))) return false;
        if (!(await hostIsPresent(meeting))) return true;
        absentHosts.delete(meetingId);
        return false;
      } });
      return;
    }
  }
  let hostCheckCursor = '';
  let checkingHosts = false;
  async function checkHostContinuity(now = performance.now()) {
    if (checkingHosts || !rooms) return;
    checkingHosts = true;
    try {
      for (const [meeting, absence] of absentHosts) {
        if (now - absence.checkedAt > 600_000) absentHosts.delete(meeting);
      }
      const upcoming = meetingsWithCoHosts.all(hostCheckCursor, Date.now() - maxDuration, hostCheckBatch);
      hostCheckCursor = upcoming.length === hostCheckBatch ? upcoming.at(-1).id : '';
      await Promise.all(upcoming.map(({ id }) => serial(id, () => checkHost(id, now)).catch(() => {
        // An unavailable room service is not evidence that the host left.
        absentHosts.delete(id);
      })));
    } finally { checkingHosts = false; }
  }
  function muteTracks(client, roomId, participant, source) {
    return Promise.all(participant.tracks.filter(track => track.source === source && !track.muted)
      .map(track => client.mutePublishedTrack(roomId, participant.identity, track.sid, true)));
  }

  api.post('/meetings/:id/moderator-location', byIdentity(30), async (req, res) => {
    const input = moderatorRoomRequest.parse(req.body);
    const meeting = meetingFor(req);
    const result = await serial(meeting.id, async () => {
      const current = findMeeting.get(meeting.id);
      if (!current.opened_at || meetingEnded(current) || current.encrypted) {
        throw new RequestError(409, 'Moderator visits require an open standard meeting.');
      }
      if (breakouts.identity(current.id, input.key) !== req.identity) throw new RequestError(403, 'Use your active meeting session.');
      const location = currentLocation(current.id, req.identity);
      if (location.roomId !== input.roomId || (findGuest.get(current.id, req.identity)?.placement_epoch ?? 0) !== input.placementEpoch) {
        throw new RequestError(409, 'Your room changed. Try again from your current room.');
      }
      const retainedRole = activeHost(current) === req.identity || await isActiveCoHost(current, req.identity);
      if (!retainedRole && !(input.destination === null && location.moderatorVisit && findGuest.get(current.id, req.identity)?.decision === 'admitted')) {
        throw new RequestError(403, 'Only the host or a connected co-host can visit a breakout room.');
      }
      if (!(await participantIn(location.roomId, req.identity))) throw new RequestError(409, 'Connect to the room before moving.');
      if (input.destination && (!breakouts.hasRoom(current.id, input.destination) ||
          (breakouts.closesAt(current.id) ?? Infinity) <= Date.now())) throw new RequestError(404, 'That breakout room has closed.');
      if (location.roomId === current.id && input.destination) breakoutVoice.stop(current.id, req.identity);
      return moveBetweenRooms(current, req.identity, location.roomId, input.destination, { moderatorVisit: retainedRole });
    });
    res.json(result);
  });

  api.get('/meetings', (req, res) => {
    const rows = db.prepare(`
      SELECT meetings.* FROM meetings WHERE owner = ?
      OR (id IN (SELECT meeting FROM attendance WHERE identity = ? AND decision = 'admitted'))
      ORDER BY start_at DESC LIMIT 200
    `).all(req.identity, req.identity);
    res.json(rows.map(row => {
      const meeting = view(row, req.identity);
      if (row.owner === req.identity && row.stopped_at && !row.opened_at) {
        const removals = calendarRemovals.status(row.id);
        if (removals.length) meeting.calendarRemovals = removals;
      }
      return meeting;
    }));
  });

  api.post('/meetings', byIdentity(20), async (req, res) => {
    const input = schedule.parse(req.body);
    if (meetingPolicy.requirePasscode && !input.passcode) throw new RequestError(400, 'This workspace requires a meeting passcode.');
    if (meetingPolicy.requireSignIn && input.allowGuests) throw new RequestError(403, 'This workspace requires participants to sign in.');
    const lobby = meetingPolicy.requireWaitingRoom || input.lobby;
    if (input.alternativeHosts.length && !input.startAt) throw new RequestError(400, 'Schedule the meeting to add alternative hosts.');
    if (input.allowGuests && !lobby) {
      throw new RequestError(400, 'Enable the waiting room to allow guests without an account.');
    }
    const now = Date.now();
    const times = [input.startAt, ...input.additionalStarts].map(startAt => scheduledTime(startAt, now));
    if (times.some((time, index) => index && time <= times[index - 1])) {
      throw new RequestError(400, 'Recurring meeting times must be in order.');
    }
    const passcodes = times.map(() => null);
    if (input.passcode) {
      for (let offset = 0; offset < times.length; offset += 4) {
        const batch = await Promise.all(times.slice(offset, offset + 4).map(() => encodePasscode(input.passcode)));
        passcodes.splice(offset, batch.length, ...batch);
      }
    }
    const insert = db.prepare(`INSERT INTO meetings(id, owner, owner_name, title, start_at, duration_minutes, created_at,
      lobby, allow_guests, passcode, encrypted, series_id, series_index, alternative_hosts) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ids = times.map(() => randomBytes(12).toString('base64url'));
    const seriesId = ids.length > 1 ? ids[0] : null;
    const alternateRoster = input.alternativeHosts.length ? JSON.stringify(input.alternativeHosts) : null;
    db.exec('BEGIN IMMEDIATE');
    try {
      ids.forEach((id, index) => {
        insert.run(id, req.identity, input.name, input.title, times[index], input.duration, now, Number(lobby), Number(input.allowGuests),
          passcodes[index], Number(input.encrypted), seriesId, seriesId ? index : null, alternateRoster);
        log.run(id, req.identity, 'create', null, now);
      });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const scheduledMeetings = ids.map(id => view(findMeeting.get(id), req.identity));
    res.status(201).json({ ...scheduledMeetings[0], scheduledCount: scheduledMeetings.length, scheduledMeetings });
  });

  api.patch('/meetings/:id', byIdentity(30), async (req, res) => {
    const input = reschedule.parse(req.body);
    const initial = meetingFor(req);
    if (initial.owner !== req.identity) throw new RequestError(403, 'Only the meeting organizer can reschedule it.');
    const result = await serial(initial.id, () => {
      const current = findMeeting.get(initial.id);
      if (current.opened_at || current.stopped_at) throw new RequestError(409, 'Only unopened meetings can be rescheduled.');
      const now = Date.now();
      const alternates = input.alternativeHosts === undefined ? current.alternative_hosts :
        input.alternativeHosts.length ? JSON.stringify(input.alternativeHosts) : null;
      db.prepare(`UPDATE meetings SET title = ?, start_at = ?, duration_minutes = ?, alternative_hosts = ?,
        calendar_revision = calendar_revision + 1 WHERE id = ?`)
        .run(input.title, scheduledTime(input.startAt, now), input.duration, alternates, current.id);
      log.run(current.id, req.identity, 'reschedule', null, now);
      return view(findMeeting.get(current.id), req.identity);
    });
    res.json(result);
  });
  api.post('/meetings/:id/cancel', byIdentity(30), async (req, res) => {
    const { removeLinkedEvents } = z.object({ removeLinkedEvents: z.boolean().default(false) }).strict().parse(req.body);
    const initial = meetingFor(req);
    if (initial.owner !== req.identity) throw new RequestError(403, 'Only the meeting organizer can cancel it.');
    const result = await serial(initial.id, () => {
      const current = findMeeting.get(initial.id);
      if (current.opened_at) throw new RequestError(409, 'This meeting has already opened.');
      if (current.stopped_at) return { calendarRemovals: calendarRemovals.status(current.id).length };
      const now = Date.now();
      db.exec('BEGIN IMMEDIATE');
      try {
        const count = cancelScheduled(current.id, now, removeLinkedEvents);
        log.run(current.id, req.identity, 'cancel', null, now);
        db.exec('COMMIT');
        return { calendarRemovals: count };
      } catch (failure) { db.exec('ROLLBACK'); throw failure; }
    });
    res.json(result);
  });
  registerMeetingSeries(api, { db, byIdentity, meetingFor, view, serial, scheduledTime, reschedule, log, cancelScheduled,
    error: (status, message) => new RequestError(status, message) });
  const breakoutPlan = registerBreakoutPlans(api, { db, byIdentity, meetingFor, serial,
    error: (status, message) => new RequestError(status, message) });

  function assignScheduledBreakout(meeting, guest) {
    if (!meeting.encrypted && guest?.decision === 'admitted' && guest.breakout_email_key &&
        !reservedMainRoom(meeting, guest.identity) && !findCoHost.get(meeting.id, guest.identity) &&
        (!breakouts.closesAt(meeting.id) || breakouts.closesAt(meeting.id) > Date.now())) {
      breakouts.assignScheduled(meeting.id, guest.identity, guest.breakout_email_key);
    }
  }

  async function connectMeeting(initial, identity, input, accountless = false, verifiedEmailKey = null) {
    const verified = initial.passcode && !findGuest.get(initial.id, identity)
      ? await checkPasscode(input.passcode, initial.passcode) : true;
    return serial(initial.id, async () => {
      let current = findMeeting.get(initial.id);
      if (meetingEnded(current)) {
        throw new RequestError(410, 'This meeting has ended.');
      }
      const alreadyOpen = Boolean(current.opened_at);
      const alternative = !accountless && !alreadyOpen && identity !== current.owner && verifiedEmailKey &&
        alternativeHosts(current).some(email => emailKey(email) === verifiedEmailKey);
      const isHost = !accountless && (activeHost(current) === identity || alternative);
      if (alternative && findGuest.get(current.id, identity)?.decision === 'denied') {
        throw new RequestError(403, 'The host has declined your request.');
      }
      if (isHost && current.encrypted && !input.keyReady) return { state: 'key-required' };
      if (!isHost) {
        let guest = findGuest.get(current.id, identity);
        if (guest?.decision === 'denied') throw new RequestError(403, 'The host has declined your request.');
        if (current.locked && reclaimOrganizer(current) !== identity) throw new RequestError(423, 'The host has locked the meeting.');
        if (!guest && !verified) throw new RequestError(403, 'Enter the correct meeting passcode.');
        if (!guest) {
          db.prepare('INSERT INTO attendance(meeting, identity, name, decision, requested_at) VALUES(?, ?, ?, ?, ?)')
            .run(current.id, identity, input.name, current.lobby || meetingPolicy.requireWaitingRoom ? 'pending' : 'admitted', Date.now());
          guest = findGuest.get(current.id, identity);
        }
        if (!accountless && !current.encrypted && guest.breakout_email_key !== verifiedEmailKey &&
            breakoutPlan(current.id)?.assignments?.length) {
          saveBreakoutEmailKey.run(verifiedEmailKey, current.id, identity);
          guest.breakout_email_key = verifiedEmailKey;
        }
        if (!current.opened_at || guest.decision !== 'admitted') return { state: 'waiting', hostPresent: !!current.opened_at };
        if (current.encrypted && !input.keyReady) return { state: 'key-required' };
        assignScheduledBreakout(current, guest);
      } else if (!alreadyOpen) {
        await ensureMediaRoom(current.id);
        const now = Date.now();
        if (alternative) {
          db.exec('BEGIN IMMEDIATE');
          try {
            if (!startAsAlternative.run(now, identity, current.id).changes) throw new RequestError(409, 'The meeting opened. Try joining again.');
            addPreviousHost.run(current.id, current.owner, current.owner_name, now);
            admitAlternative.run(current.id, identity, input.name, now);
            log.run(current.id, identity, 'open-as-alternative', current.owner, now);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          current = findMeeting.get(current.id);
        } else {
          if (!start.run(now, current.id).changes) throw new RequestError(409, 'The meeting opened. Try joining again.');
          log.run(current.id, identity, 'open', null, now);
        }
      }
      const location = currentLocation(current.id, identity);
      // Recreate an idle room with the same capacity after LiveKit expires it.
      if (alreadyOpen) await ensureMediaRoom(location.roomId);
      const attendance = findGuest.get(current.id, identity);
      const name = attendance?.name ?? current.owner_name;
      const token = await mediaToken(location.roomId, identity, name, moderatorRoomMetadata(current.id, identity, location.roomId));
      const routingKey = breakouts.issueKey(current.id, identity);
      const breakoutChoices = await availableBreakouts(current, identity);
      const closesAt = location.breakoutName ? breakouts.closesAt(current.id) : null;
      return { state: 'ready', serverUrl: livekitUrl, token, ...location, routingKey,
        cloudRecording: Boolean(cloud && cloud.available(current)),
        placementEpoch: attendance?.placement_epoch ?? 0, ...meetingRoles(current, location.roomId),
        ...(closesAt ? { breakoutClosesAt: closesAt } : {}),
        ...(breakoutChoices.length ? { breakoutChoices } : {}),
        meeting: view(findMeeting.get(current.id), identity), accountless };
    });
  }

  api.post('/meetings/:id/connect', byIdentity(34), async (req, res) => {
    res.json(await connectMeeting(meetingFor(req), req.identity, join.parse(req.body), false, req.breakoutEmailKey));
  });

  api.get('/meetings/:id/cloud-recording', (req, res) => {
    const meeting = meetingFor(req);
    if (!cloud || !cloud.available(meeting)) throw new RequestError(404, 'Cloud recording is unavailable.');
    if (meetingEnded(meeting)) {
      if (!cloud.canViewAfterEnd(meeting, req.identity)) throw new RequestError(403, 'Cloud recording is only available to its requesting host.');
    } else requireAccess(meeting, req.identity);
    res.json(cloud.status(meeting, req.identity));
  });

  api.get('/cloud-recordings', (req, res) => {
    if (!cloud) throw new RequestError(404, 'Cloud recording is unavailable.');
    res.json(cloud.listFiles(req.identity));
  });

  api.get('/cloud-recordings/:id/download', byIdentity(24), async (req, res) => {
    const id = cloudRecordingId.safeParse(req.params.id);
    const key = id.success && cloud?.fileKey(id.data, req.identity);
    if (!key) throw new RequestError(404, 'Recording not found.');
    if (req.method === 'HEAD') return res.sendStatus(405);
    await streamRecording(res, cloudStorage, key, id.data, (status, message) => new RequestError(status, message));
  });

  api.post('/meetings/:id/cloud-recording', byIdentity(45), async (req, res) => {
    const initial = meetingFor(req);
    const command = cloudCommand.parse(req.body);
    const result = await serial(initial.id, async () => {
      const meeting = findMeeting.get(initial.id);
      if (!cloud || !cloud.available(meeting)) throw new RequestError(404, 'Cloud recording is unavailable.');
      requireAccess(meeting, req.identity);
      return cloud.command(meeting, req.identity, command);
    });
    res.json(result);
  });

  api.get('/meetings/:id/lobby', async (req, res) => {
    const meeting = meetingFor(req);
    await requireModerator(meeting, req.identity);
    const guests = db.prepare(`SELECT identity, name, requested_at AS requestedAt, waiting_evicting AS evicting
      FROM attendance WHERE meeting = ? AND decision = 'pending' AND (? = 0 OR identity NOT GLOB 'guest_*')
      ORDER BY requested_at LIMIT 100`)
      .all(meeting.id, Number(meetingPolicy.requireSignIn))
      .map(guest => ({ ...guest, evicting: Boolean(guest.evicting), accountless: guest.identity.startsWith('guest_') }));
    res.json({ guests, locked: !!meeting.locked, ...meetingRoles(findMeeting.get(meeting.id)) });
  });

  async function finishBreakouts(meeting, actor) {
    breakoutVoice.stop(meeting);
    const existing = breakouts.list(meeting);
    const selfSelect = breakouts.choices(meeting).length > 0;
    const current = findMeeting.get(meeting);
    await Promise.all(existing.flatMap(room => room.members.map(async identity => {
      if (!findCoHost.get(meeting, identity) || !breakouts.assigned(meeting, identity)?.moderatorVisit) return;
      if (moderatorRoomMetadata(meeting, identity, room.id) || await isActiveCoHost(current, identity).catch(() => false)) {
        prepareModeratorHandoff(meeting, identity, meeting);
      }
    })));
    if (breakouts.close(meeting)) log.run(meeting, actor, 'close-breakouts', null, Date.now());
    await Promise.all([
      ...existing.filter(room => room.members.length).map(room => signalPlacement(room.id, room.members)),
      ...(selfSelect ? [signalPlacement(meeting)] : []),
    ]);
    await cleanupBreakouts(meeting);
  }

  function breakoutView(meeting) {
    const current = findMeeting.get(meeting);
    const host = activeHost(current);
    const rooms = breakouts.list(meeting).map(({ id, name, members }) => {
      const attendees = [];
      const visitors = [];
      for (const identity of members) {
        const guest = findGuest.get(meeting, identity);
        if (identity === host) visitors.push({ identity, name: guest?.name ?? current.owner_name, isHost: true });
        else if (guest?.decision === 'admitted') {
          const delegate = findCoHost.get(meeting, identity);
          if (delegate && breakouts.assigned(meeting, identity)?.moderatorVisit) visitors.push({ identity, name: guest.name, sid: delegate.sid, isHost: false });
          else attendees.push({ identity, name: guest.name });
        }
      }
      return { id, name, helpRequestedAt: breakouts.helpRequestedAt(id), members: attendees, visitors };
    });
    return { closesAt: breakouts.closesAt(meeting), selfSelect: breakouts.choices(meeting).length > 0, rooms };
  }

  api.get('/meetings/:id/breakouts', async (req, res) => {
    const meeting = meetingFor(req);
    await requireModerator(meeting, req.identity);
    const saved = meeting.encrypted || meetingEnded(meeting) ? null : breakoutPlan(meeting.id);
    const plan = saved ? { names: saved.names, selfSelect: saved.selfSelect, durationMinutes: saved.durationMinutes } : null;
    res.json({ ...breakoutView(meeting.id), plan, ...(saved?.assignments?.length ? { preassignedCount: saved.assignments.length } : {}) });
  });

  async function preparedBreakouts(meeting) {
    const saved = breakoutPlan(meeting.id);
    if (!saved?.assignments?.length) throw new RequestError(409, 'There are no scheduled participant assignments for this meeting.');
    const rooms = saved.names.map(name => ({ name, members: [] }));
    const scheduled = saved.assignments.map(item => ({ key: emailKey(item.email), room: item.room, claimed: false }));
    const byEmail = new Map(scheduled.map(item => [item.key, item]));
    const participants = await media(client => client.listParticipants(meeting.id));
    for (const participant of participants) {
      if (participant.state !== ParticipantInfo_State.ACTIVE || reservedMainRoom(meeting, participant.identity) ||
          findCoHost.get(meeting.id, participant.identity)?.sid === participant.sid) continue;
      const guest = findGuest.get(meeting.id, participant.identity);
      if (guest?.decision !== 'admitted') continue;
      const entry = byEmail.get(guest.breakout_email_key);
      if (!entry || entry.claimed) continue;
      rooms[entry.room].members.push(participant.identity);
      entry.claimed = true;
    }
    return { rooms, selfSelect: saved.selfSelect, durationSeconds: saved.durationMinutes ? saved.durationMinutes * 60 : null, scheduled };
  }

  api.post('/meetings/:id/breakouts', byIdentity(20), async (req, res) => {
    const command = breakoutCommand.parse(req.body);
    const meeting = meetingFor(req);
    const result = await serial(meeting.id, async () => {
      const current = findMeeting.get(meeting.id);
      await requireModerator(current, req.identity);
      if (!current.opened_at || meetingEnded(current)) throw new RequestError(409, 'Start the meeting before managing breakout rooms.');
      if (current.encrypted) throw new RequestError(403, 'Breakout rooms are unavailable in encrypted meetings.');
      const existing = breakouts.list(current.id);
      if (command.action === 'move-attendee') {
        admit(current, command.identity);
        const location = currentLocation(current.id, command.identity);
        if (location.roomId !== command.from) throw new RequestError(409, 'That attendee changed rooms. Refresh and try again.');
        if (location.moderatorVisit || reservedMainRoom(current, command.identity) ||
            moderatorRoomMetadata(current.id, command.identity, location.roomId) || await isActiveCoHost(current, command.identity)) {
          throw new RequestError(403, 'Hosts and co-hosts choose which rooms to visit.');
        }
        if (!existing.length || (command.destination && (!existing.some(room => room.id === command.destination) ||
            (breakouts.closesAt(current.id) ?? Infinity) <= Date.now()))) {
          throw new RequestError(404, 'That breakout room has closed.');
        }
        if (location.roomId === current.id && !(await mainParticipant(current, command.identity))) {
          throw new RequestError(409, 'That attendee is no longer connected to the main meeting.');
        }
        await moveBetweenRooms(current, command.identity, location.roomId, command.destination, { actor: req.identity });
        return breakoutView(current.id);
      }
      if (command.action === 'resolve-help') {
        if (!existing.some(room => room.id === command.roomId)) throw new RequestError(404, 'This breakout room is unavailable.');
        breakouts.resolveHelp(command.roomId);
        return breakoutView(current.id);
      }
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
        if (command.delaySeconds && existing.length) {
          breakouts.scheduleClose(current.id, Date.now() + command.delaySeconds * 1000);
          await Promise.all(existing.filter(room => room.members.length).map(room => signalPlacement(room.id, room.members)));
        } else await finishBreakouts(current.id, req.identity);
      } else {
        if (!rooms) throw new RequestError(503, 'This server needs LiveKit configuration.');
        if (existing.length) throw new RequestError(409, 'Close the current breakout rooms before opening another set.');
        const plan = command.action === 'open-plan' ? await preparedBreakouts(current) : command;
        const identities = plan.rooms.flatMap(room => room.members);
        const names = new Set(plan.rooms.map(room => room.name.toLowerCase()));
        if (names.size !== plan.rooms.length || (!plan.selfSelect && !identities.length && !plan.scheduled?.length) ||
            identities.length > 99 || new Set(identities).size !== identities.length) {
          throw new RequestError(400, 'Use distinct room names and assign each participant to only one room.');
        }
        for (const identity of identities) admit(current, identity);
        for (const identity of identities) {
          if (reservedMainRoom(current, identity) || await isActiveCoHost(current, identity)) {
            throw new RequestError(409, 'Keep hosts, co-hosts, and the organizer who can reclaim control out of attendee assignments.');
          }
        }
        await cloud?.stopMeeting(current, 'Breakout rooms opened.');
        const closesAt = plan.durationSeconds ? Date.now() + plan.durationSeconds * 1000 : null;
        breakouts.open(current.id, plan.rooms, plan.selfSelect, closesAt, plan.scheduled);
        log.run(current.id, req.identity, 'open-breakouts', null, Date.now());
        if (plan.selfSelect || identities.length) await signalPlacement(current.id, plan.selfSelect ? undefined : identities);
      }
      return breakoutView(current.id);
    });
    res.json(result);
  });

  api.post('/meetings/:id/moderate', byIdentity(90), async (req, res) => {
    const command = moderation.parse(req.body);
    const initial = meetingFor(req);
    const roles = await serial(initial.id, async () => {
      const current = findMeeting.get(initial.id);
      const hostIdentity = activeHost(current);
      const host = hostIdentity === req.identity;
      const { roomId } = currentLocation(current.id, req.identity);
      if (command.action === 'reclaim-host') {
        if (meetingEnded(current)) throw new RequestError(410, 'This meeting has ended.');
        if (reclaimOrganizer(current) !== req.identity) throw new RequestError(403, 'Host control can no longer be reclaimed.');
        if (!(await mainParticipant(current, req.identity))) throw new RequestError(409, 'Connect to the main room before reclaiming host control.');
        return meetingRoles(await changeHost(current, req.identity, command.action, { actor: req.identity }));
      }
      if (['end', 'co-host', 'transfer-host'].includes(command.action)) requireHost(current, req.identity);
      else await requireModerator(current, req.identity);
      if (command.action === 'end') {
        await disconnectRoom(current, req.identity);
        return meetingRoles(current);
      }
      if (meetingEnded(current)) throw new RequestError(410, 'This meeting has ended.');
      if (command.action === 'transfer-host') {
        if (!current.opened_at || roomId !== current.id || command.identity === hostIdentity || command.identity.startsWith('guest_')) {
          throw new RequestError(409, 'Choose another signed-in participant in the main meeting.');
        }
        admit(current, command.identity);
        const participant = await mainParticipant(current, command.identity);
        if (participant?.sid !== command.sid || breakouts.assigned(current.id, command.identity)) {
          throw new RequestError(409, 'That participant must be connected to the main meeting.');
        }
        return meetingRoles(await changeHost(current, command.identity, command.action));
      }
      let rolesChanged = false;
      if (command.action === 'co-host') {
        if (command.enabled) {
          if (command.identity === hostIdentity) throw new RequestError(409, 'This participant is already the host.');
          admit(current, command.identity);
          if (command.identity.startsWith('guest_')) throw new RequestError(403, 'Co-hosts must be signed in.');
          const participant = await mainParticipant(current, command.identity);
          if (participant?.sid !== command.sid || breakouts.assigned(current.id, command.identity)) {
            throw new RequestError(409, 'That participant must be connected to the main meeting.');
          }
          dropHandoff.run(current.id, command.identity);
          grantCoHost.run(current.id, command.identity, command.sid);
        } else if (findCoHost.get(current.id, command.identity)?.sid === command.sid) {
          const visiting = breakouts.assigned(current.id, command.identity);
          if (visiting?.moderatorVisit) await moveBetweenRooms(current, command.identity, visiting.id, null, { actor: req.identity });
          revokeCoHost.run(current.id, command.identity);
        } else if (breakouts.assigned(current.id, command.identity)?.moderatorVisit) {
          throw new RequestError(409, 'The co-host connection changed. Refresh the participant list and try again.');
        }
        rolesChanged = true;
      }
      if (['mute', 'ask-unmute', 'stop-video', 'wait', 'remove'].includes(command.action) &&
          (command.identity === hostIdentity ||
           (!host && (command.identity === req.identity || await isActiveCoHost(current, command.identity))))) {
        throw new RequestError(403, 'That participant is protected from this action.');
      }
      if (['wait', 'remove'].includes(command.action) && command.identity === reclaimOrganizer(current)) {
        throw new RequestError(403, 'The organizer can stay in the room while they decide whether to reclaim host control.');
      }
      if (command.action === 'lock') db.prepare('UPDATE meetings SET locked = ? WHERE id = ?').run(Number(command.locked), current.id);
      if (command.action === 'decide') {
        if (meetingPolicy.requireSignIn && command.admit && command.identity.startsWith('guest_')) {
          throw new RequestError(403, 'This workspace requires participants to sign in.');
        }
        const guest = findGuest.get(current.id, command.identity);
        if (guest?.decision !== 'pending') throw new RequestError(409, 'This request has already been handled.');
        if (guest.waiting_evicting) throw new RequestError(409, 'The participant is still being disconnected from the meeting.');
        setDecision.run(command.admit ? 'admitted' : 'denied', current.id, command.identity);
      }
      if (command.action === 'wait') {
        const guest = findGuest.get(current.id, command.identity);
        if (!guest?.waiting_evicting) {
          admit(current, command.identity);
          await cloud?.stopMeeting(current, 'An attendee moved to the waiting room.');
          beginWaiting.run(Date.now(), current.id, command.identity);
          revokeCoHost.run(current.id, command.identity);
          log.run(current.id, req.identity, 'wait', command.identity, Date.now());
        }
        await completeWaitingEviction(current.id, command.identity);
        await signalPlacement(current.id);
        return meetingRoles(current);
      }
      if (command.action === 'remove') {
        const guest = findGuest.get(current.id, command.identity);
        if (!guest || guest.decision === 'pending') throw new RequestError(404, 'Participant not found.');
        await cloud?.stopMeeting(current, 'An attendee was removed.');
        setDecision.run('denied', current.id, command.identity);
        rolesChanged = !!revokeCoHost.run(current.id, command.identity).changes;
        const cutoff = Math.floor(Date.now() / 1000) + 1;
        await removeFromRooms(participantRooms(current.id, command.identity), command.identity, { revokeTokenTs: BigInt(cutoff) });
      }
      if (command.action === 'mute' || command.action === 'stop-video') {
        admit(current, command.identity);
        if (currentLocation(current.id, command.identity).roomId !== roomId) {
          throw new RequestError(409, 'That participant is in a different room.');
        }
        await media(async client => {
          const target = await client.getParticipant(roomId, command.identity);
          const source = command.action === 'mute' ? TrackSource.MICROPHONE : TrackSource.CAMERA;
          await muteTracks(client, roomId, target, source);
        });
      }
      if (command.action === 'ask-unmute') {
        if (roomId !== current.id || breakouts.assigned(current.id, command.identity)) {
          throw new RequestError(403, 'Microphone requests are available in the main room.');
        }
        admit(current, command.identity);
        if (!(await mainParticipant(current, command.identity))) throw new RequestError(409, 'That attendee is no longer connected.');
        await media(client => client.sendData(current.id, Uint8Array.of(1), DataPacket_Kind.RELIABLE, {
          topic: microphoneRequestTopic, destinationIdentities: [command.identity],
        }));
      }
      if (command.action === 'mute-all') {
        const delegates = new Map(listCoHosts.all(current.id).map(({ identity, sid }) => [identity, sid]));
        await media(async client => {
          const attendees = (await client.listParticipants(roomId)).filter(person => person.identity !== hostIdentity &&
            person.identity !== req.identity && delegates.get(person.identity) !== person.sid);
          const results = await Promise.allSettled(attendees.map(person => muteTracks(client, roomId, person, TrackSource.MICROPHONE)));
          if (results.some(result => result.status === 'rejected' && !isNotFound(result.reason))) {
            throw new RequestError(502, 'Some microphones could not be muted. Try again.');
          }
        });
      }
      log.run(current.id, req.identity, command.action, command.identity ?? null, Date.now());
      if (rolesChanged) await Promise.all([signalPlacement(current.id), ...breakouts.list(current.id).map(room => signalPlacement(room.id))]);
      return meetingRoles(current);
    });
    res.json({ ok: true, ...roles });
  });

  const latestPoll = db.prepare('SELECT * FROM polls WHERE meeting = ? ORDER BY id DESC LIMIT 1');
  const voterChoice = db.prepare('SELECT choice FROM votes WHERE poll = ? AND identity = ?');
  function pollView(meeting, actor) {
    const row = latestPoll.get(meeting.id);
    if (!row) return null;
    const choices = JSON.parse(row.choices);
    const votes = row.closed || activeHost(meeting) === actor ? choices.map(() => 0) : null;
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
    app.get('/recording.html', (_req, res) => {
      if (!cloud) return res.sendStatus(404);
      res.sendFile(resolve(assets, 'recording.html'), { headers: { 'Cache-Control': 'no-store' } });
    });
    app.use(express.static(resolve(assets), { index: false, dotfiles: 'deny', setHeaders(res, path) {
      if (path.includes('assets')) res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } }));
    app.get(['/', '/join', '/sign-in', '/sign-up', '/desktop-sign-in', '/book'], (_req, res) => res.sendFile(resolve(assets, 'index.html'), { headers: { 'Cache-Control': 'no-store' } }));
  }
  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'Check the submitted values and try again.' });
    if (error instanceof RequestError) return res.status(error.status).json({ error: error.message });
    if ([400, 413, 415].includes(error.status)) return res.status(error.status).json({ error: 'Invalid request body.' });
    console.error('Unhandled request error:', error.name);
    return res.status(500).json({ error: 'The server could not complete the request.' });
  });

  const timer = setInterval(async () => {
    desktopAuth.sweep();
    auth.sweep();
    expireHandoffs.run(Date.now());
    breakoutVoice.sweep();
    for (const meeting of expired.all(Date.now() - maxDuration)) {
      try { await serial(meeting.id, () => {
        const current = findMeeting.get(meeting.id);
        return disconnectRoom(current, activeHost(current));
      }); }
      catch { console.error('Meeting cleanup is pending.'); }
    }
    for (const { meeting } of breakouts.pendingMeetings()) {
      try { await serial(meeting, () => cleanupBreakouts(meeting)); }
      catch { console.error('Breakout cleanup is pending.'); }
    }
    for (const { meeting, identity } of waitingEvictions.all()) {
      try { await serial(meeting, () => completeWaitingEviction(meeting, identity)); }
      catch { console.error('Waiting room cleanup is pending.'); }
    }
  }, 30000);
  timer.unref();
  let closingBreakouts = false;
  const breakoutTimer = setInterval(async () => {
    if (closingBreakouts) return;
    const due = breakouts.due(Date.now());
    if (!due.length) return;
    closingBreakouts = true;
    try {
      await Promise.allSettled(due.map(({ meeting }) => serial(meeting, () => {
        const closesAt = breakouts.closesAt(meeting);
        if (closesAt != null && closesAt <= Date.now()) {
          return finishBreakouts(meeting, activeHost(findMeeting.get(meeting)));
        }
      })));
    } finally { closingBreakouts = false; }
  }, 1000);
  breakoutTimer.unref();
  const hostTimer = rooms ? setInterval(checkHostContinuity, 5000) : null;
  hostTimer?.unref();
  let reconcilingCloud = false;
  const recordingTimer = cloud && setInterval(async () => {
    if (reconcilingCloud) return;
    reconcilingCloud = true;
    try {
      const checks = cloud.pending.all().map(({ meeting }) => serial(meeting, () => cloud.reconcile(findMeeting.get(meeting))));
      await Promise.allSettled(checks);
    } finally { reconcilingCloud = false; }
  }, 5000);
  recordingTimer?.unref();
  const syncCalendars = () => Promise.allSettled([google?.tick(), msOutlook?.tick()]);
  const calendarTimer = (google || msOutlook) && setInterval(syncCalendars, 60000);
  calendarTimer?.unref();
  return { app, syncCalendars, checkHostContinuity, close() {
    clearInterval(timer);
    clearInterval(breakoutTimer);
    clearInterval(hostTimer);
    clearInterval(recordingTimer);
    clearInterval(calendarTimer);
    google?.close();
    msOutlook?.close();
    breakoutVoice.close();
    cloudStorage?.close?.();
    db.close();
  } };
}
