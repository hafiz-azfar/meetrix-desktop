import React, { useEffect, useState } from 'react';
import { Dialog } from './ui.jsx';

const path = '/workspace/google-calendar';

export function GoogleCalendarConnection({ api, close }) {
  const [status, setStatus] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const cancel = new AbortController();
    const url = new URL(location.href);
    const callback = url.searchParams.get('googleCalendar');
    if (callback) {
      url.searchParams.delete('googleCalendar');
      history.replaceState(null, '', url);
    }
    async function load() {
      try {
        if (callback === 'failed') setError('Google Calendar did not authorize the connection.');
        const options = callback === 'complete' ? { method: 'POST', body: {} } : {};
        const state = await api(path + (callback === 'complete' ? '/complete' : ''), { ...options, signal: cancel.signal });
        if (!cancel.signal.aborted) setStatus(state);
      } catch (failure) { if (!cancel.signal.aborted) setError(failure.message); }
    }
    void load();
    return () => cancel.abort();
  }, [api]);

  async function connect() {
    setPending(true);
    setError('');
    try {
      const { url } = await api(path + '/start', { method: 'POST', body: {} });
      const target = new URL(url);
      if (target.origin !== 'https://accounts.google.com' || target.pathname !== '/o/oauth2/v2/auth') {
        throw new Error('The Google authorization address was invalid.');
      }
      location.assign(target.href);
    } catch (failure) { setError(failure.message); setPending(false); }
  }
  async function disconnect() {
    if (!window.confirm('Disconnect Google Calendar? Events already published stay in Google Calendar.')) return;
    setPending(true);
    setError('');
    try { setStatus(await api(path, { method: 'DELETE', body: {} })); }
    catch (failure) { setError(failure.message); }
    finally { setPending(false); }
  }
  return <Dialog title="Google Calendar" close={() => { if (!pending) close(); }}>
    <div className="form">
      <p>Publish selected meetings to your Google calendar. After editing a linked event, choose Pull Google changes from the meeting’s menu.</p>
      {status?.connected ? <><p role="status">Google Calendar connected.</p><div>
        <button className="button danger" disabled={pending} onClick={disconnect}>Disconnect Google Calendar</button>
      </div></> : window.meetrixDesktop ? <p>Connect in the browser by signing in to this hosted workspace.</p>
        : <div><button className="button primary" disabled={pending} onClick={connect}>Connect Google Calendar</button></div>}
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  </Dialog>;
}

export function GoogleMeetingSync({ api, meeting, onChanged }) {
  const [state, setState] = useState(null);
  const [pending, setPending] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const endpoint = '/meetings/' + meeting.id + '/google-calendar';
  useEffect(() => {
    const cancel = new AbortController();
    api(endpoint, { signal: cancel.signal }).then(setState).catch(failure => {
      if (!cancel.signal.aborted) setError(failure.message);
    });
    return () => cancel.abort();
  }, [api, endpoint]);
  async function sync(direction) {
    if (direction === 'pull' && !window.confirm('Apply the Google event’s title and time to this meeting?')) return;
    setPending(true);
    setText('');
    setError('');
    try {
      await api(endpoint, { method: 'POST', body: { direction } });
      setState({ linked: true, connected: true });
      setText(direction === 'pull' ? 'Meeting updated from Google Calendar.' : 'Google Calendar event saved.');
      onChanged();
    } catch (failure) { setError(failure.message); }
    finally { setPending(false); }
  }
  return <section className="form" aria-label="Google Calendar sync">
    {state?.connected ? <div className="meeting-tool-actions">
      <button className="button small" disabled={pending} onClick={() => sync('push')}>
        {state.linked ? 'Push Meetrix changes' : 'Publish to Google Calendar'}</button>
      {state.linked && <button className="button small" disabled={pending} onClick={() => sync('pull')}>Pull Google changes</button>}
    </div> : state && <p className="muted">Connect Google Calendar from the Meetings page.</p>}
    {text && <p role="status">{text}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
