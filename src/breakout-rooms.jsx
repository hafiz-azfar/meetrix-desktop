import React, { useEffect, useState } from 'react';
import { Hourglass, Plus, Send, Shuffle, UserMinus, X } from 'lucide-react';

export function BreakoutCountdown({ closesAt, label = 'Returning in' }) {
  if (!closesAt) return null;
  return <BreakoutClock key={closesAt} closesAt={closesAt} label={label} />;
}

function BreakoutClock({ closesAt, label }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, []);
  const remaining = Math.max(0, Math.ceil((closesAt - now) / 1000));
  const minutes = Math.floor(remaining / 60);
  return <span className="breakout-indicator" role="timer">{label} {minutes}:{String(remaining % 60).padStart(2, '0')}</span>;
}

export function BreakoutRooms({ api, meetingId, participants, moveToWaitingRoom, removeParticipant }) {
  const [active, setActive] = useState(null);
  const [openSelection, setOpenSelection] = useState(false);
  const [selfSelect, setSelfSelect] = useState(false);
  const [closesAt, setClosesAt] = useState(null);
  const [duration, setDuration] = useState('');
  const [closeDelay, setCloseDelay] = useState('30');
  const [names, setNames] = useState(['Room 1', 'Room 2']);
  const [assignments, setAssignments] = useState({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const [plan, setPlan] = useState(null);
  const [preassignedCount, setPreassignedCount] = useState(0);
  const path = '/meetings/' + meetingId + '/breakouts';
  const attendees = participants.filter(participant => !participant.isLocal && participant.identity);

  useEffect(() => {
    if (pending) return;
    const controller = new AbortController();
    let timer;
    async function loadRooms() {
      try {
        const result = await api(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setActive(result.rooms);
        setClosesAt(result.closesAt);
        setOpenSelection(result.selfSelect === true);
        setPlan(result.plan ?? null);
        setPreassignedCount(result.preassignedCount ?? 0);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(loadRooms, 5000);
      }
    }
    void loadRooms();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, path, pending, retry]);

  function removeRoom(index) {
    setNames(previous => previous.filter((_, position) => position !== index));
    setAssignments(previous => Object.fromEntries(Object.entries(previous)
      .filter(([, position]) => position !== index)
      .map(([identity, position]) => [identity, position > index ? position - 1 : position])));
  }

  async function submit(command) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      const result = await api(path, { method: 'POST', body: command });
      setActive(result.rooms);
      setClosesAt(result.closesAt);
      setOpenSelection(result.selfSelect === true);
      if (command.action === 'announce') {
        setAnnouncement('');
        setNotice(result.delivered === 1 ? 'Sent to 1 room.' : 'Sent to ' + result.delivered + ' rooms.');
      }
    } catch (failure) {
      setError(failure.message);
      setRetry(value => value + 1);
    } finally { setPending(false); }
  }

  async function updateGuest(guest, action) {
    setPending(true);
    try {
      if (await action(guest)) {
        setActive(previous => previous.map(room => ({
          ...room, members: room.members.filter(member => member.identity !== guest.identity),
        })));
      }
    } finally { setPending(false); }
  }

  const hasAssignments = attendees.some(attendee => Number.isInteger(assignments[attendee.identity]));
  return <section className="breakout-panel">
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!active ? error ? <button className="button" onClick={() => {
      setError('');
      setRetry(value => value + 1);
    }}>Retry</button> : <p className="muted" role="status">Loading breakout rooms…</p>
    : active.length ? <>
      <BreakoutCountdown closesAt={closesAt} label="Rooms close in" />
      <p className="muted">{openSelection ? 'Attendees can choose their own rooms.' : 'Assigned participants move to their rooms.'}</p>
      {active.map(room => <section className="breakout-room" key={room.id || room.name}>
        <h3>{room.name}</h3>
        {!room.members.length && <p className="muted">No assigned participants</p>}
        {room.members.map(guest => <div className="breakout-guest" key={guest.identity}>
          <span>{guest.name}</span>
          <button className="icon-button" disabled={pending} aria-label={'Move ' + guest.name + ' to waiting room'}
            title="Move to waiting room" onClick={() => updateGuest(guest, moveToWaitingRoom)}><Hourglass size={16} /></button>
          <button className="icon-button" disabled={pending} aria-label={'Remove ' + guest.name + ' from meeting'}
            title="Remove from meeting" onClick={() => {
              if (window.confirm('Remove ' + guest.name + ' from the meeting?')) updateGuest(guest, member => removeParticipant(member.identity));
            }}><UserMinus size={16} /></button>
        </div>)}
      </section>)}
      <form className="form" onSubmit={event => { event.preventDefault(); submit({ action: 'announce', text: announcement }); }}>
        <label>Announcement to rooms
          <textarea value={announcement} maxLength={300} rows={2} onChange={event => setAnnouncement(event.target.value)} />
        </label>
        <button className="button" disabled={pending || !announcement.trim()}><Send size={15} /> Send announcement</button>
      </form>
      <div className="breakout-actions">
        <label>Return countdown
          <select value={closeDelay} onChange={event => setCloseDelay(event.target.value)}>
            {[15, 30, 60].map(seconds => <option value={seconds} key={seconds}>{seconds} seconds</option>)}
          </select>
        </label>
        <button type="button" className="button small" disabled={pending} onClick={() => submit({ action: 'close', delaySeconds: Number(closeDelay) })}>
          Start return countdown
        </button>
      </div>
      <button className="button primary" disabled={pending} onClick={() => submit({ action: 'close' })}>
        Close all rooms
      </button>
    </> : <form className="form" onSubmit={event => {
      event.preventDefault();
      submit({ action: 'open', selfSelect, durationSeconds: duration ? Number(duration) * 60 : undefined, rooms: names.map((name, index) => ({
        name, members: attendees.filter(person => assignments[person.identity] === index).map(person => person.identity),
      })) });
    }}>
      {plan && <div><button type="button" className="button small" disabled={pending} onClick={() => {
        setNames(plan.names);
        setAssignments({});
        setSelfSelect(plan.selfSelect);
        setDuration(plan.durationMinutes ? String(plan.durationMinutes) : '');
        setNotice('Scheduled breakout plan loaded.');
      }}>Load scheduled plan</button></div>}
      <div className="breakout-fields">
        {names.map((name, index) => <div className="breakout-name" key={index}>
          <input aria-label={'Name for breakout room ' + (index + 1)} value={name} maxLength={40} required disabled={pending}
            onChange={event => setNames(previous => previous.map((value, position) => position === index ? event.target.value : value))} />
          {names.length > 1 && <button type="button" className="icon-button" aria-label={'Remove breakout room ' + (index + 1)}
            disabled={pending} onClick={() => removeRoom(index)}><X size={16} /></button>}
        </div>)}
      </div>
      <div className="breakout-actions">
        <button className="button small" type="button" disabled={pending || names.length >= 8} onClick={() => {
          const next = Array.from({ length: 8 }, (_, index) => 'Room ' + (index + 1))
            .find(name => names.every(existing => existing.trim().toLowerCase() !== name.toLowerCase()));
          setNames(previous => [...previous, next]);
        }}><Plus size={15} /> Add room</button>
        <button className="button small" type="button" disabled={pending || !attendees.length}
          onClick={() => setAssignments(Object.fromEntries(attendees.map((person, index) => [person.identity, index % names.length])))}>
          <Shuffle size={15} /> Divide evenly
        </button>
      </div>
      <label className="check"><input type="checkbox" checked={selfSelect} disabled={pending}
        onChange={event => setSelfSelect(event.target.checked)} /> Let attendees choose their room</label>
      <label>Close automatically after (minutes)
        <input type="number" min="1" max="120" step="1" value={duration} placeholder="No time limit"
          disabled={pending} onChange={event => setDuration(event.target.value)} />
      </label>
      {!attendees.length && !selfSelect && <p className="muted">Admit participants before opening breakout rooms.</p>}
      {attendees.map(person => <label key={person.identity}>{person.name || 'Guest'}
        <select aria-label={'Assign ' + (person.name || 'Guest')} value={assignments[person.identity] ?? ''} disabled={pending}
          onChange={event => setAssignments(previous => ({
            ...previous, [person.identity]: event.target.value === '' ? undefined : Number(event.target.value),
          }))}>
          <option value="">Main meeting</option>
          {names.map((name, index) => <option value={index} key={index}>{name || 'Room ' + (index + 1)}</option>)}
        </select>
      </label>)}
      <button className="button primary" disabled={pending || (!hasAssignments && !selfSelect)}>{pending ? 'Opening…' : 'Open breakout rooms'}</button>
      {preassignedCount > 0 && <div>
        <p className="muted">{preassignedCount} {preassignedCount === 1 ? 'participant has' : 'participants have'} scheduled assignments. Matching sign-ins move after admission.</p>
        <button className="button primary" type="button" disabled={pending}
          onClick={() => submit({ action: 'open-plan' })}>Open with scheduled assignments</button>
      </div>}
    </form>}
  </section>;
}

export function ChooseBreakoutRoom({ rooms, roomId, meetingId, onChoose }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function choose(destination) {
    setPending(true);
    setError('');
    try { await onChoose(destination); }
    catch (failure) { setError(failure.message || 'Could not switch rooms.'); }
    finally { setPending(false); }
  }

  return <section className="breakout-panel" aria-label="Choose a breakout room">
    <p className="muted">Your camera and microphone turn off when you switch rooms.</p>
    {rooms.map(room => <div className="breakout-guest" key={room.id}>
      <strong>{room.name}</strong>
      {room.id === roomId ? <span className="muted">Current room</span>
        : <button type="button" className="button small" disabled={pending}
          aria-label={'Join ' + room.name} onClick={() => choose(room.id)}>Join</button>}
    </div>)}
    {roomId !== meetingId && <button type="button" className="button" disabled={pending}
      onClick={() => choose(null)}>Return to main meeting</button>}
    {pending && <p role="status">Switching rooms…</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
