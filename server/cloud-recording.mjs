import { createHash, randomBytes } from 'node:crypto';
import {
  EgressStatus, EncodedFileOutput, EncodedFileType, EncodingOptionsPreset, ParticipantInfo, ParticipantInfo_State, S3Upload,
} from 'livekit-server-sdk';
import { z } from 'zod';

const requestLifetime = 3 * 60_000;
const recordingLifetime = 30 * 60_000;
const unknownJobLifetime = 120_000;
const maxParticipants = 30;
const maxJobs = 6;
const recorderKind = ParticipantInfo.fields.list().find(field => field.name === 'kind').T.findName('EGRESS').no;
export const cloudRecordingId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const ticketPattern = /^[A-Za-z0-9_-]{43}$/;
const digest = value => createHash('sha256').update(value).digest('hex');

export const cloudCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request') }).strict(),
  z.object({ action: z.literal('start'), id: cloudRecordingId }).strict(),
  z.object({ action: z.literal('stop'), id: cloudRecordingId }).strict(),
  z.object({ action: z.literal('consent'), id: cloudRecordingId, allow: z.boolean() }).strict(),
]);

export function createCloudRecording({ db, egress, settings, origin, livekitUrl, listParticipants, isAttendee,
  getMeeting, activeHost, meetingEnded, hasBreakouts, log, error }) {
  const current = db.prepare('SELECT * FROM cloud_recordings WHERE meeting = ? ORDER BY rowid DESC LIMIT 1');
  const latestOwned = db.prepare('SELECT * FROM cloud_recordings WHERE meeting = ? AND host_identity = ? ORDER BY rowid DESC LIMIT 1');
  const ownReady = db.prepare(`SELECT cloud_recordings.id, meetings.title, cloud_recordings.started_at AS startedAt
    FROM cloud_recordings JOIN meetings ON meetings.id = cloud_recordings.meeting
    WHERE cloud_recordings.host_identity = ? AND cloud_recordings.state = 'ready'
    ORDER BY cloud_recordings.started_at DESC LIMIT 100`);
  const pending = db.prepare("SELECT meeting FROM cloud_recordings WHERE state IN ('requesting', 'recording', 'stopping') LIMIT " + maxJobs);
  const countPending = db.prepare("SELECT COUNT(*) AS count FROM cloud_recordings WHERE state IN ('requesting', 'recording', 'stopping')");
  const lookup = db.prepare('SELECT * FROM cloud_recordings WHERE id = ?');
  const byTicket = db.prepare('SELECT * FROM cloud_recordings WHERE ticket_hash = ?');
  const roster = db.prepare('SELECT identity, sid, allowed FROM cloud_recording_consent WHERE recording = ?');
  const person = db.prepare('SELECT * FROM cloud_recording_consent WHERE recording = ? AND identity = ?');
  const insert = db.prepare(`INSERT INTO cloud_recordings(id, meeting, host_identity, host_version, requested_at, state, file_key)
    VALUES(?, ?, ?, ?, ?, 'requesting', ?)`);
  const addConsent = db.prepare('INSERT INTO cloud_recording_consent(recording, identity, sid, allowed) VALUES(?, ?, ?, ?)');
  const accept = db.prepare('UPDATE cloud_recording_consent SET allowed = ? WHERE recording = ? AND identity = ?');
  const state = db.prepare('UPDATE cloud_recordings SET state = ?, reason = ? WHERE id = ?');
  const prepare = db.prepare("UPDATE cloud_recordings SET ticket_hash = ?, started_at = ?, state = 'recording' WHERE id = ?");
  const setJob = db.prepare('UPDATE cloud_recordings SET egress_id = ? WHERE id = ?');
  const clearTicket = db.prepare('UPDATE cloud_recordings SET ticket_hash = NULL WHERE id = ?');

  const available = meeting => !meeting.encrypted && !meeting.allow_guests;
  const active = recording => ['requesting', 'recording', 'stopping'].includes(recording?.state);
  const downloadable = recording => recording?.state === 'ready';

  function view(recording, actor, meeting) {
    if (!recording) return { state: 'idle' };
    const people = roster.all(recording.id);
    const approved = people.filter(item => item.allowed === 1).length;
    const member = people.find(item => item.identity === actor);
    const canConsent = Boolean(member && actor !== recording.host_identity &&
      (recording.state === 'requesting' || recording.state === 'recording' && member.allowed === 1));
    return {
      id: recording.id, state: recording.state, total: people.length, approved,
      consent: member?.allowed == null ? null : member.allowed === 1,
      canConsent,
      canStart: recording.state === 'requesting' && activeHost(meeting) === actor && approved === people.length,
      ...(downloadable(recording) && recording.host_identity === actor ? { file: recording.file_key } : {}),
      ...(recording.reason ? { reason: recording.reason } : {}),
    };
  }

  async function connected(meeting) {
    return (await listParticipants(meeting.id)).filter(participant =>
      participant.kind !== recorderKind && participant.state !== ParticipantInfo_State.DISCONNECTED);
  }

  async function assertRoster(meeting, recording) {
    const people = await connected(meeting);
    const expected = new Map(roster.all(recording.id).map(({ identity, sid }) => [identity, sid]));
    return people.length === expected.size && people.every(participant =>
      participant.state === ParticipantInfo_State.ACTIVE && expected.get(participant.identity) === participant.sid &&
      isAttendee(meeting, participant.identity));
  }

  function terminal(recording, next, reason = null) {
    state.run(next, reason, recording.id);
    clearTicket.run(recording.id);
    return lookup.get(recording.id);
  }

  function copyStatus(recording, info) {
    if (info.status === EgressStatus.EGRESS_COMPLETE || info.status === EgressStatus.EGRESS_LIMIT_REACHED) {
      const hasFile = !info.backupStorageUsed &&
        info.fileResults?.some(file => file.filename === recording.file_key && BigInt(file.size ?? 0) > 0n);
      return terminal(recording, hasFile ? 'ready' : 'failed', hasFile ? recording.reason : 'The recorder did not produce a file.');
    }
    if ([EgressStatus.EGRESS_FAILED, EgressStatus.EGRESS_ABORTED].includes(info.status)) {
      return terminal(recording, 'failed', 'Cloud recording did not complete.');
    }
    if (info.status === EgressStatus.EGRESS_ENDING && recording.state !== 'stopping') {
      state.run('stopping', recording.reason, recording.id);
    }
    return lookup.get(recording.id);
  }

  async function recoverJob(recording) {
    const options = recording.egress_id ? { egressId: recording.egress_id } : { roomName: recording.meeting };
    const jobs = await egress.listEgress(options);
    return jobs.find(job => recording.egress_id ? job.egressId === recording.egress_id :
      job.request?.case === 'roomComposite' &&
      job.request.value.fileOutputs?.some(file => file.filepath === recording.file_key));
  }

  async function stop(recording, reason = null) {
    if (!active(recording) || recording.state === 'stopping') return recording;
    if (recording.state === 'requesting') return terminal(recording, 'failed', reason || 'The recording request was cancelled.');
    state.run('stopping', reason, recording.id);
    if (recording.egress_id) {
      try { return copyStatus(lookup.get(recording.id), await egress.stopEgress(recording.egress_id)); }
      catch { /* The template independently stops and the sweeper retries Egress. */ }
    }
    return lookup.get(recording.id);
  }

  async function stopMeeting(meeting, reason) {
    const recording = current.get(meeting.id);
    if (active(recording)) await stop(recording, reason);
  }

  async function reconcile(meeting) {
    const row = current.get(meeting.id);
    if (!active(row)) return;
    if (meetingEnded(meeting) || row.host_identity !== activeHost(meeting) || row.host_version !== meeting.host_version) {
      await stop(row, 'The recording stopped when meeting control changed.');
    }
    const recording = lookup.get(row.id);
    if (recording.state === 'requesting') {
      if (Date.now() - recording.requested_at >= requestLifetime) terminal(recording, 'failed', 'The recording request expired.');
      return;
    }
    if (!active(recording)) return;
    if (recording.state === 'recording' && Date.now() - recording.started_at >= recordingLifetime) {
      await stop(recording, 'The 30-minute recording ended.');
    } else if (recording.state === 'recording' && !(await assertRoster(meeting, recording).catch(() => false))) {
      await stop(recording, 'The recording stopped when the participant list changed.');
    }
    const latest = lookup.get(row.id);
    if (!active(latest)) return;
    const job = await recoverJob(latest);
    if (!job) {
      if (Date.now() - latest.started_at >= unknownJobLifetime) terminal(latest, 'failed', 'The recorder did not confirm a job.');
      return;
    }
    if (!latest.egress_id) setJob.run(job.egressId, latest.id);
    const updated = copyStatus(lookup.get(row.id), job);
    if (updated.state === 'stopping' && [EgressStatus.EGRESS_STARTING, EgressStatus.EGRESS_ACTIVE].includes(job.status)) {
      copyStatus(updated, await egress.stopEgress(job.egressId));
    }
  }

  async function command(meeting, actor, input) {
    if (!available(meeting) || !meeting.opened_at || meetingEnded(meeting)) throw error(409, 'Cloud recording is unavailable for this meeting.');
    const host = activeHost(meeting) === actor;
    if (input.action !== 'consent' && !host) throw error(403, 'Only the host can control cloud recording.');
    const recording = current.get(meeting.id);
    if (input.action === 'request') {
      if (active(recording)) throw error(409, 'A cloud recording request is already open.');
      if (hasBreakouts(meeting.id)) throw error(409, 'Close the breakout rooms before requesting cloud recording.');
      const people = await connected(meeting);
      if (!people.some(participant => participant.identity === actor) || people.length > maxParticipants ||
          people.some(participant => participant.state !== ParticipantInfo_State.ACTIVE ||
            !participant.sid || !isAttendee(meeting, participant.identity))) {
        throw error(409, 'Cloud recording needs the connected host and up to 30 admitted, signed-in attendees.');
      }
      const id = randomBytes(16).toString('base64url');
      const file = 'meetrix-recordings/' + meeting.id + '/' + id + '.mp4';
      db.exec('BEGIN IMMEDIATE');
      try {
        if (countPending.get().count >= maxJobs) throw error(429, 'The workspace has reached its cloud recording limit.');
        insert.run(id, meeting.id, actor, meeting.host_version, Date.now(), file);
        for (const { identity, sid } of people) addConsent.run(id, identity, sid, identity === actor ? 1 : null);
        log(meeting.id, actor, 'cloud-recording-request', id);
        db.exec('COMMIT');
      } catch (failure) {
        db.exec('ROLLBACK');
        throw failure;
      }
      return view(lookup.get(id), actor, meeting);
    }
    if (!active(recording) || input.id !== recording.id || recording.host_version !== meeting.host_version) {
      throw error(409, 'That cloud recording request is no longer active.');
    }
    if (input.action === 'stop') {
      const stopped = await stop(recording);
      log(meeting.id, actor, 'cloud-recording-stop', recording.id);
      return view(stopped, actor, meeting);
    }
    if (input.action === 'consent') {
      if (host || recording.state === 'stopping' || recording.state === 'recording' && input.allow) {
        throw error(409, 'Consent is unavailable for this cloud recording.');
      }
      const member = person.get(recording.id, actor);
      if (!member || !(await connected(meeting)).some(participant =>
        participant.identity === actor && participant.sid === member.sid && participant.state === ParticipantInfo_State.ACTIVE)) {
        throw error(403, 'Consent requires the same connected session that received the request.');
      }
      const withdrawing = recording.state === 'recording' && !input.allow;
      // Close the template's authorization before awaiting the external stop.
      if (withdrawing) {
        accept.run(0, recording.id, actor);
        return view(await stop(recording, 'An attendee withdrew recording consent.'), actor, meeting);
      }
      accept.run(input.allow ? 1 : 0, recording.id, actor);
      return view(recording, actor, meeting);
    }
    if (recording.state !== 'requesting' || Date.now() - recording.requested_at >= requestLifetime ||
        roster.all(recording.id).some(member => member.allowed !== 1)) throw error(409, 'Cloud recording requires everyone’s consent.');
    if (hasBreakouts(meeting.id) || !(await assertRoster(meeting, recording))) {
      terminal(recording, 'failed', 'The participant list changed. Request consent again.');
      throw error(409, 'The participant list changed. Request consent again.');
    }
    const ticket = randomBytes(32).toString('base64url');
    const templateUrl = new URL('/recording.html', origin);
    templateUrl.searchParams.set('access', ticket);
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4, filepath: recording.file_key, disableManifest: true,
      output: { case: 's3', value: new S3Upload(settings) },
    });
    prepare.run(digest(ticket), Date.now(), recording.id);
    let info;
    try {
      info = await egress.startRoomCompositeEgress(meeting.id, output, {
        customBaseUrl: templateUrl.href, encodingOptions: EncodingOptionsPreset.H264_720P_30,
      });
    } catch {
      await stop(lookup.get(recording.id), 'The recorder could not confirm the start.');
      throw error(502, 'LiveKit Egress could not confirm the recording. Check the hosted Egress service.');
    }
    setJob.run(info.egressId, recording.id);
    log(meeting.id, actor, 'cloud-recording-start', recording.id);
    return view(copyStatus(lookup.get(recording.id), info), actor, meeting);
  }

  function template(token) {
    if (!ticketPattern.test(token ?? '')) return null;
    const recording = byTicket.get(digest(token));
    if (recording?.state !== 'recording' || Date.now() - recording.started_at >= recordingLifetime) return null;
    const meeting = getMeeting(recording.meeting);
    if (!meeting || meetingEnded(meeting) || recording.host_identity !== activeHost(meeting) ||
        recording.host_version !== meeting.host_version) return null;
    const participants = roster.all(recording.id);
    if (participants.some(member => member.allowed !== 1 || !isAttendee(meeting, member.identity))) return null;
    return { room: recording.meeting, serverUrl: livekitUrl,
      participants: participants.map(({ identity, sid }) => ({ identity, sid })) };
  }

  return {
    available, command, pending, reconcile, stopMeeting, template,
    listFiles(actor) { return ownReady.all(actor); },
    fileKey(id, actor) {
      const recording = lookup.get(id);
      return recording?.state === 'ready' && recording.host_identity === actor ? recording.file_key : null;
    },
    canViewAfterEnd(meeting, actor) { return meeting.owner === actor || Boolean(latestOwned.get(meeting.id, actor)); },
    status(meeting, actor) {
      const latest = current.get(meeting.id);
      if (!meetingEnded(meeting) || active(latest)) return view(latest, actor, meeting);
      return view(latestOwned.get(meeting.id, actor) ?? (meeting.owner === actor ? latest : null), actor, meeting);
    },
  };
}
