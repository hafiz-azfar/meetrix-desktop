import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ConnectionState, RoomEvent } from 'livekit-client';
import { Send } from 'lucide-react';
import { download } from './api.js';
import { useAutomaticCaptions } from './automatic-captions.js';
import { captionLanguages, useCaptionTranslation } from './caption-translation.js';
import {
  captionLength, isCaptionHost, matchesCaptioner, readCaptionerPacket, readCaptionText, readPublishedCaption,
} from './caption-protocol.js';

const topic = 'meetrix.manual-caption';
const captionerTopic = 'meetrix.captioner';
const encoder = new TextEncoder();
const captionInterval = 250;

export function useManualCaptions(room, { enabled, hostIdentity, hostVersion = 0, online, microphone }) {
  const [entries, setEntries] = useState([]);
  const [current, setCurrent] = useState(null);
  const [visible, setVisible] = useState(true);
  const [captioners, setCaptioners] = useState([]);
  const [assignment, setAssignment] = useState(null);
  const active = useRef(null);
  const awaitingResult = useRef(null);
  const lastCaption = useRef(-Infinity);
  const lastPublish = useRef(-Infinity);
  const automatic = useAutomaticCaptions(room, { enabled, hostIdentity, hostVersion, online, microphone, append });
  const translation = useCaptionTranslation(entries, enabled);

  useEffect(() => {
    if (!current) return;
    const timeout = setTimeout(() => setCurrent(null), 8000);
    return () => clearTimeout(timeout);
  }, [current]);

  function append(line, speaker = '') {
    const now = performance.now();
    if (!speaker) {
      if (now - lastCaption.current < captionInterval) return;
      lastCaption.current = now;
    }
    const entry = { line, speaker, at: Date.now(), id: crypto.randomUUID() };
    setCurrent(entry);
    setEntries(previous => [...previous.slice(-999), entry]);
  }

  function sync(next) {
    active.current = next;
    setAssignment(next);
  }

  function connected() { return enabled && room.state === ConnectionState.Connected; }

  function validAssignment(value) {
    const local = room.localParticipant;
    const host = isCaptionHost(hostIdentity, local) ? local : room.remoteParticipants.get(hostIdentity);
    return value && value.room === room && value.hostVersion === hostVersion &&
      value.hostSid === host?.sid && value.hostIdentity === hostIdentity &&
      (matchesCaptioner(value, local) || matchesCaptioner(value, room.remoteParticipants.get(value.identity)));
  }

  function publishCaptioner(kind, destination, fields) {
    const payload = encoder.encode(JSON.stringify({ kind, hostVersion, ...fields }));
    return room.localParticipant.publishData(payload, { reliable: true, topic: captionerTopic, destinationIdentities: [destination] });
  }

  async function publishLine(line) {
    const now = performance.now();
    if (now - lastPublish.current < captionInterval) throw new Error('Wait a moment before sending another caption.');
    lastPublish.current = now;
    await room.localParticipant.publishData(encoder.encode(line), { reliable: true, topic });
    append(line);
  }

  function settleSubmission(id, accepted) {
    const pending = awaitingResult.current;
    if (!pending || pending.id !== id) return;
    awaitingResult.current = null;
    clearTimeout(pending.timer);
    if (accepted) pending.resolve();
    else pending.reject(new Error('The host could not confirm this caption. Try again.'));
  }

  const receive = useEffectEvent((payload, participant, _kind, packetTopic) => {
    if (!connected() || !participant?.sid || room.remoteParticipants.get(participant.identity) !== participant) return;
    const fromHost = isCaptionHost(hostIdentity, participant);
    if (packetTopic === topic) {
      const line = fromHost && readPublishedCaption(payload);
      if (line) append(line);
      return;
    }
    if (packetTopic !== captionerTopic) return;
    const packet = readCaptionerPacket(payload, hostVersion);
    if (!packet) return;
    const local = room.localParticipant;
    if (fromHost && packet.sid === local.sid) {
      if (packet.kind === 'access') {
        sync(packet.allowed ? {
          room, hostIdentity, hostVersion, hostSid: participant.sid, identity: local.identity, sid: local.sid,
        } : null);
        if (!packet.allowed && awaitingResult.current) settleSubmission(awaitingResult.current.id, false);
      } else if (packet.kind === 'result') {
        settleSubmission(packet.id, packet.accepted);
      }
      return;
    }
    const selection = active.current;
    if (packet.kind !== 'submission' || !isCaptionHost(hostIdentity, local) || packet.sid !== participant.sid ||
        !validAssignment(selection) || !matchesCaptioner(selection, participant)) return;
    void publishLine(packet.line).then(() => true, () => false).then(accepted =>
      publishCaptioner('result', participant.identity, { sid: participant.sid, id: packet.id, accepted })).catch(() => {});
  });

  const refreshParticipants = useEffectEvent(() => {
    setCaptioners(connected() ? [...room.remoteParticipants.values()].filter(participant => participant.sid)
      .map(({ identity, sid, name }) => ({ identity, sid, name: name || 'Participant' })) : []);
    if ((active.current && !validAssignment(active.current)) || room.state === ConnectionState.Disconnected) {
      sync(null);
      if (awaitingResult.current) settleSubmission(awaitingResult.current.id, false);
    }
  });

  useEffect(() => {
    if (!enabled) return;
    const data = (...args) => receive(...args);
    const update = () => refreshParticipants();
    room.on(RoomEvent.DataReceived, data);
    room.on(RoomEvent.ParticipantConnected, update);
    room.on(RoomEvent.ParticipantDisconnected, update);
    room.on(RoomEvent.ConnectionStateChanged, update);
    update();
    return () => {
      room.off(RoomEvent.DataReceived, data);
      room.off(RoomEvent.ParticipantConnected, update);
      room.off(RoomEvent.ParticipantDisconnected, update);
      room.off(RoomEvent.ConnectionStateChanged, update);
      if (awaitingResult.current) settleSubmission(awaitingResult.current.id, false);
    };
  }, [enabled, room]);

  useEffect(() => { refreshParticipants(); }, [hostIdentity, hostVersion]);

  async function assignCaptioner(sid) {
    const local = room.localParticipant;
    if (!connected() || !isCaptionHost(hostIdentity, local)) throw new Error('Only the host can assign a captioner.');
    const previous = validAssignment(active.current) ? active.current : null;
    if ((previous?.sid || '') === sid) return;
    const participant = sid ? [...room.remoteParticipants.values()].find(peer => peer.sid === sid) : null;
    if (sid && !participant) throw new Error('This participant has left the meeting.');
    const next = participant ? {
      room, hostIdentity, hostVersion, hostSid: local.sid, identity: participant.identity, sid: participant.sid,
    } : null;
    sync(next);
    if (previous) await publishCaptioner('access', previous.identity, { sid: previous.sid, allowed: false }).catch(() => {});
    if (!next || active.current !== next) return;
    try { await publishCaptioner('access', next.identity, { sid: next.sid, allowed: true }); }
    catch {
      if (active.current === next) sync(null);
      throw new Error('Could not reach the captioner. Try again.');
    }
  }

  async function send(value) {
    const local = room.localParticipant;
    const line = readCaptionText(value);
    if (!line) throw new Error('Enter a valid caption.');
    if (connected() && isCaptionHost(hostIdentity, local)) return publishLine(line);
    const selection = active.current;
    if (!connected() || !validAssignment(selection) || !matchesCaptioner(selection, local)) {
      throw new Error('The host has not assigned you to type captions.');
    }
    if (awaitingResult.current) throw new Error('Wait for the host to confirm the previous caption.');
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settleSubmission(id, false), 5000);
      awaitingResult.current = { id, timer, resolve, reject };
      void publishCaptioner('submission', hostIdentity, { sid: local.sid, id, line }).catch(() => settleSubmission(id, false));
    });
  }

  const selected = validAssignment(assignment) ? assignment : null;
  const canType = connected() && (isCaptionHost(hostIdentity, room.localParticipant) ||
    matchesCaptioner(selected, room.localParticipant));
  return { entries, current, visible, setVisible, send, captioners, selected, canType, assignCaptioner, automatic, translation };
}

