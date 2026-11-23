import React, { useEffect, useState } from 'react';
import { Mic, Video, Volume2 } from 'lucide-react';

const storageKey = 'meetrix-devices';
const defaults = { camera: false, microphone: false, cameraId: '', microphoneId: '', speakerId: '' };
const fields = [
  { key: 'microphone', kind: 'audioinput', label: 'Microphone', Icon: Mic },
  { key: 'camera', kind: 'videoinput', label: 'Camera', Icon: Video },
  { key: 'speaker', kind: 'audiooutput', label: 'Speaker', Icon: Volume2 },
];

export function useDevicePreferences() {
  const [prefs, setPrefs] = useState(() => {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem(storageKey) || '{}') }; }
    catch { return defaults; }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(prefs)); } catch { /* Keep settings in memory. */ }
  }, [prefs]);
  return [prefs, changes => setPrefs(prior => ({ ...prior, ...changes }))];
}

export function captureOptions(id) {
  return id ? { deviceId: { exact: id } } : {};
}

export function DeviceFields({ prefs, changeDevice, showDefaults = false, updatePrefs, inCall = false }) {
  const [devices, setDevices] = useState([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const media = navigator.mediaDevices;
  const speakerSupported = typeof HTMLMediaElement.prototype.setSinkId === 'function';

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
        const results = await Promise.allSettled([
          media.getUserMedia({ audio: true }),
          media.getUserMedia({ video: true }),
        ]);
        for (const result of results) if (result.status === 'fulfilled') {
          result.value.getTracks().forEach(track => track.stop());
        }
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
    {fields.map(field => {
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
        {showDefaults && key !== 'speaker' && <label className="check">
          <input type="checkbox" checked={prefs[key]} onChange={event => updatePrefs({ [key]: event.target.checked })} /> Start on
        </label>}
      </div>;
    })}
    <button type="button" className="button small" disabled={busy} onClick={refresh}>{inCall ? 'Refresh devices' : 'Detect devices'}</button>
    {!speakerSupported && <p className="muted">This browser uses your system’s default speaker.</p>}
    {notice && <p className="muted" role="status">{notice}</p>}
  </div>;
}
