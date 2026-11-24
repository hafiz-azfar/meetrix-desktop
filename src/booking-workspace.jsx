import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Link, Plus, X } from 'lucide-react';
import { apiFor, calendarInvite, invitation } from './api.js';
import { Dialog, Logo } from './ui.jsx';

const localTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const urlFor = id => new URL('/book?b=' + id, location.origin).href;

export function BookingWorkspace({ api, name, local, onChanged }) {
  const [pages, setPages] = useState(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState('');
  const path = '/workspace/bookings';

  useEffect(() => {
    const controller = new AbortController();
    api(path, { signal: controller.signal }).then(setPages).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    return () => controller.abort();
  }, [api, revision]);

  async function copy(id) {
    try { await navigator.clipboard.writeText(urlFor(id)); setNotice('Booking link copied.'); }
    catch { setNotice(urlFor(id)); }
  }
  async function disable(page) {
    if (!window.confirm('Unpublish this booking page? Existing meeting reservations stay scheduled.')) return;
    setBusy(page.id);
    setError('');
    try {
      await api(path + '/' + page.id, { method: 'DELETE', body: {} });
      setPages(previous => previous.filter(item => item.id !== page.id));
      setNotice('Booking page unpublished.');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }
  return <>
    <div className="page-head"><h1>Booking pages</h1><button className="button primary" onClick={() => setCreating(true)}><Plus size={17} /> New booking page</button></div>
    {local && <p className="muted">This workspace is on your computer. To share booking links over the internet, connect to a hosted Meetrix workspace.</p>}
    {error && <div className="notice"><p role="alert">{error}</p>
      <button className="button small" onClick={() => { setError(''); setRevision(value => value + 1); }}>Refresh</button></div>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="meeting-list" aria-label="Published booking pages">
      {!pages && !error && <p className="empty" role="status">Loading booking pages…</p>}
      {pages?.length === 0 && <p className="empty">No booking pages yet.</p>}
      {pages?.map(page => <article className="booking-row" key={page.id}>
        <h2>{page.title}</h2>
        <p className="muted">{page.duration} minutes · {page.slots.filter(slot => slot.meeting).length} reserved</p>
        <div className="meeting-tool-actions">
          <button className="button small" onClick={() => copy(page.id)}><Link size={15} /> Copy link</button>
          <button className="button small" disabled={busy === page.id} onClick={() => disable(page)}>Unpublish</button>
        </div>
        <details><summary>View times</summary><ul>{page.slots.map(slot => <li key={slot.id}>
          {localTime.format(slot.startAt)}{slot.guestName ? ' · ' + slot.guestName : ''}
        </li>)}</ul></details>
      </article>)}
    </section>
    {creating && <BookingForm {...{ api, name }} close={() => setCreating(false)} published={() => {
      setCreating(false);
      setNotice('Booking page published.');
      setRevision(value => value + 1);
      onChanged();
    }} />}
  </>;
}

function BookingForm({ api, name, close, published }) {
  const [slots, setSlots] = useState([{ id: crypto.randomUUID(), value: '' }]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    const details = new FormData(event.currentTarget);
    setPending(true);
    setError('');
    try {
      await api('/workspace/bookings', { method: 'POST', body: {
        title: details.get('title'), ownerName: name, duration: Number(details.get('duration')),
        slots: slots.map(slot => new Date(slot.value).toISOString()),
      } });
      published();
    } catch (failure) { setError(failure.message); }
    finally { setPending(false); }
  }
  return <Dialog title="New booking page" close={() => { if (!pending) close(); }}>
    <form className="form" onSubmit={submit}>
      <label>Meeting title<input name="title" maxLength={100} autoFocus required /></label>
      <label>Duration<select name="duration" defaultValue="30">
        {[15, 30, 45, 60].map(minutes => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
      </select></label>
      <p className="muted">Enter available start times in {timezone}.</p>
      {slots.map(({ id, value }, index) => <div key={id} className="booking-time">
        <label>{'Start time ' + (index + 1)}<input type="datetime-local" value={value} required onChange={event =>
          setSlots(previous => previous.map(slot => slot.id === id ? { ...slot, value: event.target.value } : slot))} /></label>
        {slots.length > 1 && <button className="icon-button" type="button" aria-label={'Remove start time ' + (index + 1)}
          onClick={() => setSlots(previous => previous.filter(slot => slot.id !== id))}><X size={17} /></button>}
      </div>)}
      <div><button className="button small" type="button" disabled={slots.length >= 20}
        onClick={() => setSlots(previous => [...previous, { id: crypto.randomUUID(), value: '' }])}><Plus size={15} /> Add time</button></div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button primary" disabled={pending}>{pending ? 'Publishing…' : 'Publish booking page'}</button></div>
    </form>
  </Dialog>;
}

export function PublicBooking() {
  const api = useMemo(apiFor, []);
  const id = new URLSearchParams(location.search).get('b') || '';
  const [page, setPage] = useState(null);
  const [slot, setSlot] = useState('');
  const [booking, setBooking] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const valid = /^[A-Za-z0-9_-]{16}$/.test(id);
  const endpoint = '/bookings/' + id;
  useEffect(() => {
    if (!valid) return;
    const request = new AbortController();
    api(endpoint, { signal: request.signal }).then(setPage).catch(failure => {
      if (!request.signal.aborted) { setPage(null); setError(failure.message); }
    });
    return () => request.abort();
  }, [api, endpoint, revision, valid]);
  async function reserve(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError('');
    try { setBooking(await api(endpoint, { method: 'POST', body: { slot, name: form.get('name') } })); }
    catch (failure) {
      setError(failure.message);
      setSlot('');
      if ([404, 409].includes(failure.status)) setRevision(value => value + 1);
    }
    finally { setPending(false); }
  }

  return <main className="login">
    <section className="login-window booking-card" aria-label="Meeting booking">
      <header className="login-header"><Logo /></header>
      <div className="login-actions">
        {booking ? <div className="sign-in-card form">
          <h1>You're booked</h1><p>{booking.title} · {localTime.format(booking.startAt)}</p>
          <p className="muted">Keep the link or save the calendar invitation. The host will admit you from the waiting room.</p>
          <div className="meeting-tool-actions">
            <a className="button primary" href={invitation(booking.id)}>Open meeting link</a>
            <button className="button" onClick={() => calendarInvite(booking)}><CalendarDays size={17} /> Download calendar invite</button>
          </div>
        </div> : <div className="sign-in-card">
          <h1>{page?.title ?? 'Book a meeting'}</h1>
          {page && <p className="muted">With {page.ownerName} · {page.duration} minutes · {timezone}</p>}
          {!valid && <p className="error" role="alert">This booking page is unavailable.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          {valid && !page && !error && <p role="status">Loading available times…</p>}
          {page?.slots.length === 0 && <p>No available times.</p>}
          {!!page?.slots.length && <form className="form" onSubmit={reserve}>
            <label>Available time<select value={slot} onChange={event => setSlot(event.target.value)} required>
              <option value="">Choose a time</option>
              {page.slots.map(time => <option key={time.id} value={time.id}>{localTime.format(time.startAt)}</option>)}
            </select></label>
            <label>Your name<input name="name" maxLength={60} autoComplete="name" required /></label>
            <button className="button primary" disabled={pending || !slot}>{pending ? 'Reserving…' : 'Reserve time'}</button>
          </form>}
        </div>}
      </div>
    </section>
  </main>;
}
