import React, { useEffect, useState } from 'react';
import { CheckSquare, FileText, Plus } from 'lucide-react';
import { download } from './api.js';
import { Dialog } from './ui.jsx';

const empty = { title: '', body: '', dueDate: null, completed: false };

export function PersonalWorkspace({ api, kind }) {
  const tasks = kind === 'tasks';
  const name = tasks ? 'Task' : 'Canvas';
  const [items, setItems] = useState(null);
  const [selected, setSelected] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const path = '/workspace/' + kind;

  useEffect(() => {
    const request = new AbortController();
    api(path, { signal: request.signal }).then(setItems).catch(error => {
      if (!request.signal.aborted) setMessage(error.message);
    });
    return () => request.abort();
  }, [api, path, revision]);

  useEffect(() => {
    if (!selectedId) return;
    const request = new AbortController();
    api(path + '/' + selectedId, { signal: request.signal }).then(setSelected).catch(error => {
      if (!request.signal.aborted) setMessage(error.message);
    });
    return () => request.abort();
  }, [api, path, selectedId]);

  function close() { setSelected(null); setSelectedId(''); }
  function changed() { close(); setRevision(value => value + 1); }

  return <>
    <div className="page-head"><h1>{tasks ? 'Tasks' : 'Canvas'}</h1>
      <button className="button primary" onClick={() => { setSelectedId(''); setSelected({ ...empty }); }}><Plus size={16} /> New {name.toLowerCase()}</button>
    </div>
    <section className="meeting-list" aria-label={tasks ? 'Your tasks' : 'Your canvases'}>
      {message && <div className="notice"><p role="alert">{message}</p>
        <button className="button small" onClick={() => { setMessage(''); close(); setRevision(value => value + 1); }}>Refresh</button></div>}
      {!items && !message && <p className="empty" role="status">Loading…</p>}
      {items?.length === 0 && <p className="empty">{tasks ? 'No tasks yet.' : 'No canvases yet.'}</p>}
      {items?.map(item => <article key={item.id} className="meeting-row">
        <div className="meeting-symbol" aria-hidden="true">{tasks ? <CheckSquare size={18} /> : <FileText size={18} />}</div>
        <div className="meeting-info"><strong>{item.title}</strong>
          {tasks && <span>{item.completed ? 'Complete' : 'Open'}{item.dueDate ? ' · Due ' + item.dueDate : ''}</span>}
        </div>
        <button className="button small" disabled={selectedId === item.id && !selected}
          aria-label={'Edit ' + item.title} onClick={() => { setMessage(''); setSelectedId(item.id); }}>Edit</button>
      </article>)}
    </section>
    {selected && <ItemEditor key={selected.id ?? 'new'} {...{ api, path, tasks, name, selected, close, changed }} />}
  </>;
}

function ItemEditor({ api, path, tasks, name, selected, close, changed }) {
  const [draft, setDraft] = useState(selected);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState(false);
  const endpoint = path + (selected.id ? '/' + selected.id : '');
  const dirty = ['title', 'body', 'dueDate', 'completed'].some(key => draft[key] !== selected[key]);

  function update(key, value) { setDraft(previous => ({ ...previous, [key]: value })); }
  function exit() {
    if (!pending && (!dirty || window.confirm('Discard unsaved changes?'))) close();
  }
  async function submit(event) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const { title, body, dueDate, completed } = draft;
      await api(endpoint, {
        method: selected.id ? 'PUT' : 'POST',
        body: { title, body, dueDate, completed, ...(selected.id ? { version: selected.version } : {}) },
      });
      changed();
    } catch (failure) { setError(failure.message); }
    finally { setPending(false); }
  }
  async function remove() {
    if (!window.confirm('Delete this ' + name.toLowerCase() + '?')) return;
    setPending(true);
    setError('');
    try { await api(endpoint, { method: 'DELETE', body: { version: selected.version } }); changed(); }
    catch (failure) { setError(failure.message); }
    finally { setPending(false); }
  }

  return <Dialog title={(selected.id ? 'Edit ' : 'New ') + name.toLowerCase()} close={exit}>
    <form className="form" onSubmit={submit}>
      <label>Title<input value={draft.title} maxLength={120} required autoFocus
        onChange={event => update('title', event.target.value)} /></label>
      {!tasks && <div className="segment" aria-label="Canvas view">
        <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Write</button>
        <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button>
      </div>}
      {preview ? <div className="canvas-preview" aria-label="Canvas preview">{draft.body.split('\n').map((line, index) => {
        if (line.startsWith('## ')) return <h3 key={index}>{line.slice(3)}</h3>;
        if (line.startsWith('# ')) return <h2 key={index}>{line.slice(2)}</h2>;
        if (/^[-*] /.test(line)) return <p key={index}>• {line.slice(2)}</p>;
        return <p key={index}>{line || '\u00a0'}</p>;
      })}</div> : <label>{tasks ? 'Details' : 'Canvas content'}
        <textarea value={draft.body} rows={tasks ? 4 : 10} maxLength={12000} onChange={event => update('body', event.target.value)} />
      </label>}
      {tasks && <>
        <label>Due date<input type="date" value={draft.dueDate ?? ''} onChange={event => update('dueDate', event.target.value || null)} /></label>
        <label className="check"><input type="checkbox" checked={draft.completed} onChange={event => update('completed', event.target.checked)} /> Complete</label>
      </>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="dialog-actions">
        {selected.id && <button type="button" className="button danger" disabled={pending} onClick={remove}>Delete</button>}
        {!tasks && <button type="button" className="button" disabled={!draft.body}
          onClick={() => download('meetrix-canvas.md', '# ' + draft.title + '\n\n' + draft.body, 'text/markdown')}>Export Markdown</button>}
        <button className="button primary" disabled={pending || !draft.title.trim()}>{pending ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  </Dialog>;
}
