import React, { useEffect, useState } from 'react';
import { calendarSeries } from './api.js';
import { localDateValue, shiftMeetingTimes } from './meeting-schedule.js';
import { Dialog } from './ui.jsx';

const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function SeriesManager({ meeting, api, close, onSaved }) {
  const [series, setSeries] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const path = '/meetings/' + meeting.id + '/series';

  useEffect(() => {
    const controller = new AbortController();
    api(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setSeries(data);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    return () => controller.abort();
  }, [api, path, attempt]);

  function reload() { setSeries(null); setError(''); setAttempt(value => value + 1); }

  if (series) return <SeriesForm series={series} meeting={meeting} api={api} path={path}
    close={close} reload={reload} onSaved={onSaved} />;
  return <Dialog title="Manage meeting series" close={close}>
    {error ? <><p className="error" role="alert">{error}</p><button className="button" onClick={reload}>Reload series</button></>
      : <p role="status">Loading upcoming occurrences…</p>}
  </Dialog>;
}

function SeriesForm({ series, meeting, api, path, close, reload, onSaved }) {
  const [scope, setScope] = useState('following');
  const selected = series.meetings.filter(item => scope === 'upcoming' || item.seriesIndex >= meeting.seriesIndex);
  const first = selected[0];
  const [title, setTitle] = useState(first?.title ?? meeting.title);
  const [duration, setDuration] = useState(String(first?.duration ?? meeting.duration));
  const [start, setStart] = useState(first ? localDateValue(first.startAt) : '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const dates = first && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start) ? shiftMeetingTimes(selected, start) : [];

  function changeScope(value) {
    setScope(value);
    const next = value === 'upcoming' ? series.meetings[0]
      : series.meetings.find(item => item.seriesIndex >= meeting.seriesIndex);
    setStart(next ? localDateValue(next.startAt) : '');
    setFailure(null);
  }

  async function save(action) {
    if (busy || !selected.length) return;
    if (action === 'cancel' && !window.confirm('Cancel ' + selected.length +
      (selected.length === 1 ? ' scheduled meeting' : ' scheduled meetings') +
      ' and remove any linked Google or Outlook Calendar events?')) return;
    setBusy(true);
    setFailure(null);
    try {
      const changes = action === 'reschedule' ? {
        title, duration: Number(duration), startTimes: dates.map(date => date.toISOString()),
      } : { removeLinkedEvents: true };
      const result = await api(path, { method: 'PATCH', body: { action, scope, revision: series.revision, ...changes } });
      onSaved(result, action);
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  }

  return <Dialog title="Manage meeting series" close={() => { if (!busy) close(); }}>
    <form className="form" onSubmit={event => { event.preventDefault(); save('reschedule'); }}>
      <p className="muted">{series.meetings.length} of {series.total} occurrences are scheduled and unopened.</p>
      <label>Apply to<select value={scope} disabled={busy} onChange={event => changeScope(event.target.value)}>
        <option value="following">This and following occurrences</option>
        <option value="upcoming">All upcoming occurrences</option>
      </select></label>
      {first ? <>
        <label>Meeting name<input value={title} onChange={event => setTitle(event.target.value)} maxLength={100} required disabled={busy} /></label>
        <label>Duration (minutes)<input type="number" value={duration} onChange={event => setDuration(event.target.value)}
          min={15} max={1800} required disabled={busy} /></label>
        <label>First selected start time<input type="datetime-local" value={start} onChange={event => setStart(event.target.value)}
          required disabled={busy} /></label>
        <p className="muted">Changing this time shifts the selected occurrences by the same amount on your calendar.</p>
        {dates.length > 0 && <details><summary>Preview {dates.length} selected {dates.length === 1 ? 'time' : 'times'}</summary><ol>
          {dates.map((date, index) => <li key={selected[index].id}>{dateLabel.format(date)}</li>)}
        </ol></details>}
      </> : <p role="status">There are no unopened occurrences in this selection.</p>}
      {failure && <p className="error" role="alert">{failure.message}</p>}
      {failure?.status === 409 && <div><button type="button" className="button" disabled={busy} onClick={reload}>Reload series</button></div>}
      <div className="dialog-actions">
        {series.meetings.length > 0 && <button type="button" className="button" disabled={busy}
          onClick={() => calendarSeries(series.meetings)}>Export upcoming calendar</button>}
        <button type="button" className="button danger" disabled={busy || !first} onClick={() => save('cancel')}>Cancel selected meetings</button>
        <button className="button primary" disabled={busy || !first || !dates.length}>{busy ? 'Saving…' : 'Save series changes'}</button>
      </div>
    </form>
  </Dialog>;
}