export function CaptionsOverlay({ captions, prefs }) {
  if (!captions.visible || !captions.current) return null;
  const { id, line, speaker } = captions.current;
  const translated = captions.translation.results[id];
  return <div className="caption-overlay" data-size={prefs.captionSize} data-contrast={prefs.captionContrast} role="status"><span>{speaker && <strong>{speaker} · </strong>}
    {translated ? <bdi lang={captions.translation.language}>{translated}</bdi> : line}</span></div>;
}

const formatTime = value => new Date(value).toLocaleTimeString([], {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function CaptionsPanel({ captions, host, online, meetingId }) {
  const { automatic, translation } = captions;
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [assigning, setAssigning] = useState(false);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [captions.entries]);

  async function submit(event) {
    event.preventDefault();
    if (pending || !online || !draft.trim()) return;
    setPending(true);
    setError('');
    try { await captions.send(draft); setDraft(''); }
    catch (failure) { setError(failure.message || 'Could not send the caption.'); }
    finally { setPending(false); }
  }

  async function chooseCaptioner(event) {
    const sid = event.target.value;
    setError('');
    setAssigning(true);
    try { await captions.assignCaptioner(sid); }
    catch (failure) { setError(failure.message || 'Could not update the captioner.'); }
    finally { setAssigning(false); }
  }

  function save() {
    const text = captions.entries.map(({ id, line, speaker, at }) => {
      const original = formatTime(at) + '  ' + (speaker ? speaker + '  ' : '') + line;
      return translation.results[id] ? original + '\n  [' + captionLanguages[translation.language] + '] ' + translation.results[id] : original;
    }).join('\n');
    download('meetrix-' + meetingId + '-captions.txt', text + '\n', 'text/plain;charset=utf-8');
  }

  return <div className="meeting-tool-panel captions-panel">
    <label className="caption-toggle"><input type="checkbox" checked={captions.visible} onChange={event => captions.setVisible(event.target.checked)} /> Show captions on stage</label>
    <div className="caption-language">
      <label>Translate English captions
        <select aria-label="Translate English captions" value={translation.language} onChange={event => translation.choose(event.target.value)}>
          {Object.entries(captionLanguages).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {translation.status && <p className="muted" role="status">{translation.status}</p>}
    </div>
    <div className="caption-history" role="region" aria-label="Caption history" tabIndex={0}>
      {captions.entries.length ? <ol>{captions.entries.map(({ line, speaker, at, id }) => <li key={id}>
        <time dateTime={new Date(at).toISOString()}>{formatTime(at)}</time> {speaker && <strong>{speaker} · </strong>}{line}
        {translation.results[id] && <bdi className="translated-caption" lang={translation.language}>{translation.results[id]}</bdi>}</li>)}</ol>
        : <p className="muted">Live meeting captions appear here.</p>}
      <span ref={end} />
    </div>
    {error && <p role="status">{error}</p>}
    {host && <label>Caption typist
      <select aria-label="Caption typist" value={captions.selected?.sid || ''} disabled={assigning || !online} onChange={chooseCaptioner}>
        <option value="">Host only</option>
        {captions.captioners.map(participant => <option key={participant.sid} value={participant.sid}>{participant.name}</option>)}
      </select>
    </label>}
    {!host && captions.canType && <p role="status">You can type captions for this meeting.</p>}
    {captions.canType && <form className="caption-form" onSubmit={submit}>
      <input aria-label="Caption text" placeholder="Type a live caption" maxLength={captionLength} value={draft} onChange={event => setDraft(event.target.value)} />
      <button className="icon-button" disabled={pending || !online || !draft.trim()} aria-label="Send caption"><Send size={18} /></button>
    </form>}
    <section className="automatic-caption-controls" aria-label="Automatic captions">
      {host && <button type="button" className="button" disabled={!online || automatic.pending} onClick={automatic.toggleMeeting}>
        {automatic.active ? 'Turn off automatic captions' : 'Turn on automatic captions'}</button>}
      {automatic.active && <>
        <p className="muted">English speech recognition runs on each participating Windows device. Recognized text is shared with this meeting.</p>
        {automatic.available && <button type="button" className="button" onClick={automatic.toggleMicrophone}>
          {automatic.subscribed ? 'Stop captioning my microphone' : 'Caption my microphone'}</button>}
        {automatic.subscribed && <p role="status">{automatic.listening ? 'Captioning your microphone.' : 'Microphone captions are ready when your microphone is on.'}</p>}
        {!automatic.available && <p className="muted">You can read captions here. Captioning your own microphone requires Meetrix for Windows with speech recognition installed.</p>}
      </>}
      {automatic.notice && <p role="status">{automatic.notice}</p>}
    </section>
    {captions.entries.length > 0 && <button className="button" onClick={save}>Save caption history</button>}
  </div>;
}
