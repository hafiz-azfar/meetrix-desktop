import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Video, VideoOff, Volume2 } from 'lucide-react';
import { defaultShortcuts } from './shortcuts.js';
import { validBackgroundImage } from './camera-background.jsx';

const storageKey = 'meetrix-devices';
const defaults = {
  camera: false, microphone: false, cameraId: '', microphoneId: '', speakerId: '',
  mirrorCamera: true, reduceNoise: true, speakerVolume: 1, layout: 'grid',
  background: 'off', backgroundImage: '',
  theme: 'light', meetingTimer: false, hideSelf: false, cameraOnly: false, showNames: true,
  confirmLeave: false, pauseIncomingCameras: false, shareFps: 0, shareHint: '', shareLayout: 'stacked',
  chatSize: 'standard', announceMessages: true, reducedMotion: false,
  captionSize: 'standard', captionContrast: 'standard',
  shortcutsEnabled: true, shortcuts: defaultShortcuts,
};
const fields = [
  { key: 'microphone', kind: 'audioinput', label: 'Microphone', Icon: Mic },
  { key: 'camera', kind: 'videoinput', label: 'Camera', Icon: Video },
  { key: 'speaker', kind: 'audiooutput', label: 'Speaker', Icon: Volume2 },
];

export function useDevicePreferences() {
  const [prefs, setPrefs] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}') ?? {};
      const backgroundImage = validBackgroundImage(saved.backgroundImage) ? saved.backgroundImage : '';
      const background = saved.background === 'blur' || (saved.background === 'image' && backgroundImage) ? saved.background : 'off';
      return { ...defaults, ...saved, background, backgroundImage, shortcuts: { ...defaultShortcuts, ...saved.shortcuts } };
    }
    catch { return defaults; }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(prefs)); } catch { /* Keep settings in memory. */ }
  }, [prefs]);
  const updatePrefs = useCallback(changes => setPrefs(prior => ({ ...prior, ...changes })), []);
  return [prefs, updatePrefs];
}

export function captureOptions(id) {
  return id ? { deviceId: { exact: id } } : {};
}

export function microphoneOptions(prefs) {
  return { ...captureOptions(prefs.microphoneId), noiseSuppression: prefs.reduceNoise };
}

export function CameraPreview({ enabled, deviceId, mirror = true, background = 'off', backgroundImage = '' }) {
  const [status, setStatus] = useState('');
  const video = useRef(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let stream;
    let processor;
    const element = video.current;
    setStatus('Starting camera…');
    Promise.resolve().then(() => navigator.mediaDevices.getUserMedia({ video: captureOptions(deviceId) }))
      .then(async result => {
        if (cancelled) { result.getTracks().forEach(track => track.stop()); return; }
        stream = result;
        if (background === 'off') element.srcObject = result;
        else {
          setStatus('Preparing camera background…');
          const { BackgroundProcessor } = await import('./background-processor.js');
          if (cancelled) return;
          processor = new BackgroundProcessor(background, backgroundImage, message => {
            if (!cancelled) setStatus(message);
          });
          await processor.init({ track: result.getVideoTracks()[0] });
          if (cancelled) return;
          element.srcObject = new MediaStream([processor.processedTrack]);
        }
        setStatus('');
      })
      .catch(() => {
        stream?.getTracks().forEach(track => track.stop());
        if (!cancelled) setStatus(background === 'off' ? 'Camera unavailable' : 'Camera preview with this background is unavailable.');
      });
    return () => {
      cancelled = true;
      element.srcObject = null;
      void processor?.destroy();
      stream?.getTracks().forEach(track => track.stop());
    };
  }, [deviceId, enabled, background, backgroundImage]);
  return <div className="preview">
    <video className={mirror ? 'mirrored-video' : undefined} ref={video} autoPlay playsInline muted />
    {(!enabled || status) && <div className="preview-empty" role="status"><VideoOff size={26} />
      {enabled ? status : 'Camera preview is off'}
    </div>}
  </div>;
}

export function SpeakerVolume({ prefs, updatePrefs }) {
  const percent = Math.round(prefs.speakerVolume * 100);
  return <label className="volume-setting">
    <span>Speaker volume</span>
    <input type="range" min="0" max="100" value={percent}
      aria-valuetext={percent + '%'} onChange={event => updatePrefs({ speakerVolume: event.target.valueAsNumber / 100 })} />
    <output aria-hidden="true">{percent}%</output>
  </label>;
}

export function DeviceFields({ prefs, changeDevice, kinds, inCall = false }) {
  const [devices, setDevices] = useState([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const media = navigator.mediaDevices;
  const speakerSupported = typeof HTMLMediaElement.prototype.setSinkId === 'function';
  const visibleFields = kinds ? fields.filter(field => kinds.includes(field.kind)) : fields;
  const hasSpeaker = visibleFields.some(field => field.kind === 'audiooutput');

  useEffect(() => {
    let cancelled = false;
    async function scan() {
      try {
        const list = await media.enumerateDevices();
        if (!cancelled) setDevices(list);
      } catch { if (!cancelled) setNotice('Devices could not be read on this computer.'); }
    }
    scan();
    media?.addEventListener('devicechange', scan);
    return () => { cancelled = true; media?.removeEventListener('devicechange', scan); };
  }, [media]);

  async function refresh() {
    setBusy(true);
    setNotice('');
    try {
      if (!inCall) {
        const input = [];
        if (visibleFields.some(field => field.kind !== 'videoinput')) input.push({ audio: true });
        if (visibleFields.some(field => field.kind === 'videoinput')) input.push({ video: true });
        const results = await Promise.allSettled(input.map(async constraints => {
          const stream = await media.getUserMedia(constraints);
          stream.getTracks().forEach(track => track.stop());
        }));
        if (results.some(result => result.status === 'rejected')) setNotice('Some devices are unavailable or blocked by system permissions.');
      }
      setDevices(await media.enumerateDevices());
    } catch { setNotice('Devices could not be read on this computer.'); }
    finally { setBusy(false); }
  }

  async function select(field, value) {
    setBusy(true);
    setNotice('');
    try { await changeDevice(field, value); }
    catch { setNotice('Could not switch ' + field.label.toLowerCase() + '. Try another device.'); }
    finally { setBusy(false); }
  }

  return <div className="device-fields">
    {visibleFields.map(field => {
      const { key, kind, label, Icon } = field;
      const value = prefs[key + 'Id'];
      const available = devices.filter(device => device.kind === kind && device.deviceId && device.deviceId !== 'default');
      return <div className="settings-row" key={key}>
        <div><Icon size={18} /><strong>{label}</strong></div>
        <select aria-label={label + ' device'} disabled={busy || (kind === 'audiooutput' && !speakerSupported)}
          value={value} onChange={event => select(field, event.target.value)}>
          <option value="">System default</option>
          {value && !available.some(device => device.deviceId === value) && <option value={value}>Saved device</option>}
          {available.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || label + ' ' + (index + 1)}</option>)}
        </select>
      </div>;
    })}
    <button type="button" className="button small" disabled={busy} onClick={refresh}>{inCall ? 'Refresh devices' : 'Detect devices'}</button>
    {hasSpeaker && !speakerSupported && <p className="muted">This browser uses your system’s default speaker.</p>}
    {notice && <p className="muted" role="status">{notice}</p>}
  </div>;
}
