import React, { useEffect, useState } from 'react';
import { Dialog } from './ui.jsx';

const path = '/workspace/channels';
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function TeamChat({ api, name }) {
  const [channels, setChannels] = useState(null);
  const [selection, setSelection] = useState(null);
  const [mode, setMode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    api(path, { signal: request.signal }).then(setChannels).catch(failure => {
      if (!request.signal.aborted) setError(failure.message);
    });
    return () => request.abort();
  }, [api]);

  async function submit(event) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('value');
    setBusy(true);
    setError('');
    try {
      const channel = await api(path + (mode === 'join' ? '/join' : ''), {
        method: 'POST', body: mode === 'join' ? { name, code: value } : { name, title: value },
      });
      setChannels(previous => [...(previous ?? []).filter(item => item.id !== channel.id), channel]);
      setSelection(channel.id);
      setMode('');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  const channel = channels?.find(item => item.id === selection);
  return <>
    <div className="page-head"><h1>Team chat</h1><div className="meeting-tool-actions">
      <button className="button" onClick={() => { setMode('join'); setError(''); }}>Join channel</button>
      <button className="button primary" onClick={() => { setMode('create'); setError(''); }}>New channel</button>
    </div></div>
    {!mode && error && <p className="error" role="alert">{error}</p>}
    {channels?.length > 0 && <div className="segment chat-channels" aria-label="Team channels">
      {channels.map(item => <button type="button" key={item.id} aria-pressed={selection === item.id}
        onClick={() => setSelection(item.id)}>{item.title}</button>)}
    </div>}
    {!channels && !error && <p role="status">Loading channels…</p>}
    {channels && !channel && <p className="empty">{channels.length ? 'Select a channel.' : 'You have no channels yet.'}</p>}
    {channel && <Channel key={channel.id} api={api} channel={channel} onExit={() => {
      setChannels(previous => previous.filter(item => item.id !== channel.id));
      setSelection(null);
    }} />}
    {mode && <Dialog title={mode === 'join' ? 'Join a channel' : 'New channel'} close={() => { if (!busy) setMode(''); }}>
      <form className="form" onSubmit={submit}>
        <label>{mode === 'join' ? 'Invite code' : 'Channel name'}<input name="value" required autoFocus maxLength={80} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="button primary" disabled={busy}>{mode === 'join' ? 'Join' : 'Create'}</button></div>
      </form>
    </Dialog>}
  </>;
}

function Channel({ api, channel, onExit }) {
  const [snapshot, setSnapshot] = useState(null);
  const [text, setText] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [inaccessible, setInaccessible] = useState(false);
  const endpoint = path + '/' + channel.id;
  const log = endpoint + '/messages';

  useEffect(() => {
    const request = new AbortController();
    let timer;
    async function refresh() {
      try {
        const data = await api(log, { signal: request.signal });
        if (!request.signal.aborted) setSnapshot(data);
      } catch (failure) {
        if (!request.signal.aborted && failure.status === 404) {
          setInaccessible(true);
          setSnapshot(null);
          setCode('');
          return;
        }
        if (!request.signal.aborted) setError(failure.message);
      }
      if (!request.signal.aborted) timer = setTimeout(refresh, 4000);
    }
    refresh();
    return () => { request.abort(); clearTimeout(timer); };
  }, [api, log, revision]);

  async function action(url, method, body, done) {
    setBusy(true);
    setError('');
    try { done(await api(url, { method, body })); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function post(event) {
    event.preventDefault();
    await action(log, 'POST', { text }, message => {
      setText('');
      setSnapshot(previous => ({ ...previous, messages: [...(previous?.messages ?? []).filter(item => item.id !== message.id), message] }));
      setRevision(value => value + 1);
    });
  }
  if (inaccessible) return <section className="settings-card">
    <p role="status">You no longer have access to this channel.</p>
    <button className="button" onClick={onExit}>Dismiss</button>
  </section>;

  return <section className="settings-card team-channel">
    <div className="section-header"><h2>{channel.title}</h2>
      {channel.isOwner && <button className="button small" disabled={busy} onClick={() => action(endpoint + '/invite', 'POST', {}, result => setCode(result.code))}>Generate invite code</button>}
    </div>
    <div><button className="button small" disabled={busy} onClick={() => {
      const confirm = channel.isOwner ? 'Delete this channel and its messages for everyone?' : 'Leave this channel?';
      if (window.confirm(confirm)) action(endpoint, 'DELETE', {}, onExit);
    }}>{channel.isOwner ? 'Delete channel' : 'Leave channel'}</button></div>
    {code && <label>Invite code (valid for 24 hours)<input readOnly value={code} onFocus={event => event.currentTarget.select()} /></label>}
    {channel.isOwner && <details>
      <summary>Manage members</summary>
      {!snapshot?.members?.length && <p className="muted">No other members yet.</p>}
      {snapshot?.members?.map(member => <div className="breakout-guest" key={member.id}>{member.name}
        <button className="button small" disabled={busy} aria-label={'Remove ' + member.name} onClick={() => {
          if (window.confirm('Remove ' + member.name + ' and invalidate the current invite code?')) {
            action(endpoint + '/members/' + member.id, 'DELETE', {}, () => { setCode(''); setRevision(value => value + 1); });
          }
        }}>Remove</button>
      </div>)}
    </details>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="team-messages" role="log" aria-label="Channel messages">
      {!snapshot && <p role="status">Loading messages…</p>}
      {snapshot?.messages.length === 0 && <p className="muted">No messages yet.</p>}
      {snapshot?.messages.map(message => <article key={message.id}>
        <p><strong>{message.name}</strong> <time dateTime={new Date(message.sentAt).toISOString()}>{time.format(message.sentAt)}</time></p>
        <p>{message.text}</p>
      </article>)}
    </div>
    <form className="form" onSubmit={post}>
      <label>Message<textarea rows={2} maxLength={2000} value={text} onChange={event => setText(event.target.value)} /></label>
      <div><button className="button primary" disabled={busy || !snapshot || !text.trim()}>Send message</button></div>
    </form>
  </section>;
}
