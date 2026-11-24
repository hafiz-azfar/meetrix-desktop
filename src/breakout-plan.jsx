import React, { useEffect, useState } from 'react';
import { Dialog } from './ui.jsx';

export function BreakoutPlan({ meeting, api, close, onSaved }) {
  const [names, setNames] = useState(null);
  const [emails, setEmails] = useState([]);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [selfSelect, setSelfSelect] = useState(false);
  const [minutes, setMinutes] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const path = '/meetings/' + meeting.id + '/breakout-plan';
  useEffect(() => {
    const controller = new AbortController();
    api(path, { signal: controller.signal }).then(({ plan }) => {
      if (controller.signal.aborted) return;
      setNames(plan?.names ?? ['Room 1', 'Room 2']);
      setEmails(plan?.names.map((_, room) => (plan.assignments ?? []).filter(item => item.room === room)
        .map(item => item.email).join('\n')) ?? []);
      setRosterOpen(Boolean(plan?.assignments?.length));
      setSelfSelect(plan?.selfSelect ?? false);
      setMinutes(plan?.durationMinutes ? String(plan.durationMinutes) : '');
      setSaved(Boolean(plan));
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    return () => controller.abort();
  }, [api, path, attempt]);

  async function save(plan) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(path, { method: 'PATCH', body: { plan } });
      onSaved(Boolean(plan));
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  const unique = names && new Set(names.map(name => name.trim().toLowerCase())).size === names.length;
  const assignments = emails.flatMap((value, room) => value.split(/[\s,;]+/).filter(Boolean).map(email => ({ email: email.toLowerCase(), room })));
  const rosterError = assignments.length > 99 ? 'Use up to 99 participant email addresses.' :
    new Set(assignments.map(item => item.email)).size !== assignments.length ? 'Assign each email address to only one room.' :
      assignments.some(item => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(item.email) || item.email.length > 254)
        ? 'Check the email addresses in the participant lists.' : '';
  return <Dialog title="Prepare breakout rooms" close={() => { if (!busy) close(); }}>
    {!names && !error && <p role="status">Loading the breakout plan…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {!names && error && <button className="button" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Reload plan</button>}
    {names && <form className="form" onSubmit={event => {
      event.preventDefault();
      if (unique && !rosterError) save({ names, selfSelect, durationMinutes: minutes ? Number(minutes) : null, assignments });
    }}>
      <p className="muted">Save rooms for this occurrence. Open the prepared rooms from Breakouts during the call.</p>
      {names.map((name, index) => <div className="breakout-name" key={index}>
        <label>Room {index + 1} name<input value={name} maxLength={40} required disabled={busy} onChange={event => {
          const value = event.target.value;
          setNames(previous => previous.map((item, position) => position === index ? value : item));
        }} /></label>
        {names.length > 1 && <button className="button small" type="button" disabled={busy}
          onClick={() => {
            setNames(previous => previous.filter((_, position) => position !== index));
            setEmails(previous => previous.filter((_, position) => position !== index));
          }}
          aria-label={'Remove room ' + (index + 1)}>Remove</button>}
      </div>)}
      {!unique && <p className="error" role="alert">Use a different name for each room.</p>}
      <div><button className="button small" type="button" disabled={busy || names.length === 8}
        onClick={() => {
          setNames(previous => [...previous, '']);
          setEmails(previous => [...names.map((_, room) => previous[room] ?? ''), '']);
        }}>Add room</button></div>
      <details open={rosterOpen} onToggle={event => setRosterOpen(event.currentTarget.open)}>
        <summary>Pre-assign participants{assignments.length ? ' (' + assignments.length + ')' : ''}</summary>
        <div className="form">
          <p className="muted">Use the email address each participant has verified with their sign-in account. Put one address per line. Participants still need normal meeting admission.</p>
          {names.map((name, index) => <label key={index}>{name.trim() || 'Room ' + (index + 1)} participant emails
            <textarea rows={2} value={emails[index] ?? ''} disabled={busy} maxLength={26000}
              aria-label={'Room ' + (index + 1) + ' participant emails'} onChange={event => {
                const value = event.target.value;
                setEmails(previous => names.map((_, room) => index === room ? value : previous[room] ?? ''));
              }} />
          </label>)}
          {rosterError && <p className="error" role="alert">{rosterError}</p>}
        </div>
      </details>
      <label className="check"><input type="checkbox" checked={selfSelect} disabled={busy}
        onChange={event => setSelfSelect(event.target.checked)} /> Let attendees choose their room</label>
      <label>Close automatically after (minutes)<input type="number" value={minutes} min={1} max={120}
        placeholder="No time limit" onChange={event => setMinutes(event.target.value)} disabled={busy} /></label>
      <div className="dialog-actions">
        {saved && <button className="button danger" type="button" disabled={busy} onClick={() => {
          if (window.confirm('Remove the scheduled breakout plan?')) save(null);
        }}>Remove plan</button>}
        <button className="button primary" disabled={busy || !unique || Boolean(rosterError) || names.some(name => !name.trim())}>Save breakout plan</button>
      </div>
    </form>}
  </Dialog>;
}
