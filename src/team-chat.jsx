import React, { useEffect, useRef, useState } from 'react';
import { Dialog } from './ui.jsx';

const path = '/workspace/channels';
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const acceptedFiles = '.pdf,.png,.jpg,.jpeg,.txt,.md,.csv';

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
  const [threadId, setThreadId] = useState(null);
  const [thread, setThread] = useState(null);
  const [threadError, setThreadError] = useState('');
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
          setThreadId(null);
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

  useEffect(() => {
    if (!threadId) return;
    const request = new AbortController();
    let timer;
    async function refresh() {
      try {
        const data = await api(log + '/' + threadId + '/replies', { signal: request.signal });
        if (!request.signal.aborted) { setThread(data); setThreadError(''); }
      } catch (failure) {
        if (request.signal.aborted) return;
        if (failure.status === 404) setThread(null);
        setThreadError(failure.message);
        if (failure.status === 404) return;
      }
      if (!request.signal.aborted) timer = setTimeout(refresh, 4000);
    }
    refresh();
    return () => { request.abort(); clearTimeout(timer); };
  }, [api, log, revision, threadId]);

  async function action(url, method, body, done) {
    setBusy(true);
    setError('');
    try { done(await api(url, { method, body })); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  async function post(text, file, replyTo) {
    const body = { text, ...(replyTo ? { replyTo } : {}) };
    const message = file
      ? await api(endpoint + '/attachments', { method: 'POST', contentType: 'application/vnd.meetrix.attachment+json',
        body: { ...body, name: file.name, data: await fileBase64(file) } })
      : await api(log, { method: 'POST', body });
    if (!replyTo) {
      setSnapshot(previous => previous && { ...previous, messages: [...previous.messages.filter(item => item.id !== message.id), message] });
    }
    setRevision(value => value + 1);
  }
  function sharedMessage(message, children) {
    const canRemove = channel.isOwner || channel.membership === message.membership;
    function removeFile() {
      if (!window.confirm('Remove this file from the channel for everyone?')) return;
      action(endpoint + '/attachments/' + message.id, 'DELETE', {}, () => setRevision(value => value + 1));
    }
    return <ChatMessage key={message.id} message={message} endpoint={endpoint}
      removeFile={canRemove ? removeFile : undefined} disabled={busy}>{children}</ChatMessage>;
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
      {snapshot?.messages.map(message => sharedMessage(message,
        <button className="button small" type="button" onClick={() => {
          setThread(null); setThreadError(''); setThreadId(message.id);
        }}>{message.replyCount ? message.replyCount + (message.replyCount === 1 ? ' reply' : ' replies') : 'Reply'}</button>
      ))}
    </div>
    <ChatComposer disabled={busy || !snapshot} onPost={post} />
    {threadId && <Dialog title="Message thread" close={() => setThreadId(null)}>
      {threadError && <p className="error" role="alert">{threadError}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!thread && !threadError && <p role="status">Loading replies…</p>}
      {thread && <>
        {sharedMessage(thread.parent)}
        <div className="team-messages" role="log" aria-label="Thread replies">
          {!thread.replies.length && <p className="muted">No replies yet.</p>}
          {thread.replies.map(message => sharedMessage(message))}
        </div>
        <ChatComposer key={threadId} replyTo={threadId} disabled={Boolean(threadError)} onPost={post} />
      </>}
    </Dialog>}
  </section>;
}

function ChatMessage({ message, endpoint, removeFile, disabled, children }) {
  return <article className="team-message">
    <p><strong>{message.name}</strong> <time dateTime={new Date(message.sentAt).toISOString()}>{time.format(message.sentAt)}</time></p>
    {message.text && <p>{message.text}</p>}
    {!message.text && !message.attachmentName && <p className="muted">File removed.</p>}
    {message.attachmentName && <p>
      <a className="chat-file" href={'/api' + endpoint + '/attachments/' + message.id} download={message.attachmentName}>
        {message.attachmentName} ({Math.max(1, Math.ceil(message.attachmentSize / 1024))} KiB)
      </a>
      {removeFile && <button className="button small" type="button" disabled={disabled} onClick={removeFile}>Remove shared file</button>}
    </p>}
    {children}
  </article>;
}

function ChatComposer({ disabled, onPost, replyTo }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const fileInput = useRef(null);
  const blocked = disabled || sending;
  async function submit(event) {
    event.preventDefault();
    if (blocked || (!text.trim() && !file)) return;
    setSending(true);
    setError('');
    try {
      await onPost(text, file, replyTo);
      setText('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
    } catch (failure) { setError(failure.message); }
    finally { setSending(false); }
  }
  return <form className="form" onSubmit={submit}>
    <label>{replyTo ? 'Reply' : 'Message'}<textarea rows={2} maxLength={2000} value={text}
      disabled={blocked} onChange={event => setText(event.target.value)} /></label>
    <label>Attach a file <small>PDF, PNG, JPEG, TXT, MD, or CSV up to 1 MiB</small>
      <input type="file" accept={acceptedFiles} ref={fileInput} disabled={blocked} onChange={event => {
        const chosen = event.target.files[0];
        setError('');
        if (chosen && (!chosen.size || chosen.size > 1024 * 1024)) {
          setError('Choose a nonempty file up to 1 MiB.');
          event.target.value = '';
          setFile(null);
        } else setFile(chosen ?? null);
      }} />
    </label>
    {file && <div><button className="button small" type="button" disabled={blocked} onClick={() => {
      fileInput.current.value = ''; setFile(null); setError('');
    }}>Remove attachment</button></div>}
    {error && <p className="error" role="alert">{error}</p>}
    <div><button className="button primary" disabled={blocked || (!text.trim() && !file)}>
      {sending ? 'Sending…' : replyTo ? 'Send reply' : 'Send message'}
    </button></div>
  </form>;
}

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.onerror = () => reject(new Error('The selected file could not be read.'));
    reader.readAsDataURL(file);
  });
}
