import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, CalendarDays, ChevronRight,
  Clipboard, Clock3, DoorOpen, Ellipsis, FileText, House, LockKeyhole, Mic, Plus, Settings,
  Video, X,
} from 'lucide-react';
import { apiFor, calendarInvite, calendarSeries, invitation, parseInvitation } from './api.js';
import { maxOccurrences, meetingOccurrences } from './meeting-schedule.js';
import { generateRoomKey, validRoomKey } from './encryption.js';
import { Logo, Dialog } from './ui.jsx';
import { Notes } from './notes.jsx';
import { CameraPreview, DeviceFields } from './media-devices.jsx';
import { CameraBackgroundFields } from './camera-background.jsx';
import { WorkspaceSettings } from './settings.jsx';
import { CloudRecordingLibrary } from './cloud-recording.jsx';

const Conference = lazy(() => import('./conference.jsx').then(module => ({ default: module.Conference })));
const panels = [
  { id: 'home', title: 'Home', icon: House },
  { id: 'meetings', title: 'Meetings', icon: CalendarDays },
  { id: 'settings', title: 'Settings', icon: Settings },
];
const meetingActions = [
  { id: 'start', title: 'New meeting', description: 'Start a video call now', icon: Video },
  { id: 'join', title: 'Join a meeting', description: 'Enter a link or code', icon: DoorOpen },
  { id: 'schedule', title: 'Schedule meeting', description: 'Add a call to your agenda', icon: CalendarDays },
];
const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const timeLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const occurrenceLabel = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const inviteCode = new URLSearchParams(location.search).get('m');

