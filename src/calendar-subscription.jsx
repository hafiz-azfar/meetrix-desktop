import React, { useEffect, useState } from 'react';
import { Dialog } from './ui.jsx';

const path = '/workspace/calendar-feed';

export function CalendarSubscription({ api, close }) {
  const [status, setStatus] = useState(null);
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const request = new AbortController();
    api(path, { signal: request.signal }).then(setStatus).catch(failure => {
      if (!request.signal.aborted) setError(failure.message);
    });
    return () => request.abort();
  }, [api]);

  async function change(method) {
    setPending(true);
    setError('');
    setMessage('');
    try {
      const result = await api(path, { method, body: {} });
      setUrl(result.url ?? '');
      setStatus(previous => ({ ...previous, active: method === 'POST' }));
      setMessage(method === 'POST' ? 'Calendar link created.' : 'The calendar link was revoked.');
    } catch (failure) { setError(failure.message); }
    finally { setPending(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(url); setMessage('Calendar link copied.'); }
    catch { setError('Could not copy automatically. Select the link and copy it.'); }
  }

  return <Dialog title="Calendar subscription" close={() => { if (!pending) close(); }}>
    <div className="form">
      {status?.available ? <>
        <p>Subscribe from your calendar app using a URL. Meetrix publishes your upcoming hosted meetings, and the calendar app controls how often it refreshes.</p>
        <p className="muted">Anyone with this link can see event titles and meeting links. Copy it now. Meetrix shows it once, and replacing it disables the previous link.</p>
        {url && <label>Private calendar URL<input readOnly value={url} onFocus={event => event.currentTarget.select()} /></label>}
        <div className="meeting-tool-actions">
          <button className="button primary" disabled={pending} onClick={() => {
            if (!status.active || window.confirm('Replace the calendar link? Existing subscriptions will need the new URL.')) change('POST');
          }}>{status.active ? 'Replace link' : 'Create private link'}</button>
          {url && <button className="button" onClick={copy}>Copy link</button>}
          {status.active && <button className="button danger" disabled={pending} onClick={() => {
            if (window.confirm('Revoke this calendar subscription link?')) change('DELETE');
          }}>Revoke link</button>}
        </div>
      </> : status && <p>Connect to a hosted HTTPS workspace to create a calendar feed. You can download calendar invitations for local meetings.</p>}
      {!status && !error && <p role="status">Checking calendar availability…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {message && <p role="status">{message}</p>}
    </div>
  </Dialog>;
}
