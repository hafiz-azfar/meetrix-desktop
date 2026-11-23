import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ConnectionState, RoomEvent } from 'livekit-client';
import { download } from './api.js';
import { prepareRecorder } from './meeting-recorder.js';

const topic = 'meetrix.recording';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const roundId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function useMeetingRecording(room, { enabled, hostIdentity, host, meetingId }) {
  const round = useRef(null);
  const previousHost = useRef(hostIdentity);
  const clip = useRef(null);
  const finalizing = useRef(null);
  const stoppedWhileOffline = useRef(null);
  const [state, setState] = useState(null);
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  function sync(next) {
    round.current = next;
    setState(next && { ...next });
  }

  function connected() { return room.state === ConnectionState.Connected; }

  function publish(kind, id, extra, destination) {
    return room.localParticipant.publishData(encoder.encode(JSON.stringify({ kind, id, ...extra })), {
      reliable: true, topic, ...(destination ? { destinationIdentities: [destination] } : {}),
    });
  }

  function save() {
    if (!clip.current) return;
    const stamp = new Date().toISOString().replaceAll(':', '-');
    download('meetrix-' + meetingId + '-' + stamp + '.webm', clip.current, clip.current.type);
    discard();
  }

  function discard() {
    clip.current = null;
    setFile(null);
  }

  async function stop(reason = '') {
    const active = round.current;
    if (!active) { await finalizing.current; return; }
    sync(null);
    setNotice(reason);
    if (active.recorder) {
      setSaving(true);
      finalizing.current = active.recorder.stop();
    }
    if (connected()) void publish('stopped', active.id).catch(() => { stoppedWhileOffline.current = active.id; });
    else stoppedWhileOffline.current = active.id;
    if (!active.recorder) return;
    try {
      clip.current = await finalizing.current;
      setFile(clip.current);
      if (!clip.current && !reason) setNotice('The device did not produce a recording.');
    } catch { setNotice('The recording could not be finalized.'); }
    finally { finalizing.current = null; setSaving(false); }
  }

  async function finishForExit() {
    if (!enabled || !host) return;
    await stop();
    save();
  }

  async function request() {
    if (!enabled || !host || !connected() || round.current || finalizing.current || clip.current) return;
    setNotice('');
    const next = { id: crypto.randomUUID(), phase: 'request', answers: new Map() };
    sync(next);
    try { await publish('request', next.id); }
    catch { if (round.current === next) await stop('Could not send the recording request.'); }
  }

  function approved(participant, active) {
    const answer = active.answers.get(participant.identity);
    return answer?.participant === participant && answer.allowed;
  }

  function everyoneAgrees(active) {
    return connected() && [...room.remoteParticipants.values()].every(participant => approved(participant, active));
  }

  async function start() {
    const active = round.current;
    if (!host || active?.phase !== 'request' || !everyoneAgrees(active)) return;
    active.phase = 'starting';
    sync(active);
    let recorder;
    try {
      recorder = await prepareRecorder(() => {
        if (!connected() || round.current !== active) return [];
        return [room.localParticipant, ...[...room.remoteParticipants.values()].filter(participant => approved(participant, active))];
      }, stop);
      if (round.current !== active) { await recorder.stop(); return; }
      active.recorder = recorder;
      if (!everyoneAgrees(active)) throw new Error('The participant list changed. Request consent again.');
      await publish('active', active.id);
      if (round.current !== active) return;
      if (!everyoneAgrees(active)) throw new Error('The participant list changed. Request consent again.');
      recorder.start();
      active.phase = 'active';
      sync(active);
    } catch (error) {
      if (round.current === active) await stop(error.message || 'Recording could not start.');
      else await recorder?.stop();
    }
  }

  async function respond(allowed) {
    const active = round.current;
    if (!active || host || !connected() || active.sending || active.choice === allowed || (active.phase === 'active' && allowed)) return;
    const previous = active.choice;
    active.choice = allowed;
    active.sending = true;
    setNotice('');
    sync(active);
    try { await publish('answer', active.id, { allowed }, hostIdentity); }
    catch {
      active.choice = previous;
      if (round.current === active) setNotice('Your response could not be sent. Please try again.');
    } finally {
      active.sending = false;
      if (round.current === active) sync(active);
    }
  }

  const receive = useEffectEvent((payload, participant, _kind, packetTopic) => {
    if (packetTopic !== topic || payload.byteLength > 240 || !participant || !connected() ||
        room.remoteParticipants.get(participant.identity) !== participant) return;
    let event;
    try { event = JSON.parse(decoder.decode(payload)); } catch { return; }
    if (typeof event?.id !== 'string' || !roundId.test(event.id)) return;
    const active = round.current;
    if (host) {
      if (event.kind !== 'answer' || event.id !== active?.id || typeof event.allowed !== 'boolean') return;
      active.answers.set(participant.identity, { participant, allowed: event.allowed });
      if (!event.allowed && active.phase !== 'request') void stop('Recording stopped because a participant withdrew consent.');
      else sync(active);
    } else if (participant.identity === hostIdentity) {
      if (event.kind === 'request' && event.id !== active?.id) {
        setNotice('');
        sync({ id: event.id, phase: 'request', choice: null });
      } else if (event.kind === 'active' && event.id === active?.id && active.choice === true) {
        active.phase = 'active';
        sync(active);
      } else if (event.kind === 'stopped' && event.id === active?.id) {
        sync(null);
        setNotice('');
      }
    }
  });

  const rosterChanged = useEffectEvent((participant, joining) => {
    const active = round.current;
    if (!active) return;
    if (!host) { if (!joining && participant.identity === hostIdentity) sync(null); return; }
    if (active.phase !== 'request') {
      void stop('Recording stopped because the participant list changed.');
      return;
    }
    active.answers.delete(participant.identity);
    sync(active);
    if (joining) void publish('request', active.id, undefined, participant.identity).catch(() => {});
  });

  const connectionChanged = useEffectEvent(next => {
    if (next === ConnectionState.Connected) {
      const stopped = stoppedWhileOffline.current;
      if (host && stopped) {
        stoppedWhileOffline.current = null;
        void publish('stopped', stopped).catch(() => {});
      }
      return;
    }
    if (host && round.current) void stop('Recording stopped because the meeting connection changed.');
    if (!host) sync(null);
  });

  const onUnmount = useEffectEvent(() => {
    if (!round.current && !finalizing.current && !clip.current) return;
    if (host) void finishForExit();
  });

  const resetForHostTransfer = useEffectEvent(() => {
    if (round.current?.answers || finalizing.current || clip.current) {
      void stop('Recording stopped because the host changed.').then(save);
    } else {
      sync(null);
      setNotice('');
    }
  });

  useEffect(() => {
    if (previousHost.current === hostIdentity) return;
    previousHost.current = hostIdentity;
    resetForHostTransfer();
  }, [hostIdentity]);

  useEffect(() => {
    if (!enabled) return;
    const data = (...args) => receive(...args);
    const join = participant => rosterChanged(participant, true);
    const leave = participant => rosterChanged(participant, false);
    const connection = next => connectionChanged(next);
    room.on(RoomEvent.DataReceived, data);
    room.on(RoomEvent.ParticipantConnected, join);
    room.on(RoomEvent.ParticipantDisconnected, leave);
    room.on(RoomEvent.ConnectionStateChanged, connection);
    return () => {
      room.off(RoomEvent.DataReceived, data);
      room.off(RoomEvent.ParticipantConnected, join);
      room.off(RoomEvent.ParticipantDisconnected, leave);
      room.off(RoomEvent.ConnectionStateChanged, connection);
      onUnmount();
    };
  }, [enabled, room]);

  return { state, file, saving, notice, request, start, stop, respond, save, discard, finishForExit };
}