function localDateValue(time) {
  const local = new Date(time - new Date(time).getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function MeetingForm({ mode, meeting, api, name, close, onCreated }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [when, setWhen] = useState(() => meeting ? localDateValue(meeting.startAt) : '');
  const [repeat, setRepeat] = useState('once');
  const [count, setCount] = useState('4');
  const recurring = mode === 'schedule' && repeat !== 'once';
  let upcoming = [];
  let scheduleError = '';
  if (recurring && when) {
    try { upcoming = meetingOccurrences(when, repeat, Number(count)); }
    catch (failure) { scheduleError = failure.message; }
  }
  const clockAdjusted = upcoming.some(time => localDateValue(time).slice(11) !== when.slice(11));

  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setWorking(true);
    setError('');
    try {
      const scheduled = mode !== 'start';
      const details = { title: form.get('title'), duration: Number(form.get('duration') || 60) };
      const times = scheduled ? meetingOccurrences(when, repeat, Number(count)).map(time => time.toISOString()) : [];
      if (scheduled) details.startAt = times[0];
      if (mode === 'edit') {
        if (when === localDateValue(meeting.startAt)) details.startAt = new Date(meeting.startAt).toISOString();
        onCreated(await api('/meetings/' + meeting.id, { method: 'PATCH', body: details }), true);
        return;
      }
      const created = await api('/meetings', { method: 'POST', body: {
        ...details, name, additionalStarts: times.slice(1), lobby: form.get('lobby') === 'on', allowGuests: form.get('allowGuests') === 'on',
        encrypted: form.get('encrypted') === 'on',
        ...(form.get('passcode') ? { passcode: form.get('passcode') } : {}),
      } });
      onCreated(created, scheduled);
    } catch (failure) { setError(failure.message); }
    finally { setWorking(false); }
  }
  return <Dialog title={mode === 'edit' ? 'Reschedule meeting' : mode === 'schedule' ? 'Schedule a meeting' : 'Create a room'} close={close}>
    <form className="form" onSubmit={submit}>
      <label>Meeting name<input name="title" required autoFocus maxLength={100} defaultValue={meeting?.title} placeholder="Project check-in" /></label>
      {mode !== 'start' && <>
        <label>Start time ({Intl.DateTimeFormat().resolvedOptions().timeZone}) <input type="datetime-local" name="when" value={when} onChange={event => setWhen(event.target.value)} required /></label>
        <label>Calendar duration<select name="duration" defaultValue={meeting?.duration || 60}>{[15, 30, 45, 60, 90, 120, 180, 1800].map(minutes => <option key={minutes} value={minutes}>{minutes < 120 ? minutes + ' minutes' : minutes / 60 + ' hours'}</option>)}</select></label>
      </>}
      {mode === 'schedule' && <label>Repeat<select aria-label="Repeat" value={repeat} onChange={event => setRepeat(event.target.value)}>
        <option value="once">One time</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option>
        <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
      </select></label>}
      {recurring && <>
        <label>Number of occurrences<input type="number" value={count} onChange={event => setCount(event.target.value)}
          min="2" max={maxOccurrences} required /></label>
        {!!upcoming.length && <details><summary>Preview {upcoming.length} meeting times</summary>
          <ol>{upcoming.map(time => <li key={time.toISOString()}>{occurrenceLabel.format(time)}</li>)}</ol>
        </details>}
        {repeat === 'monthly' && Number(when.slice(8, 10)) > 28 && <p className="muted">Shorter months use their last day.</p>}
        {clockAdjusted && <p className="muted">A clock change moves one or more start times. Check the preview.</p>}
      </>}
      {mode !== 'edit' && <><label><span>Passcode <span className="muted">(optional)</span></span><input name="passcode" type="password" autoComplete="new-password" minLength={8} maxLength={128} placeholder="At least 8 characters" /></label>
      <label className="check"><input type="checkbox" name="lobby" defaultChecked /><span><strong>Waiting room</strong><small>Admit each guest before they join.</small></span></label>
      <label className="check"><input type="checkbox" name="allowGuests" /><span><strong>Allow guests without an account</strong><small>The waiting room must be enabled.</small></span></label>
      <label className="check"><input type="checkbox" name="encrypted" /><span><strong>End-to-end encrypted room</strong><small>Share a separate room key with guests. Server-stored collaboration is disabled.</small></span></label></>}
      {(error || scheduleError) && <p className="error" role="alert">{error || scheduleError}</p>}
      <div className="dialog-actions"><button className="button" type="button" onClick={close}>Cancel</button><button className="button primary" disabled={working || Boolean(scheduleError)}>{working ? 'Saving…' : mode === 'edit' ? 'Save changes' : mode === 'schedule' ? 'Schedule' : 'Continue'}</button></div>
    </form>
  </Dialog>;
}

function JoinForm({ code, close, onJoin, guest = false }) {
  const [error, setError] = useState('');
  return <Dialog title="Join a meeting" close={close}>
    <form className="form" onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const name = guest ? form.get('name').trim() : undefined;
        if (guest && !name) throw new Error('Enter your display name.');
        onJoin({ id: parseInvitation(form.get('code')), passcode: form.get('passcode'), name });
      }
      catch (failure) { setError(failure.message); }
    }}>
      <label>Meeting link or code<input name="code" autoFocus={!guest || !code} required defaultValue={code} maxLength={300} /></label>
      {guest && <label>Display name<input name="name" autoFocus={Boolean(code)} required maxLength={60} autoComplete="name" /></label>}
      <label><span>Passcode <span className="muted">(if required)</span></span><input name="passcode" type="password" autoComplete="off" minLength={8} maxLength={128} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button" type="button" onClick={close}>Cancel</button><button className="button primary">Continue <ArrowRight size={16} /></button></div>
    </form>
  </Dialog>;
}

