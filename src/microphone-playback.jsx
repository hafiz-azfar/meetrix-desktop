import React, { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { microphoneOptions } from './media-devices.jsx';

const maxRecordingTime = 5000;

function release(session) {
  if (!session) return;
  clearTimeout(session.timer);
  if (session.recorder?.state === 'recording') session.recorder.stop();
  session.stream?.getTracks().forEach(track => track.stop());
}

export function MicrophonePlayback({ prefs }) {
  const live = useRef(null);
  const player = useRef(null);
  const [phase, setPhase] = useState('idle');
  const [sample, setSample] = useState(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [speakerError, setSpeakerError] = useState('');

  useEffect(() => () => {
    const current = live.current;
    live.current = null;
    release(current);
  }, []);

  useEffect(() => {
    if (!sample) { setUrl(''); return; }
    const objectUrl = URL.createObjectURL(sample);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [sample]);

  useEffect(() => {
    const audio = player.current;
    if (!audio) return;
    let current = true;
    audio.volume = prefs.speakerVolume;
    setSpeakerError('');
    if (audio.setSinkId) {
      audio.setSinkId(prefs.speakerId || '').catch(() => {
        if (current) setSpeakerError('This speaker could not be selected. Playback uses the available output.');
      });
    } else if (prefs.speakerId) setSpeakerError('Playback uses the default output in this browser.');
    return () => { current = false; };
  }, [url, prefs.speakerId, prefs.speakerVolume]);

  async function record() {
    if (live.current) return;
    const session = {};
    live.current = session;
    setError('');
    setSample(null);
    setPhase('opening');
    function failed(message) {
      if (live.current !== session) return;
      live.current = null;
      release(session);
      setError(message);
      setPhase('idle');
    }
    try {
      if (!window.MediaRecorder) throw new Error('Recording unavailable');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneOptions(prefs) });
      session.stream = stream;
      if (live.current !== session) { release(session); return; }
      const recorder = new MediaRecorder(stream, { audioBitsPerSecond: 64000 });
      session.recorder = recorder;
      const parts = [];
      recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
      recorder.onerror = () => failed('The microphone sample could not be recorded.');
      recorder.onstop = () => {
        if (live.current !== session) return;
        live.current = null;
        release(session);
        if (parts.length) setSample(new Blob(parts, { type: recorder.mimeType }));
        else setError('No audio was recorded. Check the selected microphone.');
        setPhase('idle');
      };
      recorder.start();
      session.timer = setTimeout(() => release(session), maxRecordingTime);
      setPhase('recording');
    } catch {
      failed('The microphone could not record a sample. Check permission and device availability.');
    }
  }

  return <section className="device-check">
    <h3><Mic size={18} /> Microphone playback</h3>
    <p className="muted">Record up to five seconds and listen back on this device.</p>
    {phase === 'recording' ? <button className="button small" onClick={() => release(live.current)}>Finish recording</button>
      : <button className="button small" onClick={record} disabled={phase === 'opening'}>
        {phase === 'opening' ? 'Opening microphone…' : 'Record sample'}
      </button>}
    {phase === 'recording' && <p role="status">Recording sample…</p>}
    {url && <div className="form">
      <audio controls ref={player} src={url} aria-label="Recorded microphone sample" />
      <div><button className="button small" onClick={() => setSample(null)}>Discard sample</button></div>
      {speakerError && <p className="muted" role="status">{speakerError}</p>}
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