export function RecordingBanner({ recording, host }) {
  const { state, notice, respond } = recording;
  if (!state || (host && state.phase !== 'active')) return null;
  let message = 'The host wants to record this meeting to a file on their device.';
  if (state.phase === 'active') message = 'Meeting recording is active.';
  else if (state.choice === true) message = 'You allowed recording. Waiting for the host to start.';
  else if (state.choice === false) message = 'You declined recording.';
  return <div className="recording-banner" data-active={state.phase === 'active'}>
    <p role="status"><strong>{message}</strong>{notice && <span>{notice}</span>}</p>
    {!host && <div className="meeting-tool-actions">
      {state.phase !== 'active' && state.choice !== true && <button className="button primary small" disabled={state.sending} onClick={() => respond(true)}>Allow recording</button>}
      {state.choice !== false && <button className="button small" disabled={state.sending} onClick={() => respond(false)}>{state.choice === true ? 'Withdraw consent' : 'Decline recording'}</button>}
    </div>}
  </div>;
}

export function RecordingPanel({ recording, participants, online }) {
  const { state, file, saving, notice, request, start, stop, save, discard } = recording;
  const others = participants.filter(person => !person.isLocal);
  function decision(person) {
    const answer = state?.answers.get(person.identity);
    return answer?.participant === person ? answer.allowed ? 'Allowed' : 'Declined' : 'Awaiting response';
  }
  return <div className="meeting-tool-panel">
    {notice && <p role="status">{notice}</p>}
    <p className="muted">Record meeting audio and the shared screen or up to nine camera tiles. Everyone must agree before you start.</p>
    {!state && !file && !saving && <button className="button primary" disabled={!online} onClick={request}>Request recording</button>}
    {state && state.phase !== 'active' && <>
      {others.length > 0 && <ul className="recording-consent">{others.map(person => <li key={person.identity}><span>{person.name || 'Guest'}</span><strong>{decision(person)}</strong></li>)}</ul>}
      <div className="meeting-tool-actions">
        <button className="button primary" disabled={state.phase !== 'request' || !online || !others.every(person => decision(person) === 'Allowed')} onClick={start}>{state.phase === 'starting' ? 'Starting…' : 'Start recording'}</button>
        <button className="button" onClick={() => stop()}>Cancel request</button>
      </div>
    </>}
    {state?.phase === 'active' && <button className="button danger" onClick={() => stop()}>Stop recording</button>}
    {saving && <p role="status">Finalizing recording…</p>}
    {file && <><p>Your recording is ready. {Math.max(1, Math.round(file.size / 1024))} KB</p>
      <div className="meeting-tool-actions"><button className="button primary" onClick={save}>Save WebM</button><button className="button" onClick={discard}>Discard</button></div></>}
  </div>;
}