function Preflight({ target, prefs, updatePrefs, api, name, close, onConnected, guest = false }) {
  const [phase, setPhase] = useState('preview');
  const [needsKey, setNeedsKey] = useState(Boolean(target.encrypted));
  const [roomKey, setRoomKey] = useState('');
  const [keyCopied, setKeyCopied] = useState(false);
  const [failure, setFailure] = useState('');
  const [camera, setCamera] = useState(prefs.camera);
  const [microphone, setMicrophone] = useState(prefs.microphone);
  useEffect(() => {
    if (!['connecting', 'waiting', 'host-pending'].includes(phase)) return;
    let cancelled = false;
    let timer;
    async function connect() {
      try {
        const result = await api('/meetings/' + target.id + (guest ? '/guest' : '/connect'), {
          method: 'POST', body: { name, ...(guest ? { proof: target.proof } : {}), ...(validRoomKey(roomKey) ? { keyReady: true } : {}), ...(target.passcode ? { passcode: target.passcode } : {}) },
        });
        if (cancelled) return;
        if (result.state === 'ready') onConnected({ ...result, media: { camera, microphone }, ...(result.meeting.encrypted ? { roomKey } : {}) });
        else if (result.state === 'key-required') { setNeedsKey(true); setPhase('preview'); }
        else {
          setPhase(result.hostPresent ? 'waiting' : 'host-pending');
          timer = setTimeout(connect, 4500);
        }
      } catch (error) {
        if (!cancelled) { setFailure(error.message); setPhase('preview'); }
      }
    }
    if (phase === 'connecting') connect();
    else timer = setTimeout(connect, 4500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [phase, api, target, name, onConnected, roomKey, guest, camera, microphone]);
  const pending = phase !== 'preview';
  return <Dialog title={target.title || 'Check your setup'} close={close}>
    <CameraPreview enabled={camera && phase !== 'connecting'} deviceId={prefs.cameraId} mirror={prefs.mirrorCamera}
      background={prefs.background} backgroundImage={prefs.backgroundImage} />
    <div className="preflight-controls">
      <button className={'button' + (microphone ? ' selected' : '')} disabled={phase === 'connecting'}
        onClick={() => setMicrophone(!microphone)}><Mic size={17} /> Microphone {microphone ? 'on' : 'off'}</button>
      <button className={'button' + (camera ? ' selected' : '')} disabled={phase === 'connecting'}
        onClick={() => setCamera(!camera)}><Video size={17} /> Camera {camera ? 'on' : 'off'}</button>
    </div>
    <details className="preflight-devices"><summary>Audio and video devices</summary>
      <DeviceFields prefs={prefs} changeDevice={({ key }, value) => updatePrefs({ [key + 'Id']: value })} />
      <CameraBackgroundFields prefs={prefs} onChange={updatePrefs} />
    </details>
    {needsKey && <div className="key-box"><label htmlFor="room-key">Room encryption key</label><input id="room-key" type="password" autoComplete="off" value={roomKey} onChange={event => { setRoomKey(event.target.value.trim()); setKeyCopied(false); }} maxLength={43} disabled={pending} />
      {target.isHost ? <div className="preflight-controls"><button className="button" disabled={pending} onClick={() => { setRoomKey(generateRoomKey()); setKeyCopied(false); }}>Generate key</button><button className="button" disabled={!validRoomKey(roomKey)} onClick={async () => { try { await navigator.clipboard.writeText(roomKey); setKeyCopied(true); } catch { setFailure('Could not copy the key.'); } }}>{keyCopied ? 'Key copied' : 'Copy key'}</button></div> : <p className="muted">Ask the host for this key over a separate secure channel.</p>}
    </div>}
    {failure && <p role="alert" className="error">{failure}</p>}
    {pending && <p role="status" className="waiting"><span className="status-dot" />{phase === 'connecting' ? 'Connecting…' : phase === 'host-pending' ? 'Waiting for the host to start the meeting.' : 'The host will admit you from the waiting room.'}</p>}
    <div className="dialog-actions"><button className="button" onClick={close}>{pending ? 'Leave waiting room' : 'Back'}</button><button className="button primary" disabled={pending || (needsKey && !validRoomKey(roomKey))} onClick={() => { setFailure(''); setPhase('connecting'); }}>{target.isHost ? 'Enter room' : 'Join now'} <ArrowRight size={16} /></button></div>
  </Dialog>;
}

export function GuestMeeting({ code, onBack, prefs, updatePrefs }) {
  const api = useMemo(apiFor, []);
  const [target, setTarget] = useState(null);
  const [session, setSession] = useState(null);

  function enter(details) {
    const key = 'meetrix-guest-' + details.id;
    let proof = crypto.randomUUID().replaceAll('-', '');
    try {
      const saved = sessionStorage.getItem(key);
      if (/^[a-f0-9]{32}$/.test(saved ?? '')) proof = saved;
      sessionStorage.setItem(key, proof);
    } catch { /* The guest can still join for the lifetime of this page. */ }
    setTarget({ ...details, proof });
  }

  if (session) return <Suspense fallback={<div className="boot"><Logo /><p>Opening your room…</p></div>}>
    <Conference session={session} api={api} prefs={prefs} updatePrefs={updatePrefs} onLeave={onBack} />
  </Suspense>;
  return <main className="boot"><Logo />
    {target ? <Preflight guest target={target} api={api} name={target.name} prefs={prefs} updatePrefs={updatePrefs}
      close={() => setTarget(null)} onConnected={setSession} />
    : <JoinForm guest code={code} close={onBack} onJoin={enter} />}
  </main>;
}

export function Workspace({ config, user, accountControl, prefs, updatePrefs }) {
  const name = (user?.fullName || user?.username || user?.firstName || 'Participant').slice(0, 60);
  const api = useMemo(apiFor, []);
  const [page, setPage] = useState('home');
  const [filter, setFilter] = useState('upcoming');
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, updateNotice] = useState(null);
  const [modal, setModal] = useState(inviteCode ? 'join' : '');
  const [target, setTarget] = useState(null);
  const [editing, setEditing] = useState(null);
  const [archived, setArchived] = useState(null);
  const [session, setSession] = useState(null);
  function setNotice(message, calendar = []) { updateNotice(message ? { message, calendar } : null); }
  function refresh() {
    setLoading(true);
    api('/meetings').then(setMeetings).catch(error => setNotice(error.message)).finally(() => setLoading(false));
  }
  useEffect(refresh, [api]);
  function enter(meeting) { setModal(''); setTarget(meeting); }
  function created(meeting, scheduled) {
    setModal('');
    refresh();
    if (scheduled) {
      setPage('meetings'); setFilter('upcoming');
      if (meeting.scheduledCount > 1) setNotice(meeting.scheduledCount + ' meetings scheduled.', meeting.scheduledMeetings);
      else setNotice('Meeting saved. Copy its invite to share.');
    }
    else enter(meeting);
  }
  function leave() { setSession(null); setTarget(null); refresh(); }
  async function cancel(meeting) {
    if (!window.confirm('Cancel this scheduled meeting? Its invite will stop working.')) return;
    try {
      await api('/meetings/' + meeting.id + '/moderate', { method: 'POST', body: { action: 'end' } });
      setEditing(null); setNotice('Meeting canceled.'); refresh();
    } catch (error) { setNotice(error.message); setEditing(null); }
  }
  async function copy(meeting) {
    try { await navigator.clipboard.writeText(invitation(meeting.id)); setNotice('Meeting invite copied.'); }
    catch { setNotice('Meeting code: ' + meeting.id); }
  }
  if (session) return <Suspense fallback={<div className="boot"><Logo /><p>Opening your room…</p></div>}><Conference session={session} api={api} prefs={prefs} updatePrefs={updatePrefs} onLeave={leave} /></Suspense>;
  const active = meetings.filter(meeting => !meeting.stoppedAt).toSorted((a, b) => a.startAt - b.startAt);
  const rows = page === 'home' ? active.slice(0, 5) : filter === 'past' ? meetings.filter(meeting => meeting.stoppedAt) : active;
  return <div className="workspace">
    <aside className="sidebar">
      <Logo />
      <nav aria-label="Workspace">
        {panels.map(({ id, title, icon: Icon }) => <button key={id} aria-current={page === id ? 'page' : undefined} className="nav-button"
          aria-label={title} title={title} onClick={() => { setPage(id); setNotice(''); }}><Icon size={19} /><span>{title}</span></button>)}
      </nav>
      <div className="sidebar-foot" title={config.desktop ? 'Meeting links work on this PC' : undefined}>
        <span className="status-dot" /><span>{config.desktop ? 'Local workspace' : 'Connected workspace'}</span>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <span>Workspace <ChevronRight size={14} /> <strong>{panels.find(panel => panel.id === page).title}</strong></span>
        <div className="workspace-account">
          <span className="account-avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
          <strong title={name}>{name}</strong>{accountControl}
        </div>
      </header>
      <div className="main-content">
        {notice && <div className="notice"><span role="status">{notice.message}</span>
          {notice.calendar.length > 1 && <button className="button small" onClick={() => calendarSeries(notice.calendar)}>
            <ArrowDownToLine size={16} /> Download series calendar
          </button>}
          <button className="icon-button" aria-label="Dismiss" onClick={() => setNotice('')}><X size={16} /></button></div>}
        {page === 'home' && <>
          <div className="page-head home-heading">
            <h1>{user?.firstName ? 'Welcome, ' + user.firstName : 'Home'}</h1>
            <p className="today"><CalendarDays size={17} />{dateLabel.format(new Date())}</p>
          </div>
          <section className="action-grid" aria-label="Meeting actions">
            {meetingActions.map(({ id, title, description, icon: Icon }) => <button key={id}
              className={'action-card action-' + id} aria-label={title} onClick={() => setModal(id)}>
              <span className="action-icon"><Icon size={24} /></span>
              <span className="action-text"><strong>{title}</strong><span>{description}</span></span>
              <ArrowRight className="action-arrow" size={19} aria-hidden="true" />
            </button>)}
          </section>
        </>}
        {page === 'meetings' && <div className="page-head"><h1>Meetings</h1><div className="meeting-actions">
          {config.cloudRecording && <button className="button" onClick={() => setModal('cloud-recordings')}>
            <ArrowDownToLine size={16} /> Cloud recordings</button>}
          <button className="button" onClick={() => setModal('join')}><DoorOpen size={17} /> Join</button>
          <button className="button primary" onClick={() => setModal('schedule')}><Plus size={18} /> Schedule</button>
        </div></div>}
        {page === 'settings' ? <><div className="page-head"><h1>Settings</h1></div><WorkspaceSettings prefs={prefs} updatePrefs={updatePrefs} /></> : <section className="meeting-list">
          <div className="section-header"><h2>{page === 'home' ? 'Upcoming meetings' : 'Your meetings'}</h2>{page === 'home'
            ? <button className="button subtle" onClick={() => setPage('meetings')}>View all <ChevronRight size={16} /></button>
            : <div className="segment" aria-label="Meeting history">{['upcoming', 'past'].map(tab => <button key={tab} className={filter === tab ? 'active' : ''} aria-pressed={filter === tab} onClick={() => setFilter(tab)}>{tab === 'upcoming' ? 'Upcoming' : 'Past'}</button>)}</div>}</div>
          {loading && !rows.length ? <p className="empty">Loading meetings…</p> : rows.length === 0 ? <div className="empty"><CalendarDays size={25} /><strong>{filter === 'past' && page === 'meetings' ? 'No past meetings' : 'Your schedule is clear'}</strong><span>{filter === 'past' && page === 'meetings' ? 'Ended meetings appear here.' : 'Scheduled meetings will appear here.'}</span></div> :
            rows.map(meeting => <article className="meeting-row" key={meeting.id}><div className="meeting-symbol"><Video size={19} /></div><div className="meeting-info"><strong>{meeting.title}</strong><span><Clock3 size={13} />{timeLabel.format(meeting.startAt)} {meeting.openedAt && !meeting.stoppedAt && <em>Room open</em>}</span></div>
              {meeting.hasPasscode && <LockKeyhole className="muted" size={16} aria-label="Passcode required" />}
              {meeting.stoppedAt ? <>{!meeting.encrypted && <button className="icon-button" title="View meeting notes" aria-label="View meeting notes" onClick={() => setArchived(meeting)}><FileText size={17} /></button>}<span className="muted">{meeting.openedAt ? 'Ended' : 'Canceled'}</span></> : <>
                <button className="icon-button" aria-label="Copy invite" title="Copy invite" onClick={() => copy(meeting)}><Clipboard size={17} /></button>
                <button className="icon-button" aria-label="Download calendar invite" title="Download calendar invite" onClick={() => calendarInvite(meeting)}><ArrowDownToLine size={17} /></button>
                {meeting.isHost && !meeting.openedAt && <button className="icon-button" aria-label="Manage scheduled meeting" title="Manage scheduled meeting" onClick={() => setEditing(meeting)}><Ellipsis size={18} /></button>}
                <button className="button" onClick={() => meeting.isHost ? enter(meeting) : setModal('join-' + meeting.id)}>{meeting.isHost ? 'Open' : 'Join'}</button></>}
            </article>)}
        </section>}
      </div>
    </main>
    {['start', 'schedule'].includes(modal) && <MeetingForm mode={modal} api={api} name={name} close={() => setModal('')} onCreated={created} />}
    {editing && modal !== 'edit' && <Dialog title={editing.title} close={() => setEditing(null)}><div className="dialog-actions"><button className="button danger" onClick={() => cancel(editing)}>Cancel meeting</button><button className="button primary" onClick={() => setModal('edit')}>Reschedule</button></div></Dialog>}
    {editing && modal === 'edit' && <MeetingForm mode="edit" meeting={editing} api={api} name={name} close={() => { setModal(''); setEditing(null); }} onCreated={meeting => { setEditing(null); created(meeting, true); }} />}
    {archived && <Dialog title={archived.title + ' · Notes'} close={() => setArchived(null)}><Notes api={api} id={archived.id} readOnly /></Dialog>}
    {modal === 'cloud-recordings' && <CloudRecordingLibrary api={api} close={() => setModal('')} />}
    {modal.startsWith('join') && <JoinForm code={modal === 'join' ? inviteCode || '' : modal.slice(5)} close={() => setModal('')} onJoin={enter} />}
    {target && <Preflight target={target} prefs={prefs} updatePrefs={updatePrefs} api={api} name={name} close={() => setTarget(null)} onConnected={setSession} />}
  </div>;
}
