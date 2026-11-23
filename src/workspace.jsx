import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, AudioLines, CalendarDays, Check, ChevronRight, CircleHelp,
  Clipboard, Clock3, DoorOpen, Ellipsis, FileText, House, LockKeyhole, Mic, Monitor, Plus, Settings, ShieldCheck,
  Video, X,
} from 'lucide-react';
import { apiFor, calendarInvite, invitation, parseInvitation } from './api.js';
import { generateRoomKey, validRoomKey } from './encryption.js';
import { Logo, Dialog } from './ui.jsx';
import { Notes } from './notes.jsx';

const Conference = lazy(() => import('./conference.jsx').then(module => ({ default: module.Conference })));
const defaults = { camera: false, microphone: false, cameraId: '', microphoneId: '' };
const panels = [
  { id: 'home', title: 'Overview', icon: House },
  { id: 'meetings', title: 'Meetings', icon: CalendarDays },
  { id: 'settings', title: 'Settings', icon: Settings },
];
const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const timeLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const inviteCode = new URLSearchParams(location.search).get('m');

function getPrefs() {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('meetrix-devices') || '{}') }; }
  catch { return defaults; }
}

function localDateValue(time) {
  const local = new Date(time - new Date(time).getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function MeetingForm({ mode, meeting, api, name, close, onCreated }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setWorking(true);
    setError('');
    try {
      const scheduled = mode !== 'start';
      const details = { title: form.get('title'), duration: Number(form.get('duration') || 60) };
      if (scheduled) details.startAt = new Date(form.get('when')).toISOString();
      if (mode === 'edit') {
        onCreated(await api('/meetings/' + meeting.id, { method: 'PATCH', body: details }), true);
        return;
      }
      const additionalStarts = [];
      for (let week = 1; week < Number(form.get('repeats') || 1); week++) {
        const occurrence = new Date(form.get('when'));
        occurrence.setDate(occurrence.getDate() + week * 7);
        additionalStarts.push(occurrence.toISOString());
      }
      const created = await api('/meetings', { method: 'POST', body: {
        ...details, name, additionalStarts, lobby: form.get('lobby') === 'on', encrypted: form.get('encrypted') === 'on',
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
        <label>Start time ({Intl.DateTimeFormat().resolvedOptions().timeZone}) <input type="datetime-local" name="when" defaultValue={meeting ? localDateValue(meeting.startAt) : ''} required /></label>
        <label>Calendar duration<select name="duration" defaultValue={meeting?.duration || 60}>{[15, 30, 45, 60, 90, 120, 180, 1800].map(minutes => <option key={minutes} value={minutes}>{minutes < 120 ? minutes + ' minutes' : minutes / 60 + ' hours'}</option>)}</select></label>
      </>}
      {mode === 'schedule' && <label>Repeat<select name="repeats"><option value="1">One time</option><option value="4">Weekly, 4 occurrences</option><option value="8">Weekly, 8 occurrences</option><option value="12">Weekly, 12 occurrences</option></select></label>}
      {mode !== 'edit' && <><label>Passcode <span className="muted">(optional)</span><input name="passcode" type="password" autoComplete="new-password" minLength={8} maxLength={128} placeholder="At least 8 characters" /></label>
      <label className="check"><input type="checkbox" name="lobby" defaultChecked /><span><strong>Waiting room</strong><small>Admit each guest before they join.</small></span></label>
      <label className="check"><input type="checkbox" name="encrypted" /><span><strong>End-to-end encrypted room</strong><small>Share a separate room key with guests. Server-stored collaboration is disabled.</small></span></label></>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button" type="button" onClick={close}>Cancel</button><button className="button primary" disabled={working}>{working ? 'Saving…' : mode === 'edit' ? 'Save changes' : mode === 'schedule' ? 'Schedule' : 'Continue'}</button></div>
    </form>
  </Dialog>;
}

function JoinForm({ code, close, onJoin }) {
  const [error, setError] = useState('');
  return <Dialog title="Join a meeting" close={close}>
    <form className="form" onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try { onJoin({ id: parseInvitation(form.get('code')), passcode: form.get('passcode') }); }
      catch (failure) { setError(failure.message); }
    }}>
      <label>Meeting link or code<input name="code" autoFocus required defaultValue={code} maxLength={300} /></label>
      <label>Passcode <span className="muted">(if required)</span><input name="passcode" type="password" autoComplete="off" minLength={8} maxLength={128} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button" type="button" onClick={close}>Cancel</button><button className="button primary">Continue <ArrowRight size={16} /></button></div>
    </form>
  </Dialog>;
}

function Preflight({ target, prefs, updatePrefs, api, name, close, onConnected }) {
  const [phase, setPhase] = useState('preview');
  const [needsKey, setNeedsKey] = useState(Boolean(target.encrypted));
  const [roomKey, setRoomKey] = useState('');
  const [keyCopied, setKeyCopied] = useState(false);
  const [failure, setFailure] = useState('');
  const [cameraFailure, setCameraFailure] = useState('');
  const video = useRef(null);
  useEffect(() => {
    if (!prefs.camera || phase === 'connecting') return;
    let cancelled = false;
    let stream;
    navigator.mediaDevices.getUserMedia({ video: prefs.cameraId ? { deviceId: { exact: prefs.cameraId } } : true })
      .then(value => {
        stream = value;
        if (cancelled) value.getTracks().forEach(track => track.stop());
        else if (video.current) { setCameraFailure(''); video.current.srcObject = value; }
      }).catch(() => { if (!cancelled) setCameraFailure('Camera preview is unavailable. You can still join.'); });
    return () => { cancelled = true; stream?.getTracks().forEach(track => track.stop()); };
  }, [prefs.camera, prefs.cameraId, phase === 'connecting']);
  useEffect(() => {
    if (!['connecting', 'waiting', 'host-pending'].includes(phase)) return;
    let cancelled = false;
    let timer;
    async function connect() {
      try {
        const result = await api('/meetings/' + target.id + '/connect', {
          method: 'POST', body: { name, ...(validRoomKey(roomKey) ? { keyReady: true } : {}), ...(target.passcode ? { passcode: target.passcode } : {}) },
        });
        if (cancelled) return;
        if (result.state === 'ready') onConnected({ ...result, ...(result.meeting.encrypted ? { roomKey } : {}) });
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
  }, [phase, api, target, name, onConnected, roomKey]);
  const pending = phase !== 'preview';
  return <Dialog title={target.title || 'Check your setup'} close={close}>
    <div className="preview">
      <video ref={video} autoPlay playsInline muted />
      {(!prefs.camera || cameraFailure) && <div className="preview-empty"><Video size={28} /> Camera off</div>}
    </div>
    <div className="preflight-controls">
      <button className={'button' + (prefs.microphone ? ' selected' : '')} onClick={() => updatePrefs({ microphone: !prefs.microphone })}><Mic size={17} /> Microphone {prefs.microphone ? 'on' : 'off'}</button>
      <button className={'button' + (prefs.camera ? ' selected' : '')} onClick={() => updatePrefs({ camera: !prefs.camera })}><Video size={17} /> Camera {prefs.camera ? 'on' : 'off'}</button>
    </div>
    {cameraFailure && prefs.camera && <p className="muted">{cameraFailure}</p>}
    {needsKey && <div className="key-box"><label htmlFor="room-key">Room encryption key</label><input id="room-key" type="password" autoComplete="off" value={roomKey} onChange={event => { setRoomKey(event.target.value.trim()); setKeyCopied(false); }} maxLength={43} disabled={pending} />
      {target.isHost ? <div className="preflight-controls"><button className="button" disabled={pending} onClick={() => { setRoomKey(generateRoomKey()); setKeyCopied(false); }}>Generate key</button><button className="button" disabled={!validRoomKey(roomKey)} onClick={async () => { try { await navigator.clipboard.writeText(roomKey); setKeyCopied(true); } catch { setFailure('Could not copy the key.'); } }}>{keyCopied ? 'Key copied' : 'Copy key'}</button></div> : <p className="muted">Ask the host for this key over a separate secure channel.</p>}
    </div>}
    {failure && <p role="alert" className="error">{failure}</p>}
    {pending && <p role="status" className="waiting"><span className="status-dot" />{phase === 'connecting' ? 'Connecting…' : phase === 'host-pending' ? 'Waiting for the host to start the meeting.' : 'The host will admit you from the waiting room.'}</p>}
    <div className="dialog-actions"><button className="button" onClick={close}>{pending ? 'Leave waiting room' : 'Back'}</button><button className="button primary" disabled={pending || (needsKey && !validRoomKey(roomKey))} onClick={() => { setFailure(''); setPhase('connecting'); }}>{target.isHost ? 'Enter room' : 'Join now'} <ArrowRight size={16} /></button></div>
  </Dialog>;
}

function DeviceSettings({ prefs, updatePrefs }) {
  const [devices, setDevices] = useState([]);
  const [notice, setNotice] = useState('');
  async function scan() {
    try { setDevices(await navigator.mediaDevices.enumerateDevices()); }
    catch { setNotice('Devices could not be read on this computer.'); }
  }
  useEffect(() => {
    scan();
    const media = navigator.mediaDevices;
    media?.addEventListener('devicechange', scan);
    return () => media?.removeEventListener('devicechange', scan);
  }, []);
  async function requestDevices() {
    setNotice('');
    const results = await Promise.allSettled([
      navigator.mediaDevices.getUserMedia({ audio: true }),
      navigator.mediaDevices.getUserMedia({ video: true }),
    ]);
    results.forEach(result => { if (result.status === 'fulfilled') result.value.getTracks().forEach(track => track.stop()); });
    if (results.some(result => result.status === 'rejected')) setNotice('Some devices are unavailable or blocked by system permissions.');
    await scan();
  }
  return <div className="settings-card">
    <div className="section-header"><div><h2>Audio and video</h2><p>Set your defaults before entering a room.</p></div><AudioLines size={23} /></div>
    <div className="settings-fields">
      {[['microphone', 'audioinput', 'Microphone', Mic], ['camera', 'videoinput', 'Camera', Video]].map(([field, kind, title, Icon]) =>
        <div className="settings-row" key={field}><div><Icon size={18} /><strong>{title}</strong></div>
          <select aria-label={title + ' device'} value={prefs[field + 'Id']} onChange={e => updatePrefs({ [field + 'Id']: e.target.value })}>
            <option value="">System default</option>
            {devices.filter(device => device.kind === kind && device.deviceId && device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || title + ' ' + (index + 1)}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={prefs[field]} onChange={e => updatePrefs({ [field]: e.target.checked })} /> Start on</label>
        </div>)}
    </div>
    <button className="button" onClick={requestDevices}>Detect devices</button>
    {notice && <p className="muted" role="status">{notice}</p>}
  </div>;
}

export function Workspace({ config, user, accountControl }) {
  const name = (user?.fullName || user?.username || user?.firstName || 'Participant').slice(0, 60);
  const api = useMemo(apiFor, []);
  const [page, setPage] = useState('home');
  const [filter, setFilter] = useState('upcoming');
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState(inviteCode ? 'join' : '');
  const [target, setTarget] = useState(null);
  const [editing, setEditing] = useState(null);
  const [archived, setArchived] = useState(null);
  const [session, setSession] = useState(null);
  const [prefs, setPrefs] = useState(getPrefs);

  function updatePrefs(changes) {
    setPrefs(prior => {
      const next = { ...prior, ...changes };
      localStorage.setItem('meetrix-devices', JSON.stringify(next));
      return next;
    });
  }
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
      setNotice(meeting.scheduledCount > 1 ? meeting.scheduledCount + ' weekly meetings scheduled.' : 'Meeting saved. Copy its invite to share.');
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
  if (session) return <Suspense fallback={<div className="boot"><Logo /><p>Opening your room…</p></div>}><Conference session={session} api={api} prefs={prefs} onLeave={leave} /></Suspense>;
  const active = meetings.filter(meeting => !meeting.stoppedAt).toSorted((a, b) => a.startAt - b.startAt);
  const rows = page === 'home' ? active.slice(0, 5) : filter === 'past' ? meetings.filter(meeting => meeting.stoppedAt) : active;
  return <div className="workspace">
    <aside className="sidebar">
      <Logo />
      <nav aria-label="Workspace">
        {panels.map(({ id, title, icon: Icon }) => <button key={id} aria-current={page === id ? 'page' : undefined} className={page === id ? 'nav-button current' : 'nav-button'}
          onClick={() => { setPage(id); setNotice(''); }}><Icon size={18} /><span>{title}</span>{page === id && <ChevronRight size={14} />}</button>)}
      </nav>
      <div className="sidebar-foot"><div className="server-mode"><span className="status-dot" />{config.desktop ? 'Local workspace' : 'Connected workspace'}</div>{accountControl}<span>{name}</span></div>
    </aside>
    <main className="main">
      <header className="topbar"><span>Workspace <ChevronRight size={14} /> <strong>{panels.find(p => p.id === page)?.title}</strong></span><button className="button" onClick={() => setModal('join')}><DoorOpen size={16} /> Join a room</button></header>
      <div className="main-content">
        {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" aria-label="Dismiss" onClick={() => setNotice('')}><X size={16} /></button></div>}
        {page === 'home' && <>
          <p className="today"><span className="status-dot" />{dateLabel.format(new Date())}</p>
          <h1>{user?.firstName ? 'Welcome, ' + user.firstName : 'Meeting workspace'}</h1>
          <div className="action-grid">
            <section className="quick-start"><div className="quick-copy"><div className="action-icon"><Video size={24} /></div><h2>Start a meeting</h2><p>Open a room and share its invite when you’re ready.</p><button className="button primary" onClick={() => setModal('start')}><Plus size={19} /> New meeting</button></div><div className="hero-art" aria-hidden="true"><span /><span /><span /><Video strokeWidth={1.05} size={70} /></div></section>
            <section className="quick-schedule"><div className="action-icon"><CalendarDays size={23} /></div><h2>Plan ahead</h2><p>Pick a time and send guests a calendar invite.</p><button className="button" onClick={() => setModal('schedule')}>Schedule meeting <ArrowRight size={16} /></button></section>
          </div>
        </>}
        {page === 'meetings' && <div className="page-head"><div><p className="today"><CalendarDays size={15} /> Calendar</p><h1>Meetings</h1></div><button className="button primary" onClick={() => setModal('schedule')}><Plus size={18} /> Schedule</button></div>}
        {page === 'settings' ? <><p className="today"><Settings size={15} /> Preferences</p><h1>Settings</h1><DeviceSettings prefs={prefs} updatePrefs={updatePrefs} /></> : <section className="meeting-list">
          <div className="section-header"><div><h2>{page === 'home' ? 'Upcoming meetings' : 'Your meetings'}</h2>{page === 'home' && <p>See what’s coming up or reopen a room.</p>}</div>{page === 'home'
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
        <footer className="workspace-foot"><span><ShieldCheck size={16} /> InsForge sign-in</span><span><Monitor size={16} /> LiveKit meetings</span>{config.desktop && <span><CircleHelp size={16} /> Local invites work on this PC</span>}</footer>
      </div>
    </main>
    {['start', 'schedule'].includes(modal) && <MeetingForm mode={modal} api={api} name={name} close={() => setModal('')} onCreated={created} />}
    {editing && modal !== 'edit' && <Dialog title={editing.title} close={() => setEditing(null)}><div className="dialog-actions"><button className="button danger" onClick={() => cancel(editing)}>Cancel meeting</button><button className="button primary" onClick={() => setModal('edit')}>Reschedule</button></div></Dialog>}
    {editing && modal === 'edit' && <MeetingForm mode="edit" meeting={editing} api={api} name={name} close={() => { setModal(''); setEditing(null); }} onCreated={meeting => { setEditing(null); created(meeting, true); }} />}
    {archived && <Dialog title={archived.title + ' · Notes'} close={() => setArchived(null)}><Notes api={api} id={archived.id} readOnly /></Dialog>}
    {modal.startsWith('join') && <JoinForm code={modal === 'join' ? inviteCode || '' : modal.slice(5)} close={() => setModal('')} onJoin={enter} />}
    {target && <Preflight target={target} prefs={prefs} updatePrefs={updatePrefs} api={api} name={name} close={() => setTarget(null)} onConnected={setSession} />}
  </div>;
}
