import React, { useEffect, useRef, useState } from 'react';
import { Accessibility, AudioLines, Keyboard, Mic, MonitorUp, Palette, SlidersHorizontal, Video, Volume2 } from 'lucide-react';
import { CameraPreview, DeviceFields, microphoneOptions, SpeakerVolume } from './media-devices.jsx';
import { CameraBackgroundFields } from './camera-background.jsx';
import { defaultShortcuts, meetingShortcuts } from './shortcuts.js';

const sections = [
  { id: 'appearance', title: 'Appearance', icon: Palette, Component: AppearanceSettings },
  { id: 'audio', title: 'Audio', icon: AudioLines, Component: AudioSettings },
  { id: 'video', title: 'Video', icon: Video, Component: VideoSettings },
  { id: 'meetings', title: 'Meeting defaults', icon: SlidersHorizontal, Component: MeetingDefaults },
  { id: 'sharing', title: 'Screen sharing', icon: MonitorUp, Component: SharingSettings },
  { id: 'accessibility', title: 'Accessibility', icon: Accessibility, Component: AccessibilitySettings },
  { id: 'shortcuts', title: 'Keyboard shortcuts', icon: Keyboard, Component: ShortcutSettings },
];

const viewPreferences = [
  { key: 'meetingTimer', text: 'Show elapsed time' },
  { key: 'hideSelf', text: 'Hide my tile from my view' },
  { key: 'cameraOnly', text: 'Hide tiles for participants with cameras off' },
  { key: 'showNames', text: 'Show names on video tiles' },
  { key: 'pauseIncomingCameras', text: 'Pause incoming cameras' },
];

export function CallViewOptions({ prefs, updatePrefs }) {
  return <div className="preference-list">
    {viewPreferences.map(({ key, text }) => <label className="check" key={key}>
      <input type="checkbox" checked={prefs[key]} onChange={event => updatePrefs({ [key]: event.target.checked })} />{text}
    </label>)}
  </div>;
}

function AppearanceSettings({ prefs, updatePrefs }) {
  return <>
    <h2 id="settings-section">Appearance</h2>
    <div className="settings-card">
      <label className="default-view">App theme
        <select value={prefs.theme} onChange={event => updatePrefs({ theme: event.target.value })}>
          <option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option>
        </select>
      </label>
      {!!window.meetrixDesktop?.setDesktopPreferences && <>
        <label className="check"><input type="checkbox" checked={prefs.minimizeToTray}
          onChange={event => updatePrefs({ minimizeToTray: event.target.checked })} /> Minimize Meetrix to the notification area</label>
        <label className="check"><input type="checkbox" checked={prefs.meetingReminders}
          onChange={event => updatePrefs({ meetingReminders: event.target.checked })} /> Show a Windows reminder five minutes before meetings</label>
      </>}
    </div>
  </>;
}

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
      <CameraPreview enabled={preview} deviceId={prefs.cameraId} mirror={prefs.mirrorCamera}
        background={prefs.background} backgroundImage={prefs.backgroundImage} />
      <div className="settings-options">
        <button className="button small" onClick={() => setPreview(!preview)}>{preview ? 'Stop preview' : 'Start camera preview'}</button>
        <label className="check"><input type="checkbox" checked={prefs.mirrorCamera}
          onChange={event => updatePrefs({ mirrorCamera: event.target.checked })} /> Mirror my local view</label>
      </div>
      <DeviceFields kinds={['videoinput']} prefs={prefs} inCall={preview}
        changeDevice={({ key }, value) => updatePrefs({ [key + 'Id']: value })} />
      <CameraBackgroundFields prefs={prefs} onChange={updatePrefs} />
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
      <label className="check"><input type="checkbox" checked={prefs.confirmLeave}
        onChange={event => updatePrefs({ confirmLeave: event.target.checked })} /> Confirm before leaving</label>
      <label className="default-view">Starting layout
        <select value={prefs.layout} onChange={event => updatePrefs({ layout: event.target.value })}>
          <option value="grid">Gallery</option><option value="speaker">Speaker</option>
        </select>
      </label>
    </div>
    <div className="settings-card"><h3>Meeting display</h3><CallViewOptions prefs={prefs} updatePrefs={updatePrefs} /></div>
  </>;
}

