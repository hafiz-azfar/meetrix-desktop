import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ConnectionState, RoomEvent } from 'livekit-client';
import { readCaptionText } from './caption-protocol.js';

const topic = 'meetrix.automatic-captions';
const roundPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function read(payload) {
  if (payload.byteLength > 1600) return null;
  let packet;
  try { packet = JSON.parse(decoder.decode(payload)); } catch { return null; }
  if (!packet || !Number.isSafeInteger(packet.hostVersion) || packet.hostVersion < 0) return null;
  if (packet.kind === 'sync') return packet;
  if (packet.kind === 'status' && Number.isSafeInteger(packet.revision) && packet.revision >= 0 && packet.round === null) return packet;
  return typeof packet.round === 'string' && roundPattern.test(packet.round) ? packet : null;
}

export function useAutomaticCaptions(room, { enabled, hostIdentity, hostVersion, online, microphone, append }) {
  const engine = window.meetrixDesktop?.speech;
  const [session, setSession] = useState(null);
  const [optedIn, setOptedIn] = useState(null);
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const sessionRef = useRef(null);
  const revision = useRef(0);
  const previousHost = useRef(hostVersion);
  const lastStatus = useRef(0);
  const lastLine = useRef(new Map());
  const lastSync = useRef(new Map());
  const host = room.localParticipant.identity === hostIdentity;
  const active = enabled && online && session?.hostIdentity === hostIdentity && session.hostVersion === hostVersion ? session : null;
  const subscribed = active && optedIn === active.round;

  function store(next) {
    if (sessionRef.current?.round !== next?.round) {
      lastLine.current.clear();
      setOptedIn(null);
    }
    sessionRef.current = next;
    setSession(next);
  }

  function publish(packet, destination) {
    return room.localParticipant.publishData(encoder.encode(JSON.stringify({ ...packet, hostVersion })), {
      reliable: true, topic, ...(destination ? { destinationIdentities: [destination] } : {}),
    });
  }

  function rateLimit(cache, sid, interval) {
    const now = performance.now();
    if (now - (cache.get(sid) ?? -Infinity) < interval) return false;
    cache.set(sid, now);
    return true;
  }

  function currentRound() {
    const current = sessionRef.current;
    return enabled && room.state === ConnectionState.Connected && current?.hostIdentity === hostIdentity &&
      current.hostVersion === hostVersion ? current.round : null;
  }

  async function relay(line, participant, round) {
    if (!host || round !== currentRound() || !rateLimit(lastLine.current, participant.sid, 650)) return;
    const speaker = (participant.name || 'Participant').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60) || 'Participant';
    await publish({ kind: 'line', round, speaker, line });
    append(line, speaker);
  }

  const receive = useEffectEvent((payload, participant, _kind, packetTopic) => {
    if (packetTopic !== topic || !enabled || !participant?.sid ||
        room.remoteParticipants.get(participant.identity) !== participant || room.state !== ConnectionState.Connected) return;
    const packet = read(payload);
    if (!packet || packet.hostVersion !== hostVersion) return;
    const round = currentRound();
    if (host) {
      if (packet.kind === 'sync' && rateLimit(lastSync.current, participant.sid, 3000)) {
        void publish({ kind: 'status', round, revision: revision.current }, participant.identity).catch(() => {});
      }
      if (packet.kind === 'suggest' && round === packet.round) {
        const line = readCaptionText(packet.line);
        if (line) void relay(line, participant, packet.round).catch(() => {});
      }
      return;
    }
    if (participant.identity !== hostIdentity) return;
    if (packet.kind === 'status' && Number.isSafeInteger(packet.revision) && packet.revision >= revision.current) {
      revision.current = packet.revision;
      lastStatus.current = performance.now();
      store(packet.round ? { round: packet.round, hostIdentity, hostVersion } : null);
    } else if (packet.kind === 'line' && round === packet.round) {
      const line = readCaptionText(packet.line);
      const speaker = typeof packet.speaker === 'string' && packet.speaker.length <= 60 ? packet.speaker : '';
      if (line && speaker) append(line, speaker);
    }
  });

  const refresh = useEffectEvent(() => {
    if (!enabled || room.state !== ConnectionState.Connected) return;
    if (!host) {
      if (currentRound() && performance.now() - lastStatus.current > 15000) store(null);
      if (!currentRound()) void publish({ kind: 'sync' }, hostIdentity).catch(() => {});
    } else {
      const round = currentRound();
      if (round) void publish({ kind: 'status', round, revision: revision.current }).catch(() => {});
    }
  });

  useEffect(() => {
    if (!enabled || !engine) return;
    let live = true;
    engine.available().then(value => { if (live) setAvailable(value === true); }).catch(() => {});
    return () => { live = false; };
  }, [enabled, engine]);

  useEffect(() => {
    if (!enabled) return;
    function data(...args) { receive(...args); }
    function forget(participant) {
      lastLine.current.delete(participant.sid);
      lastSync.current.delete(participant.sid);
    }
    room.on(RoomEvent.DataReceived, data);
    room.on(RoomEvent.ParticipantDisconnected, forget);
    return () => {
      room.off(RoomEvent.DataReceived, data);
      room.off(RoomEvent.ParticipantDisconnected, forget);
    };
  }, [room, enabled]);

  useEffect(() => {
    // Connection and host changes cancel local speech permission for the previous round.
    if (previousHost.current !== hostVersion) {
      previousHost.current = hostVersion;
      revision.current = 0;
    }
    store(null);
    setNotice('');
    setPending(false);
    if (!online || !enabled) return;
    const initial = setTimeout(() => refresh(), 100);
    const sync = setInterval(() => refresh(), 5000);
    return () => { clearTimeout(initial); clearInterval(sync); };
  }, [enabled, online, hostIdentity, hostVersion]);

  const emitLocalLine = useEffectEvent(async (text, round) => {
    const line = readCaptionText(text);
    if (!line || round !== currentRound() || optedIn !== round) return;
    if (host) await relay(line, room.localParticipant, round);
    else await publish({ kind: 'suggest', round, line }, hostIdentity);
  });

  useEffect(() => {
    if (!subscribed || !available || !microphone || !engine) return;
    const round = active.round;
    const controller = new AbortController();
    const cleanups = [];
    const onError = () => {
      if (!controller.signal.aborted) {
        setNotice('Recognition stopped. You can enable it again for this meeting.');
        setOptedIn(null);
      }
    };
    async function start() {
      let id;
      try {
        const { captureCaptionAudio } = await import('./speech-input.js');
        if (controller.signal.aborted) return;
        id = await engine.start();
        if (controller.signal.aborted) { await engine.stop(id); return; }
        cleanups.push(() => { void engine.stop(id).catch(() => {}); });
        cleanups.push(engine.onResult(result => {
          if (result.id !== id || controller.signal.aborted) return;
          if (result.error) onError();
          else if (result.final && result.text) void emitLocalLine(result.text, round).catch(() => {});
        }));
        const capture = await captureCaptionAudio(microphone, ({ samples, sampleRate }) => engine.push(id, samples, sampleRate), onError);
        if (controller.signal.aborted) { capture.stop(); return; }
        cleanups.push(() => capture.stop());
        setListening(true);
      } catch { onError(); }
    }
    void start();
    return () => {
      controller.abort();
      cleanups.reverse().forEach(dispose => dispose());
      setListening(false);
    };
  }, [subscribed, active?.round, available, microphone, engine]);

  async function toggleMeeting() {
    if (!host || !online || pending) return;
    const current = currentRound();
    setPending(true);
    setNotice('');
    try {
      if (current) {
        store(null);
        await publish({ kind: 'status', round: null, revision: ++revision.current });
      } else {
        const round = crypto.randomUUID();
        store({ round, hostIdentity, hostVersion });
        try { await publish({ kind: 'status', round, revision: ++revision.current }); }
        catch (error) { store(null); throw error; }
      }
    } catch { setNotice('Could not update automatic captions.'); }
    finally { setPending(false); }
  }

  function toggleMicrophone() {
    if (!active || !available) return;
    setNotice('');
    setOptedIn(previous => previous === active.round ? null : active.round);
  }

  return { active: Boolean(active), subscribed: Boolean(subscribed), listening, available, pending, notice, toggleMeeting, toggleMicrophone };
}
