import React, { useEffect, useRef, useState } from 'react';
import { Circle, Download, Film, Square } from 'lucide-react';
import { download } from './api.js';
import { deleteClip, listClips, storeClip } from './clip-store.js';
import { Dialog } from './ui.jsx';

const maxDuration = 120_000;
const maxBytes = 24 * 1024 * 1024;
const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const filename = title => (title.replace(/[^a-z0-9 -]/gi, '').trim() || 'meetrix-clip') + '.webm';

export function Clips({ owner }) {
  const [clips, setClips] = useState(null);
  const [draft, setDraft] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [title, setTitle] = useState('');
  const [withMic, setWithMic] = useState(false);
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    listClips(owner).then(items => {
      if (mounted.current) setClips(items.toSorted((a, b) => b.createdAt - a.createdAt));
    }).catch(() => { if (mounted.current) setError('Could not open the local clip library.'); });
    return () => { mounted.current = false; active.current?.cancel(); };
  }, [owner]);

  async function record() {
    if (active.current || state !== 'idle') return;
    setError('');
    setState('choosing');
    const streams = [];
    const chunks = [];
    let recorder;
    let timer;
    let size = 0;
    let started = 0;
    let failed = false;
    const job = { stop, cancel: () => { stop(); release(); } };
    active.current = job;
    function release() { streams.flatMap(stream => stream.getTracks()).forEach(track => track.stop()); }
    function stop() {
      clearTimeout(timer);
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      else release();
    }

    try {
      const type = ['video/webm;codecs=vp8,opus', 'video/webm'].find(value => globalThis.MediaRecorder?.isTypeSupported(value));
      if (!type || !navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen recording is unavailable on this device.');
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 25 } }, audio: false });
      streams.push(screen);
      if (!mounted.current || active.current !== job) { stop(); return; }
      if (withMic) streams.push(await navigator.mediaDevices.getUserMedia({ audio: true }));
      if (!mounted.current || active.current !== job) { stop(); return; }
      const [video] = screen.getVideoTracks();
      if (video?.readyState !== 'live') throw new Error('The selected source stopped.');
      const input = new MediaStream(streams.flatMap(stream => stream.getTracks()));
      recorder = new MediaRecorder(input, { mimeType: type, videoBitsPerSecond: 950_000 });
      recorder.ondataavailable = ({ data }) => {
        if (!data.size) return;
        chunks.push(data);
        size += data.size;
        if (size >= maxBytes) stop();
      };
      recorder.onerror = () => {
        failed = true;
        if (mounted.current) setError('Screen recording could not continue.');
        stop();
      };
      recorder.onstop = () => {
        clearTimeout(timer);
        release();
        if (active.current === job) active.current = null;
        if (!mounted.current) return;
        if (size && !failed) {
          const createdAt = Date.now();
          setDraft({ owner, id: crypto.randomUUID(), createdAt, duration: createdAt - started,
            blob: new Blob(chunks, { type: 'video/webm' }) });
          setTitle('Screen clip');
        } else if (!failed) setError('No video was recorded from the selected source.');
        setState('idle');
      };
      video.addEventListener('ended', stop, { once: true });
      recorder.start(650);
      started = Date.now();
      timer = setTimeout(stop, maxDuration);
      setState('recording');
    } catch (failure) {
      stop();
      if (active.current === job) active.current = null;
      if (mounted.current) {
        setState('idle');
        if (failure.name !== 'NotAllowedError' || streams.length) {
          setError(failure.name === 'NotAllowedError' ? 'Microphone permission was denied.' : failure.message);
        }
      }
    }
  }

  async function save(event) {
    event.preventDefault();
    if (!draft || !title.trim()) return;
    setBusy(true);
    setError('');
    const clip = { ...draft, title: title.trim() };
    try {
      await storeClip(clip);
      setClips(previous => [clip, ...(previous ?? [])]);
      setDraft(null);
    } catch { setError('The clip could not be saved on this device. You can still download it.'); }
    finally { setBusy(false); }
  }

  async function remove(clip) {
    if (!window.confirm('Delete this local clip?')) return;
    setBusy(true);
    setError('');
    try {
      await deleteClip(owner, clip.id);
      setClips(previous => previous.filter(item => item.id !== clip.id));
      setChosen(null);
    } catch { setError('Could not delete this clip.'); }
    finally { setBusy(false); }
  }

  return <>
    <div className="page-head"><h1>Clips</h1></div>
    <section className="settings-card clip-capture">
      <p>Record a screen or window for up to two minutes. Clips are saved on this device.</p>
      <label className="check"><input type="checkbox" checked={withMic} disabled={state !== 'idle'}
        onChange={event => setWithMic(event.target.checked)} /> Include my microphone</label>
      <div className="meeting-tool-actions">
        {state === 'recording' ? <button className="button danger" onClick={() => active.current?.stop()}><Square size={16} /> Stop recording</button>
          : <button className="button primary" disabled={Boolean(draft) || state !== 'idle' || (clips?.length ?? 0) >= 20}
            onClick={record}><Circle size={16} /> {state === 'choosing' ? 'Choosing source…' : 'Record a clip'}</button>}
      </div>
      {(clips?.length ?? 0) >= 20 && <p className="muted">This device’s library holds up to 20 clips per account.</p>}
      {state === 'recording' && <p role="status">Recording your selected source.</p>}
    </section>
    {error && <p role="alert" className="error">{error}</p>}
    <section className="meeting-list" aria-label="Local clip library">
      {clips?.length === 0 && <p className="empty">No clips on this device.</p>}
      {clips?.map(clip => <article className="meeting-row" key={clip.id}>
        <div className="meeting-symbol"><Film size={18} /></div>
        <div className="meeting-info"><strong>{clip.title}</strong><span>{dateLabel.format(clip.createdAt)}</span></div>
        <button className="button small" aria-label={'Play ' + clip.title} onClick={() => setChosen(clip)}>Play</button>
      </article>)}
    </section>
    {draft && <Dialog title="Save screen clip" close={() => { if (!busy && window.confirm('Discard this unsaved clip?')) setDraft(null); }}>
      <form className="form" onSubmit={save}>
        <ClipVideo blob={draft.blob} />
        <label>Clip title<input value={title} maxLength={100} onChange={event => setTitle(event.target.value)} required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => download(filename(title), draft.blob, 'video/webm')}><Download size={16} /> Save WebM</button>
          <button className="button primary" disabled={busy || !title.trim()}>Save to library</button>
        </div>
      </form>
    </Dialog>}
    {chosen && <Dialog title={chosen.title} close={() => { if (!busy) setChosen(null); }}>
      <ClipVideo blob={chosen.blob} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="button danger" disabled={busy} onClick={() => remove(chosen)}>Delete clip</button>
        <button className="button" onClick={() => download(filename(chosen.title), chosen.blob, 'video/webm')}>Save WebM</button>
      </div>
    </Dialog>}
  </>;
}

function ClipVideo({ blob }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const source = URL.createObjectURL(blob);
    setUrl(source);
    return () => URL.revokeObjectURL(source);
  }, [blob]);
  return <video className="clip-player" aria-label="Clip preview" controls playsInline src={url || undefined} />;
}