function SharingSettings({ prefs, updatePrefs }) {
  return <>
    <h2 id="settings-section">Screen sharing</h2>
    <div className="settings-card">
      <h3>When I present</h3>
      <label className="default-view">Capture frame rate
        <select value={prefs.shareFps} onChange={event => updatePrefs({ shareFps: Number(event.target.value) })}>
          <option value={0}>Automatic</option><option value={5}>Up to 5 fps</option>
          <option value={15}>Up to 15 fps</option><option value={30}>Up to 30 fps</option>
        </select>
      </label>
      <label className="default-view">Content priority
        <select value={prefs.shareHint} onChange={event => updatePrefs({ shareHint: event.target.value })}>
          <option value="">Automatic</option><option value="text">Readable text</option><option value="motion">Smooth motion</option>
        </select>
      </label>
    </div>
    <div className="settings-card">
      <h3>While viewing a presentation</h3>
      <label className="default-view">Shared screen layout
        <select value={prefs.shareLayout} onChange={event => updatePrefs({ shareLayout: event.target.value })}>
          <option value="stacked">Participants below</option><option value="side">Side by side</option>
        </select>
      </label>
    </div>
  </>;
}

function AccessibilitySettings({ prefs, updatePrefs }) {
  return <>
    <h2 id="settings-section">Accessibility</h2>
    <div className="settings-card">
      <label className="default-view">Meeting chat text size
        <select value={prefs.chatSize} onChange={event => updatePrefs({ chatSize: event.target.value })}>
          <option value="standard">Standard</option><option value="large">Large</option><option value="largest">Extra large</option>
        </select>
      </label>
      <label className="default-view">Caption text size
        <select value={prefs.captionSize} onChange={event => updatePrefs({ captionSize: event.target.value })}>
          <option value="standard">Standard</option><option value="large">Large</option><option value="largest">Extra large</option>
        </select>
      </label>
      <label className="default-view">Caption contrast
        <select value={prefs.captionContrast} onChange={event => updatePrefs({ captionContrast: event.target.value })}>
          <option value="standard">White on dark</option><option value="yellow">Yellow on black</option><option value="light">Black on white</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={prefs.announceMessages}
        onChange={event => updatePrefs({ announceMessages: event.target.checked })} /> Announce new messages in the open chat panel</label>
      <label className="check"><input type="checkbox" checked={prefs.reducedMotion}
        onChange={event => updatePrefs({ reducedMotion: event.target.checked })} /> Reduce motion</label>
    </div>
  </>;
}

const shortcutKeys = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function ShortcutSettings({ prefs, updatePrefs }) {
  return <>
    <h2 id="settings-section">Keyboard shortcuts</h2>
    <div className="settings-card">
      <label className="check"><input type="checkbox" checked={prefs.shortcutsEnabled}
        onChange={event => updatePrefs({ shortcutsEnabled: event.target.checked })} /> Enable meeting shortcuts</label>
      <label className="default-view">Push-to-talk key
        <select value={prefs.pushToTalk} onChange={event => updatePrefs({ pushToTalk: event.target.value })}>
          <option value="">Off</option><option value="Space">Space</option><option value="Backquote">Backtick</option><option value="F8">F8</option>
        </select>
      </label>
      <p className="muted">Hold the selected key while muted to talk. Use Alt + Shift for the other meeting shortcuts.</p>
      <div className="preference-list">
        {meetingShortcuts.map(({ id, label }) => <label className="default-view" key={id}>{label}
          <select aria-label={label} value={prefs.shortcuts[id]} disabled={!prefs.shortcutsEnabled}
            onChange={event => updatePrefs({ shortcuts: { ...prefs.shortcuts, [id]: event.target.value } })}>
            <option value="">Unassigned</option>
            {shortcutKeys.map(key => <option key={key} value={key}
              disabled={meetingShortcuts.some(other => other.id !== id && prefs.shortcuts[other.id] === key)}>Alt + Shift + {key}</option>)}
          </select>
        </label>)}
      </div>
      <div><button className="button small" onClick={() => updatePrefs({ shortcuts: defaultShortcuts })}>Restore default shortcuts</button></div>
    </div>
  </>;
}

export function WorkspaceSettings({ prefs, updatePrefs }) {
  const [section, setSection] = useState('audio');
  const { Component } = sections.find(item => item.id === section);
  return <div className="settings-layout">
    <nav className="settings-nav" aria-label="Settings categories">
      {sections.map(({ id, title, icon: Icon }) => <button className="nav-button" key={id}
        aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>
        <Icon size={18} /><span>{title}</span>
      </button>)}
    </nav>
    <section className="settings-content" aria-labelledby="settings-section">
      <Component prefs={prefs} updatePrefs={updatePrefs} />
    </section>
  </div>;
}
