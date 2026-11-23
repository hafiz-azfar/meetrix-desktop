import React, { useEffect, useRef, useState } from 'react';
import { AudioLines, Mic, SlidersHorizontal, Video, Volume2 } from 'lucide-react';
import { CameraPreview, DeviceFields, microphoneOptions, SpeakerVolume } from './media-devices.jsx';

const sections = [
  { id: 'audio', title: 'Audio', icon: AudioLines },
  { id: 'video', title: 'Video', icon: Video },
  { id: 'meetings', title: 'Meeting defaults', icon: SlidersHorizontal },
];

function MicrophoneCheck({ prefs }) {
  const { microphoneId, reduceNoise } = prefs;
  const [running, setRunning] = useState(false);
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let stream;
    let context;
    let timer;
    setMessage('Opening microphone…');
    async function sample() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneOptions({ microphoneId, reduceNoise }) });
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        await context.resume();
        if (cancelled) return;
        const samples = new Float32Array(analyser.fftSize);
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3));
        }, 90);
        setMessage('Speak to check the input level.');
      } catch {
        if (!cancelled) {
          setRunning(false);
          setMessage('Microphone unavailable. Check your device or permissions.');
        }
      }
    }
    sample();
    return () => {
      cancelled = true;
      clearInterval(timer);
      stream?.getTracks().forEach(track => track.stop());
      context?.close().catch(() => {});
    };
  }, [running, microphoneId, reduceNoise]);

  return <section className="device-check">
    <h3><Mic size={17} /> Microphone check</h3>
    <meter aria-label="Microphone input level" min="0" max="1" value={running ? level : 0} />
    <button className="button small" onClick={() => {
      setLevel(0); setMessage(''); setRunning(!running);
    }}>{running ? 'Stop microphone check' : 'Check microphone'}</button>
    {message && <p className="muted" role="status">{message}</p>}
  </section>;
}

function SpeakerCheck({ prefs }) {
  const player = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => {
    const context = player.current;
    player.current = null;
    context?.close().catch(() => {});
  }, []);

  async function play() {
    setPlaying(true);
    setError('');
    let context;
    try {
      context = new AudioContext();
      player.current = context;
      if (prefs.speakerId) await context.setSinkId(prefs.speakerId);
      if (player.current !== context) return;
      await context.resume();
      if (player.current !== context) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime;
      const volume = prefs.speakerVolume * 0.16;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume, start + 0.06);
      gain.gain.setValueAtTime(volume, start + 0.65);
      gain.gain.linearRampToValueAtTime(0, start + 0.85);
      oscillator.frequency.setValueAtTime(523.25, start);
      oscillator.frequency.setValueAtTime(659.25, start + 0.4);
      oscillator.connect(gain).connect(context.destination);
      oscillator.onended = () => {
        if (player.current !== context) return;
        player.current = null;
        context.close().catch(() => {});
        setPlaying(false);
      };
      oscillator.start(start);
      oscillator.stop(start + 0.85);
    } catch {
      if (context && player.current !== context) return;
      player.current = null;
      context?.close().catch(() => {});
      setPlaying(false);
      setError('The test tone could not play through this speaker.');
    }
  }

  return <section className="device-check">
    <h3><Volume2 size={18} /> Speaker check</h3>
    <button className="button small" disabled={playing} onClick={play}>{playing ? 'Playing test tone…' : 'Play test tone'}</button>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

function AudioSettings({ prefs, updatePrefs }) {
  return <>
    <h2 id="settings-section">Audio</h2>
    <div className="settings-card">
      <h3>Devices</h3>
      <DeviceFields kinds={['audioinput', 'audiooutput']} prefs={prefs}
        changeDevice={({ key }, value) => updatePrefs({ [key + 'Id']: value })} />
      <div className="settings-options">
        <SpeakerVolume prefs={prefs} updatePrefs={updatePrefs} />
        <label className="check"><input type="checkbox" checked={prefs.reduceNoise}
          onChange={event => updatePrefs({ reduceNoise: event.target.checked })} /> Reduce background noise</label>
      </div>
    </div>
    <div className="device-checks">
      <MicrophoneCheck prefs={prefs} />
      <SpeakerCheck prefs={prefs} />
    </div>
  </>;
}

function VideoSettings({ prefs, updatePrefs }) {
  const [preview, setPreview] = useState(false);
  return <>
    <h2 id="settings-section">Video</h2>
    <div className="settings-card video-settings">
      <CameraPreview enabled={preview} deviceId={prefs.cameraId} mirror={prefs.mirrorCamera} />
      <div className="settings-options">
        <button className="button small" onClick={() => setPreview(!preview)}>{preview ? 'Stop preview' : 'Start camera preview'}</button>
        <label className="check"><input type="checkbox" checked={prefs.mirrorCamera}
          onChange={event => updatePrefs({ mirrorCamera: event.target.checked })} /> Mirror my local view</label>
      </div>
      <DeviceFields kinds={['videoinput']} prefs={prefs} inCall={preview}
        changeDevice={({ key }, value) => updatePrefs({ [key + 'Id']: value })} />
    </div>
  </>;
}

function MeetingDefaults({ prefs, updatePrefs }) {
  return <>
    <h2 id="settings-section">Meeting defaults</h2>
    <div className="settings-card settings-options">
      <label className="check"><input type="checkbox" checked={!prefs.microphone}
        onChange={event => updatePrefs({ microphone: !event.target.checked })} /> Mute my microphone when joining</label>
      <label className="check"><input type="checkbox" checked={!prefs.camera}
        onChange={event => updatePrefs({ camera: !event.target.checked })} /> Keep my camera off when joining</label>
      <label className="default-view">Starting layout
        <select value={prefs.layout} onChange={event => updatePrefs({ layout: event.target.value })}>
          <option value="grid">Gallery</option><option value="speaker">Speaker</option>
        </select>
      </label>
    </div>
  </>;
}

export function WorkspaceSettings({ prefs, updatePrefs }) {
  const [section, setSection] = useState('audio');
  const settings = { prefs, updatePrefs };
  return <div className="settings-layout">
    <nav className="settings-nav" aria-label="Settings categories">
      {sections.map(({ id, title, icon: Icon }) => <button className="nav-button" key={id}
        aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>
        <Icon size={18} /><span>{title}</span>
      </button>)}
    </nav>
    <section className="settings-content" aria-labelledby="settings-section">
      {section === 'audio' && <AudioSettings {...settings} />}
      {section === 'video' && <VideoSettings {...settings} />}
      {section === 'meetings' && <MeetingDefaults {...settings} />}
    </section>
  </div>;
}
