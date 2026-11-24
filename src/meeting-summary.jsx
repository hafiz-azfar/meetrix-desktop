import React, { useEffect, useRef, useState } from 'react';
import { download } from './api.js';

const sourceLimit = 2400;

export function MeetingSummary({ notes, captionEntries = [] }) {
  const [source, setSource] = useState('');
  const [draft, setDraft] = useState(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const worker = useRef(null);
  const timeout = useRef(null);

  function stop() {
    clearTimeout(timeout.current);
    worker.current?.terminate();
    worker.current = null;
  }

  useEffect(() => stop, []);

  function generate() {
    if (pending || !source.trim()) return;
    setPending(true);
    setDraft(null);
    setMessage('Preparing summary on this device…');
    function finish(text) {
      stop();
      setPending(false);
      setDraft(text || null);
      setMessage(text ? 'Review the draft before saving.' : 'The summary could not be generated. Try a shorter excerpt.');
    }
    try {
      const job = crypto.randomUUID();
      worker.current = new Worker(new URL('./caption-translation-worker.js', import.meta.url), { type: 'module' });
      worker.current.onmessage = ({ data }) => {
        if (data?.id === job) finish(typeof data.text === 'string' ? data.text : '');
      };
      worker.current.onerror = () => finish('');
      timeout.current = setTimeout(() => finish(''), 90_000);
      worker.current.postMessage({ id: job, text: source.trim(), action: 'summarize' });
    } catch { finish(''); }
  }

  return <details className="summary-panel">
    <summary>AI meeting summary</summary>
    <p className="muted">Summarize up to 2,400 characters of English notes or captions on this device.</p>
    <div className="meeting-tool-actions">
      <button className="button small" disabled={pending || !notes.trim()} onClick={() => setSource(notes.slice(0, sourceLimit))}>Use meeting notes</button>
      {!!captionEntries.length && <button className="button small" disabled={pending} onClick={() => setSource(
        captionEntries.map(({ speaker, line }) => speaker ? speaker + ': ' + line : line).join('\n').slice(-sourceLimit),
      )}>Use recent captions</button>}
    </div>
    <label>Text to summarize<textarea rows={4} maxLength={sourceLimit} disabled={pending}
      value={source} onChange={event => setSource(event.target.value)} /></label>
    <div className="meeting-tool-actions">
      <button className="button primary small" disabled={pending || !source.trim()} onClick={generate}>Generate summary</button>
      {pending && <button className="button small" onClick={() => { stop(); setPending(false); setMessage(''); }}>Cancel</button>}
    </div>
    {message && <p role="status" className="muted">{message}</p>}
    {draft != null && <div className="form">
      <label>Summary draft<textarea rows={4} value={draft} onChange={event => setDraft(event.target.value)} maxLength={2400} /></label>
      <div><button className="button small" disabled={!draft.trim()} onClick={() => download('meetrix-summary.txt', draft + '\n', 'text/plain;charset=utf-8')}>Download summary</button></div>
    </div>}
  </details>;
}
