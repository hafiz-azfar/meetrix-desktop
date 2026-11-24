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

export function CalendarMeetingSync({ api, meeting, onChanged, provider = 'google-calendar' }) {
  const [state, setState] = useState(null);
  const [pending, setPending] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const label = provider === 'outlook' ? 'Outlook Calendar' : 'Google Calendar';
  const conflict = state?.automatic?.status === 'conflict';
  const endpoint = '/meetings/' + meeting.id + '/' + provider;
  useEffect(() => {
    const cancel = new AbortController();
    function load() {
      api(endpoint, { signal: cancel.signal }).then(setState).catch(failure => {
        if (!cancel.signal.aborted) setError(failure.message);
      });
    }
    load();
    const timer = setInterval(load, 30000);
    return () => { cancel.abort(); clearInterval(timer); };
  }, [api, endpoint]);
  async function sync(direction) {
    if (direction === 'pull' && !window.confirm('Apply the ' + label + ' title and time to this meeting?')) return;
    if (direction === 'keep-local' &&
        !window.confirm('Replace the current ' + label + ' title and time with the Meetrix version?')) return;
    setPending(true);
    setText('');
    setError('');
    try {
      await api(endpoint, { method: 'POST', body: { direction } });
      setState(await api(endpoint));
      setText(direction === 'pull' ? 'Meeting updated from ' + label + '.' : label + ' event saved.');
      onChanged();
    } catch (failure) { setError(failure.message); }
    finally { setPending(false); }
  }
  async function automatic(enabled) {
    setPending(true);
    setError('');
    setText('');
    try {
      const result = await api(endpoint + '/automatic', { method: 'POST', body: { enabled } });
      setState(previous => ({ ...previous, automatic: result.automatic }));
    } catch (failure) { setError(failure.message); }
    finally { setPending(false); }
  }
  return <section className="form" aria-label={label + ' sync'}>
    {state && <strong>{label}</strong>}
    {state?.connected ? <><div className="meeting-tool-actions">
      <button className="button small" disabled={pending} onClick={() => sync(conflict ? 'keep-local' : 'push')}>
        {conflict ? 'Keep Meetrix version' : state.linked ? 'Push Meetrix changes' : 'Publish to ' + label}</button>
      {state.linked && <button className="button small" disabled={pending} onClick={() => sync('pull')}>Pull {provider === 'outlook' ? 'Outlook' : 'Google'} changes</button>}
    </div>
      {state.linked && <label className="check"><input type="checkbox" checked={!!state.automatic?.enabled}
        disabled={pending} onChange={event => automatic(event.target.checked)} /> Automatically sync linked changes</label>}
      {conflict && <p role="status" className="muted">Sync paused. Review the event and choose which version to keep.</p>}
      {state.automatic?.status === 'unavailable' && <p role="status" className="muted">The provider is unavailable. Meetrix will retry.</p>}
    </> : state && <p className="muted">Connect {label} from the Meetings page.</p>}
    {text && <p role="status">{text}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
