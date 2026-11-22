import React, { useEffect, useState } from 'react';
import { download } from './api.js';

export function Notes({ api, id, readOnly = false }) {
  const [draft, setDraft] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const endpoint = '/meetings/' + id + '/notes';
  const dirty = draft !== baseline?.text;
  async function read() {
    setPending(true);
    try { const data = await api(endpoint); setDraft(data.text); setBaseline(data); setMessage(''); }
    catch (error) { setMessage(error.message); }
    finally { setPending(false); }
  }
  useEffect(() => { read(); }, [api, id]);
  async function save() {
    setPending(true);
    try {
      const data = await api(endpoint, { method: 'PUT', body: { text: draft, version: baseline.version } });
      setBaseline(data);
      setMessage('Notes saved.');
    } catch (error) { setMessage(error.message); }
    finally { setPending(false); }
  }
  return <div className="notes">
    <label htmlFor="room-notes">Shared meeting notes</label>
    <textarea id="room-notes" maxLength={12000} readOnly={readOnly} disabled={draft === null} value={draft ?? ''} onChange={event => setDraft(event.target.value)} placeholder="Add decisions and next steps…" />
    <div className="notes-actions">{!readOnly && <button className="button primary" disabled={!dirty || !baseline || pending} onClick={save}>Save</button>}<button className="button" disabled={pending} onClick={() => {
      if (!dirty || window.confirm('Reload the saved notes and discard your unsaved changes?')) read();
    }}>Reload</button><button className="button" disabled={!draft} onClick={() => download('meetrix-notes.md', draft, 'text/markdown')}>Export</button></div>
    {message && <p className="muted" role="status">{message}</p>}
  </div>;
}
