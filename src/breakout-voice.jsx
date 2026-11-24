import React, { useEffect, useEffectEvent, useRef, useState } from 'react';
import { RoomEvent } from 'livekit-client';
import { Mic, Square } from 'lucide-react';
import { breakoutVoiceTopic, readVoicePacket, voiceBytes, voiceFrameCount, voiceRate, voiceSamples, voiceSeconds } from '../server/breakout-voice-format.mjs';
import { microphoneOptions } from './media-devices.jsx';

function encodePcm(samples) {
  const bytes = new Uint8Array(voiceBytes);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) view.setInt16(index * 2, samples[index] * 32767, true);
  return btoa(String.fromCharCode(...bytes));
}

function releaseVoice(run) {
  if (!run) return;
  run.controller.abort();
  clearTimeout(run.timer);
  run.capture?.stop();
  run.stream?.getTracks().forEach(track => track.stop());
  if (run.broadcast) {
    void run.api(run.path, { method: 'POST', signal: AbortSignal.timeout(3000),
      body: { action: 'stop', broadcast: run.broadcast } }).catch(() => {});
  }
}

export function BreakoutVoiceSender({ api, meetingId, rooms, prefs }) {
  const [audience, setAudience] = useState('');
  const [phase, setPhase] = useState('idle');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const current = useRef(null);
  const path = '/meetings/' + meetingId + '/breakout-voice';
  const eligible = rooms.filter(room => room.members.length);

  useEffect(() => () => {
    const run = current.current;
    current.current = null;
    releaseVoice(run);
  }, []);

  function stop(run, message, failure = false) {
    if (!run || current.current !== run) return;
    current.current = null;
    releaseVoice(run);
    setPhase('idle');
    if (failure) setError(message);
    else setNotice(message);
  }

  async function start() {
    if (current.current || !eligible.length) return;
    const run = { api, path, index: 0, controller: new AbortController() };
    current.current = run;
    setPhase('opening');
    setError('');
    setNotice('');
    try {
      run.stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneOptions(prefs) });
      if (current.current !== run) { releaseVoice(run); return; }
      const track = run.stream.getAudioTracks()[0];
      if (!track) throw new Error('Select an available microphone.');
      track.addEventListener('ended', () => stop(run, 'The microphone stopped.', true), { once: true });
      const grant = await api(path, { method: 'POST', signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(3000)]),
        body: { action: 'start', ...(audience ? { roomId: audience } : {}) } });
      run.broadcast = grant.broadcast;
      if (current.current !== run) { releaseVoice(run); return; }
      // The server enforces expiry. The local clock only bounds our own capture.
      run.timer = setTimeout(() => stop(run, 'Voice announcement ended.'), voiceSeconds * 1000);
      const { capturePcmAudio } = await import('./speech-input.js');
      if (current.current !== run) return;
      run.capture = await capturePcmAudio(track, async ({ samples, sampleRate }) => {
        if (sampleRate !== voiceRate || samples.length !== voiceSamples) throw new Error('This microphone format is unavailable.');
        if (run.index >= voiceFrameCount) { stop(run, 'Voice announcement ended.'); return; }
        await api(path, { method: 'POST', signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(2500)]), body: {
          action: 'audio', broadcast: run.broadcast, index: run.index++, pcm: encodePcm(samples),
        } });
      }, failure => stop(run, failure.message || 'The voice announcement stopped.', true), 'the voice announcement');
      if (current.current !== run) { releaseVoice(run); return; }
      setPhase('speaking');
    } catch (failure) { stop(run, failure.message || 'Could not start the voice announcement.', true); }
  }

  const targetMissing = Boolean(audience && !eligible.some(room => room.id === audience));
  return <section className="form" aria-label="Breakout voice announcement">
    <label>Voice announcement audience<select disabled={phase !== 'idle'} value={audience}
      onChange={event => setAudience(event.target.value)}>
      <option value="">All occupied breakout rooms</option>
      {targetMissing && <option value={audience}>Selected room is empty</option>}
      {eligible.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}
    </select></label>
    <div className="breakout-actions">
      {phase === 'idle' ? <button type="button" className="button" disabled={!eligible.length || targetMissing} onClick={start}>
        <Mic size={15} /> Start voice announcement
      </button> : <button type="button" className="button danger" onClick={() => stop(current.current, 'Voice announcement stopped.')}>
        <Square size={15} /> {phase === 'opening' ? 'Cancel voice announcement' : 'Stop voice announcement'}
      </button>}
    </div>
    {phase === 'idle' && !notice && !error && <p className="muted">Speak for up to 30 seconds. Your main-room mic setting stays as it is.</p>}
    {phase === 'opening' && <p role="status">Opening the announcement microphone…</p>}
    {phase === 'speaking' && <p role="status">Broadcasting to breakout rooms</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

export function BreakoutVoicePlayback({ room, speakerId, volume }) {
  const [speaking, setSpeaking] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const output = useRef(null);
  const setOutput = useEffectEvent((context, gain) => {
    gain.gain.value = volume;
    void context.setSinkId?.(speakerId || '').catch(() => {});
  });

  useEffect(() => {
    let notice;
    let lastFrame = null;
    function clearOutput() {
      clearTimeout(notice);
      lastFrame = null;
      const prior = output.current;
      output.current = null;
      if (prior) void prior.context.close().catch(() => {});
    }
    function receive(payload, participant, _kind, topic, _encryption, sender) {
      if (topic !== breakoutVoiceTopic || participant || sender) return;
      const frame = readVoicePacket(payload);
      if (!frame || lastFrame?.id === frame.id && frame.index <= lastFrame.index) return;
      lastFrame = frame;
      try {
        if (!output.current) {
          const context = new AudioContext();
          const gain = context.createGain();
          gain.connect(context.destination);
          setOutput(context, gain);
          output.current = { context, gain, next: 0, stream: frame.id };
        }
        const state = output.current;
        if (state.context.state !== 'running') { setBlocked(true); return; }
        setBlocked(false);
        setError('');
        const now = state.context.currentTime;
        if (state.stream !== frame.id || state.next < now) {
          state.next = now + 0.06;
          state.stream = frame.id;
        }
        if (state.next > now + 0.6) return;
        const buffer = state.context.createBuffer(1, voiceSamples, voiceRate);
        const samples = buffer.getChannelData(0);
        for (let index = 0; index < samples.length; index++) samples[index] = frame.samples.getInt16(index * 2, true) / 32768;
        const source = state.context.createBufferSource();
        source.buffer = buffer;
        source.connect(state.gain);
        source.start(state.next);
        state.next += buffer.duration;
        setSpeaking(true);
        clearTimeout(notice);
        notice = setTimeout(() => setSpeaking(false), 900);
      } catch { setError('This browser could not play the breakout announcement.'); }
    }
    function disconnected() { clearOutput(); setSpeaking(false); setBlocked(false); }
    room.on(RoomEvent.DataReceived, receive);
    room.on(RoomEvent.Disconnected, disconnected);
    return () => {
      room.off(RoomEvent.DataReceived, receive);
      room.off(RoomEvent.Disconnected, disconnected);
      clearOutput();
    };
  }, [room]);

  useEffect(() => {
    const player = output.current;
    if (player) setOutput(player.context, player.gain);
  }, [speakerId, volume]);

  if (!speaking && !blocked && !error) return null;
  return <div className="call-notice" role="status">
    {speaking && <span>Moderator voice announcement</span>}
    {error && <span>{error}</span>}
    {blocked && <button className="button small" onClick={async () => {
      try { await output.current?.context.resume(); setBlocked(false); setError(''); }
      catch { setError('Enable audio in this browser to hear voice announcements.'); }
    }}>Enable voice announcements</button>}
  </div>;
}
