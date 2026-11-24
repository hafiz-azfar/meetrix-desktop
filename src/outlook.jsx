import React, { useEffect, useState } from 'react';
import { Mail, Plus } from 'lucide-react';
import { Dialog } from './ui.jsx';

const root = '/workspace/outlook';
const mail = root + '/mail';
const mailTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function OutlookConnection({ api, capability, close }) {
  const label = capability === 'mail' ? 'Outlook Mail' : 'Outlook Calendar';
  const [status, setStatus] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const cancel = new AbortController();
    const url = new URL(location.href);
    const result = url.searchParams.get('outlook');
    if (result) {
      url.searchParams.delete('outlook');
      url.searchParams.delete('outlookApp');
      history.replaceState(null, '', url);
    }
    if (result === 'failed') setError('The Outlook sign-in did not complete.');
    const approved = result === 'complete';
    api(root + (approved ? '/complete' : ''), {
      signal: cancel.signal, ...(approved ? { method: 'POST', body: {} } : {}),
    }).then(setStatus).catch(failure => { if (!cancel.signal.aborted) setError(failure.message); });
    return () => cancel.abort();
  }, [api]);

  async function connect() {
    setPending(true);
    setError('');
    try {
      const target = new URL((await api(root + '/start', { method: 'POST', body: { capability } })).url);
      if (target.origin !== 'https://login.microsoftonline.com' || !/^\/[A-Za-z0-9-]+\/oauth2\/v2\.0\/authorize$/.test(target.pathname)) {
        throw new Error('The Outlook authorization link was invalid.');
      }
      location.assign(target.href);
    } catch (failure) { setError(failure.message); setPending(false); }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect ' + label + '? Existing content stays in Outlook.')) return;
    setPending(true);
    setError('');
    try { setStatus(await api(root, { method: 'DELETE', body: { capability } })); }
    catch (failure) { setError(failure.message); }
    finally { setPending(false); }
  }
  return <Dialog title={label} close={() => { if (!pending) close(); }}>
    <div className="form">
      <p>{capability === 'mail' ? 'Read recent mail and send plain-text messages from your Outlook mailbox.'
        : 'Publish selected meetings to your Outlook calendar and pull edits back into Meetrix.'}</p>
      {status?.[capability] ? <><p role="status">{label} connected.</p><div>
        <button className="button danger" disabled={pending} onClick={disconnect}>Disconnect {label}</button>
      </div></> : window.meetrixDesktop ? <p>Connect in a web browser by signing into this hosted workspace.</p>
        : <div><button className="button primary" disabled={pending} onClick={connect}>Connect {label}</button></div>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  </Dialog>;
}

export function OutlookMail({ api, connect }) {
  const [ready, setReady] = useState(null);
  const [folder, setFolder] = useState('inbox');
  const [items, setItems] = useState(null);
  const [message, setMessage] = useState(null);
  const [selected, setSelected] = useState('');
  const [compose, setCompose] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const cancel = new AbortController();
    api(root, { signal: cancel.signal }).then(result => setReady(result.mail))
      .catch(failure => { if (!cancel.signal.aborted) setError(failure.message); });
    return () => cancel.abort();
  }, [api]);
  useEffect(() => {
    if (!ready) return;
    const cancel = new AbortController();
    setItems(null);
    api(mail + '?folder=' + folder, { signal: cancel.signal }).then(setItems)
      .catch(failure => { if (!cancel.signal.aborted) setError(failure.message); });
    return () => cancel.abort();
  }, [api, folder, ready, refresh]);
  useEffect(() => {
    if (!selected) return;
    const cancel = new AbortController();
    api(mail + '/' + encodeURIComponent(selected), { signal: cancel.signal }).then(setMessage)
      .catch(failure => { if (!cancel.signal.aborted) { setError(failure.message); setSelected(''); } });
    return () => cancel.abort();
  }, [api, selected]);
  const displayDate = timestamp => Number.isFinite(Date.parse(timestamp)) ? mailTime.format(new Date(timestamp)) : '';
  const displayPerson = person => person.name || person.address || 'Unknown sender';

  return <>
    <div className="page-head"><h1>Mail</h1><div className="meeting-tool-actions">
      <button className="button" onClick={connect}>Outlook Mail settings</button>
      {ready && <button className="button primary" onClick={() => { setCompose(true); setNotice(''); }}><Plus size={17} /> New message</button>}
    </div></div>
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {ready === false && <p className="empty">Connect your Outlook Mail account to see messages here.</p>}
    {ready === null && !error && <p role="status">Checking the Outlook connection…</p>}
    {ready && <section className="meeting-list" aria-label="Outlook messages">
      <div className="section-header">
        <div className="segment" aria-label="Mail folders">{[['inbox', 'Inbox'], ['sentitems', 'Sent']].map(([key, label]) =>
          <button type="button" key={key} aria-pressed={folder === key} onClick={() => { setFolder(key); setError(''); }}>{label}</button>,
        )}</div>
        <button className="button small" onClick={() => { setError(''); setRefresh(value => value + 1); }}>Refresh</button>
      </div>
      {!items && !error && <p className="empty" role="status">Loading messages…</p>}
      {items?.length === 0 && <p className="empty">No messages.</p>}
      {items?.map(item => <article key={item.id} className="meeting-row mail-row">
        <div className="meeting-symbol" aria-hidden="true"><Mail size={17} /></div>
        <div className="meeting-info"><strong>{item.subject || '(No subject)'}</strong>
          <span>{displayPerson(folder === 'inbox' ? item.from : item.to[0] || {})} · {displayDate(item.at)}</span>
          <span>{item.preview}</span>
        </div>
        <button className="button small" aria-label={'Read ' + (item.subject || 'message')} onClick={() => {
          setError(''); setMessage(null); setSelected(item.id);
        }}>Read</button>
      </article>)}
    </section>}
    {selected && <Dialog title={message?.subject || 'Outlook message'} close={() => { setMessage(null); setSelected(''); }}>
      {message ? <><p className="muted">From {displayPerson(message.from)} · {displayDate(message.at)}</p>
        <pre className="mail-text">{message.text}</pre></> : <p role="status">Opening message…</p>}
    </Dialog>}
    {compose && <ComposeMail api={api} close={() => setCompose(false)} queued={() => {
      setCompose(false);
      setNotice('Outlook accepted your message for delivery.');
      setRefresh(value => value + 1);
    }} />}
  </>;
}

function ComposeMail({ api, close, queued }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function send(event) {
    event.preventDefault();
    if (pending) return;
    const values = new FormData(event.currentTarget);
    const to = values.get('to').split(',').map(value => value.trim()).filter(Boolean);
    if (!to.length || to.length > 10) { setError('Enter between one and ten recipients.'); return; }
    if (!window.confirm('Send this message to ' + to.join(', ') + '?')) return;
    setPending(true);
    setError('');
    try {
      await api(mail, { method: 'POST', body: { to, subject: values.get('subject'), text: values.get('text') } });
      queued();
    } catch (failure) { setError(failure.message); }
    finally { setPending(false); }
  }
  return <Dialog title="New message" close={() => { if (!pending) close(); }}>
    <form className="form" onSubmit={send}>
      <label>To<input type="email" multiple name="to" autoFocus maxLength={2600} placeholder="One or more email addresses" required /></label>
      <label>Subject<input name="subject" maxLength={200} required /></label>
      <label>Message<textarea name="text" rows={8} maxLength={12000} required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button" disabled={pending} onClick={close}>Close</button>
        <button className="button primary" disabled={pending}>{pending ? 'Sending…' : 'Send email'}</button>
      </div>
    </form>
  </Dialog>;
}
