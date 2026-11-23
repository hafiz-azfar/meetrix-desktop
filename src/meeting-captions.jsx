import { useEffect, useRef, useState } from 'react';
import { RoomEvent } from 'livekit-client';
import { Send } from 'lucide-react';
import { download } from './api.js';

const topic = 'meetrix.manual-caption';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const captionLength = 240;

export function useManualCaptions(room, { enabled, hostIdentity }) {
  const [entries, setEntries] = useState([]);
  const [current, setCurrent] = useState(null);
  const [visible, setVisible] = useState(true);
  const lastCaption = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    function receive(payload, participant, _kind, packetTopic) {
      if (packetTopic !== topic || !participant || participant.identity !== hostIdentity || payload.byteLength > 960) return;
      const line = decoder.decode(payload).trim();
      if (line.length && line.length <= captionLength && !/[\u0000-\u001f\u007f]/.test(line)) append(line);
    }
    room.on(RoomEvent.DataReceived, receive);
    return () => room.off(RoomEvent.DataReceived, receive);
  }, [enabled, room, hostIdentity]);

  useEffect(() => {
    if (!current) return;
    const timeout = setTimeout(() => setCurrent(null), 8000);
    return () => clearTimeout(timeout);
  }, [current]);

  function append(line) {
    const now = Date.now();
    if (now - lastCaption.current < 250) return;
    lastCaption.current = now;
    const entry = { line, at: now };
    setCurrent(entry);
    setEntries(previous => [...previous.slice(-999), entry]);
  }

  async function send(line) {
    if (!enabled || room.localParticipant.identity !== hostIdentity) return;
    const clean = line.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, captionLength);
    if (!clean) return;
    if (Date.now() - lastCaption.current < 250) throw new Error('Wait a moment before sending another caption.');
    await room.localParticipant.publishData(encoder.encode(clean), { reliable: true, topic });
    append(clean);
  }

  return { entries, current, visible, setVisible, send };
}

export function CaptionsOverlay({ captions }) {
  if (!captions.visible || !captions.current) return null;
  return <div className="caption-overlay" role="status"><span>{captions.current.line}</span></div>;
}

const formatTime = value => new Date(value).toLocaleTimeString([], {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function CaptionsPanel({ captions, host, online, meetingId }) {
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
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

  function save() {
    const text = captions.entries.map(({ line, at }) => formatTime(at) + '  ' + line).join('\n');
    download('meetrix-' + meetingId + '-captions.txt', text + '\n', 'text/plain;charset=utf-8');
  }

  return <div className="meeting-tool-panel captions-panel">
    <label className="caption-toggle"><input type="checkbox" checked={captions.visible} onChange={event => captions.setVisible(event.target.checked)} /> Show captions on stage</label>
    <div className="caption-history" role="region" aria-label="Caption history" tabIndex={0}>
      {captions.entries.length ? <ol>{captions.entries.map(({ line, at }) => <li key={at}><time dateTime={new Date(at).toISOString()}>{formatTime(at)}</time> {line}</li>)}</ol>
        : <p className="muted">Captions typed by the host appear here.</p>}
      <span ref={end} />
    </div>
    {error && <p role="status">{error}</p>}
    {host && <form className="caption-form" onSubmit={submit}>
      <input aria-label="Caption text" placeholder="Type a live caption" maxLength={captionLength} value={draft} onChange={event => setDraft(event.target.value)} />
      <button className="icon-button" disabled={pending || !online || !draft.trim()} aria-label="Send caption"><Send size={18} /></button>
    </form>}
    {captions.entries.length > 0 && <button className="button" onClick={save}>Save caption history</button>}
  </div>;
}
