import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createOutlookOAuth } from './outlook-oauth.mjs';
import { calendarAutomation, meetingFields } from './calendar-automation.mjs';

const meetingPath = '/meetings/:id/outlook';
const mailPath = '/workspace/outlook/mail';
const graphUrl = 'https://graph.microsoft.com/v1.0/me/';
const eventId = /^[A-Za-z0-9_+=\/-]{1,1024}$/;
const version = value => typeof value === 'string' && value.length <= 256 && /^(?:W\/)?"[^"\r\n]+"$/.test(value);
const messageForm = z.object({
  to: z.array(z.email()).min(1).max(10),
  subject: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(12_000),
}).strict();
const address = recipient => ({ name: recipient?.emailAddress?.name || '', address: recipient?.emailAddress?.address || '' });

export function outlookRoutes({ db, origin, settings, limits, error, serial, scheduledTime, calendarRemovals, request = fetch }) {
  if (!settings) return null;
  const auto = calendarAutomation(db, 'outlook', error);
  const find = db.prepare('SELECT * FROM meetings WHERE id = ? AND owner = ?');
  const link = db.prepare('SELECT event, etag FROM outlook_events WHERE meeting = ?');
  const save = db.prepare('INSERT INTO outlook_events(meeting, event, etag) VALUES (?, ?, ?) ON CONFLICT(meeting) DO UPDATE SET event=excluded.event, etag=excluded.etag');
  const unlink = db.prepare('DELETE FROM outlook_events WHERE meeting IN (SELECT id FROM meetings WHERE owner = ?)');
  const revise = db.prepare('UPDATE meetings SET title = ?, start_at = ?, duration_minutes = ?, calendar_revision = calendar_revision + 1 WHERE id = ?');
  const audit = db.prepare('INSERT INTO audit(meeting, actor, event, subject, created_at) VALUES(?, ?, ?, NULL, ?)');
  let busy = false;
  let closed = false;

  async function call(url, options) {
    if (closed) throw error(503, 'The Outlook integration is stopping.');
    try { return await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw error(502, 'Microsoft Outlook could not be reached.'); }
  }
  const oauth = createOutlookOAuth({ db, origin, settings, limits, error, serial, call,
    resetCalendar(owner) {
      unlink.run(owner);
      auto.removeOwner(owner);
      calendarRemovals.detach('outlook', owner);
    } });

  async function graph(path, token, { method = 'GET', body, etag, prefer, missing = false } = {}) {
    const response = await call(graphUrl + path, { method, headers: {
      Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(etag ? { 'If-Match': etag } : {}), ...(prefer ? { Prefer: prefer } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 404 && missing) return null;
    if ([409, 412].includes(response.status)) throw error(409, 'The Outlook event changed before saving.');
    if (!response.ok) throw error(502, method === 'POST' && path === 'sendMail'
      ? 'Outlook did not confirm sending. Check Sent Items before trying again.' : 'Outlook could not complete this request.');
    if ([202, 204].includes(response.status)) return null;
    return response.json();
  }

  function remoteFields(record) {
    if (!record || record.isCancelled || record.type !== 'singleInstance' || record.isAllDay || record.attendees?.length ||
        record.start?.timeZone !== 'UTC' || record.end?.timeZone !== 'UTC') {
      throw error(409, 'Only single timed Outlook events without attendees can be synchronized.');
    }
    const utc = value => typeof value === 'string' && /Z$/.test(value) ? value : value + 'Z';
    const startAt = scheduledTime(utc(record.start.dateTime), Date.now());
    const duration = (Date.parse(utc(record.end.dateTime)) - startAt) / 60_000;
    const title = typeof record.subject === 'string' ? record.subject.trim() : '';
    if (!Number.isSafeInteger(duration) || duration < 15 || duration > 1800 || !title || title.length > 100) {
      throw error(400, 'Outlook events need a title up to 100 characters and a duration between 15 minutes and 30 hours.');
    }
    return { title, startAt, duration };
  }

  const prefer = 'outlook.timezone="UTC", IdType="ImmutableId"';
  async function event(token, meeting, direction) {
    const id = meeting.id;
    const existing = link.get(id);
    const path = existing ? 'events/' + encodeURIComponent(existing.event) : 'events';
    if (direction !== 'push' && !existing) throw error(409, 'Publish this meeting to Outlook first.');
    const remote = existing ? await graph(path, token, { prefer, missing: true }) : null;
    if (existing && (!remote || remote.id !== existing.event || !version(remote['@odata.etag']))) {
      throw error(409, 'The linked Outlook event no longer exists.');
    }
    const resolving = direction === 'keep-local';
    if (resolving && auto.status(id).status !== 'conflict') {
      throw error(409, 'There is no paused Outlook Calendar conflict to resolve.');
    }
    const local = meetingFields(meeting);
    const actual = remote ? remoteFields(remote) : null;
    if (direction === 'enable') {
      if (!auto.same(local, actual)) throw error(409, 'Synchronize the current copies before enabling automatic sync.');
      return auto.enable(meeting.owner, id, local);
    }
    const automatic = direction === 'auto';
    if (automatic) direction = auto.direction(id, local, actual);
    if (!direction) return { linked: true };
    if (direction === 'unchanged') {
      save.run(id, remote.id, remote['@odata.etag']);
      auto.settled(id, local);
      return { linked: true };
    }
    if (direction === 'pull') {
      db.exec('BEGIN IMMEDIATE');
      try {
        revise.run(actual.title, actual.startAt, actual.duration, id);
        save.run(id, remote.id, remote['@odata.etag']);
        auto.settled(id, actual);
        db.exec('COMMIT');
      } catch (failure) { db.exec('ROLLBACK'); throw failure; }
    } else {
      if (!automatic && !resolving && remote && remote['@odata.etag'] !== existing.etag) throw error(409, 'Pull the Outlook changes before pushing again.');
      const outlookTime = ms => ({ dateTime: new Date(ms).toISOString().slice(0, -1), timeZone: 'UTC' });
      const fields = { subject: local.title, start: outlookTime(local.startAt), end: outlookTime(local.startAt + local.duration * 60_000) };
      const updated = remote
        ? await graph(path, token, { method: 'PATCH', body: fields, etag: remote['@odata.etag'], prefer })
        : await graph(path, token, { method: 'POST', prefer, body: { ...fields,
          transactionId: createHash('sha256').update(origin + ':' + id).digest('hex'),
          body: { contentType: 'Text', content: 'Join in Meetrix: ' + new URL('/join?m=' + id, origin) },
        } });
      if (!eventId.test(updated?.id || '') || !version(updated['@odata.etag']) || (existing && updated.id !== existing.event)) {
        throw error(502, 'Outlook did not confirm the linked event.');
      }
      save.run(id, updated.id, updated['@odata.etag']);
      auto.settled(id, local);
    }
    audit.run(id, meeting.owner, 'outlook-' + direction, Date.now());
    return { linked: true };
  }

  function meetingFor(id, owner) {
    const current = find.get(id, owner);
    if (!current) throw error(404, 'Meeting not found.');
    if (current.opened_at || current.stopped_at) throw error(409, 'Only unopened meetings can be synchronized.');
    return current;
  }
  function sync(owner, id, direction) {
    return oauth.run(owner, 'calendar', token => serial(id, () => event(token, meetingFor(id, owner), direction)));
  }

  function removeEvent(owner, id) {
    return oauth.run(owner, 'calendar', token => serial(id, async () => {
      if (closed || !calendarRemovals.pending('outlook', id)) return;
      const linked = link.get(id);
      if (!linked || !eventId.test(linked.event)) throw error(409, 'The Outlook Calendar connection changed.');
      const path = 'events/' + encodeURIComponent(linked.event);
      const remote = await graph(path, token, { prefer, missing: true });
      if (remote && !remote.isCancelled) {
        if (remote.id !== linked.event || !version(remote['@odata.etag']) || remote.isOrganizer !== true ||
            remote.type !== 'singleInstance' || remote.isAllDay || remote.attendees?.length) {
          throw error(409, 'Review the changed event in Outlook Calendar.');
        }
        await graph(path, token, { method: 'DELETE', etag: remote['@odata.etag'], prefer, missing: true });
      }
      if (!closed) calendarRemovals.removed('outlook', id);
    }));
  }

  return {
    public: oauth.public,
    close() { closed = true; },
    async tick() {
      if (busy || closed) return;
      busy = true;
      try {
        await calendarRemovals.drain('outlook', removeEvent, () => closed);
        if (closed) return;
        for (const { id, owner } of auto.due()) {
          if (closed) return;
          try { await sync(owner, id, 'auto'); }
          catch (failure) { if (!closed) auto.failed(id, failure); }
        }
      } finally { busy = false; }
    },
    authenticated(api, byIdentity) {
      oauth.authenticated(api, byIdentity);
      api.get(meetingPath, (req, res) => {
        if (!find.get(req.params.id, req.identity)) throw error(404, 'Meeting not found.');
        res.json({ linked: Boolean(link.get(req.params.id)), connected: oauth.status(req.identity).calendar,
          automatic: auto.status(req.params.id) });
      });
      api.post(meetingPath, byIdentity(25), async (req, res) => {
        const { direction } = z.object({ direction: z.enum(['push', 'pull', 'keep-local']) }).strict().parse(req.body);
        meetingFor(req.params.id, req.identity);
        res.json(await sync(req.identity, req.params.id, direction));
      });
      api.post(meetingPath + '/automatic', byIdentity(15), async (req, res) => {
        const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
        meetingFor(req.params.id, req.identity);
        const automatic = enabled ? await sync(req.identity, req.params.id, 'enable')
          : await serial(req.params.id, () => auto.disable(req.params.id));
        res.json({ automatic });
      });
      api.get(mailPath, byIdentity(25), async (req, res) => {
        const folder = z.enum(['inbox', 'sentitems']).default('inbox').parse(req.query.folder);
        const value = await oauth.run(req.identity, 'mail', token => graph(
          'mailFolders/' + folder + '/messages?$top=25&$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,isRead,bodyPreview' +
          '&$orderby=' + (folder === 'sentitems' ? 'sentDateTime' : 'receivedDateTime') + '%20desc', token, { prefer: 'IdType="ImmutableId"' }));
        res.json(value.value.map(message => ({
          id: message.id, subject: message.subject || '', from: address(message.from), to: (message.toRecipients || []).map(address),
          at: folder === 'sentitems' ? message.sentDateTime : message.receivedDateTime, read: message.isRead, preview: message.bodyPreview || '',
        })));
      });
      api.get(mailPath + '/:id', byIdentity(25), async (req, res) => {
        if (!eventId.test(req.params.id)) throw error(404, 'Message not found.');
        const message = await oauth.run(req.identity, 'mail', token => graph('messages/' + encodeURIComponent(req.params.id) +
          '?$select=subject,from,toRecipients,receivedDateTime,sentDateTime,body,bodyPreview', token,
        { prefer: 'outlook.body-content-type="text", IdType="ImmutableId"', missing: true }));
        if (!message) throw error(404, 'Message not found.');
        const plainText = message.body?.contentType?.toLowerCase() === 'text' ? message.body.content : message.bodyPreview;
        res.json({ subject: message.subject || '', from: address(message.from), to: (message.toRecipients || []).map(address),
          at: message.receivedDateTime || message.sentDateTime,
          text: typeof plainText === 'string' ? plainText.slice(0, 60_000) : '',
        });
      });
      api.post(mailPath, byIdentity(12), async (req, res) => {
        const { to, subject, text } = messageForm.parse(req.body);
        await oauth.run(req.identity, 'mail', token => graph('sendMail', token, { method: 'POST', body: {
          message: { subject, body: { contentType: 'Text', content: text },
            toRecipients: [...new Set(to)].map(value => ({ emailAddress: { address: value } })) },
          saveToSentItems: true,
        } }));
        res.status(202).json({ accepted: true });
      });
    },
  };
}
