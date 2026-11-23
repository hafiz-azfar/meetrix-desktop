import React, { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  LiveKitRoom, RoomAudioRenderer, StartAudio, VideoTrack, useConnectionState,
  useLocalParticipant, useParticipants, useRoomContext, useTracks,
} from '@livekit/components-react';
import { ConnectionState, RoomEvent, ScreenSharePresets, Track } from 'livekit-client';
import { createEncryptedRoom } from './encrypted-room.js';
import {
  ChartNoAxesColumn, Clipboard, FileText, Grid2X2, Hand, Lock, LockOpen, MessageSquare, Mic, MicOff, MonitorUp, SmilePlus,
  Gauge, Maximize, PanelsTopLeft, PenTool, PhoneOff, Send, Settings2, ShieldCheck, SlidersHorizontal, UserMinus, Users, Video, VideoOff, X,
} from 'lucide-react';
import { invitation } from './api.js';
import { Notes } from './notes.jsx';
import { Polls } from './polls.jsx';
import { Whiteboard } from './whiteboard.jsx';
import { Dialog, Logo } from './ui.jsx';
import { captureOptions, DeviceFields, microphoneOptions, SpeakerVolume } from './media-devices.jsx';
import { CallViewOptions } from './settings.jsx';
import { CallStatistics } from './call-statistics.jsx';
import { shortcutFor } from './shortcuts.js';
import { BreakoutRooms } from './breakout-rooms.jsx';
import { placementTopic, useRoomPlacement } from './room-placement.js';

const videoOptions = { adaptiveStream: true, dynacast: true, stopLocalTrackOnUnpublish: true };
const messageTopic = 'meetrix.meeting';
const breakoutMessageTopic = 'meetrix.breakout-announcement';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const reactions = ['👍', '👏', '🎉', '❤️'];
const panelTitles = {
  people: 'Participants', chat: 'Meeting chat', polls: 'Polls', board: 'Whiteboard', notes: 'Notes',
  quality: 'Call statistics', breakouts: 'Breakout rooms',
};

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(word => word[0]?.toUpperCase()).join('') || '?';
}

export function Conference({ session, api, prefs, updatePrefs, onLeave }) {
  const placement = useRoomPlacement(api, session);
  if (placement.ended) return <main className="boot"><Logo />
    <p role="status">You are disconnected from this room.</p>
    <button className="button" onClick={onLeave}>Return to workspace</button>
  </main>;
  return <ConferenceConnection key={placement.session.roomId} session={placement.session} api={api}
    prefs={prefs} updatePrefs={updatePrefs} onLeave={onLeave} refreshPlacement={placement.refreshPlacement} />;
}

function ConferenceConnection({ session, api, prefs, updatePrefs, onLeave, refreshPlacement }) {
  const [error, setError] = useState('');
  const [secureRoom, setSecureRoom] = useState(null);
  useEffect(() => {
    if (!session.meeting.encrypted) return;
    let cancelled = false;
    let secure;
    createEncryptedRoom(session.roomKey, videoOptions).then(value => {
      secure = value;
      if (cancelled) { secure.dispose().catch(() => {}); return; }
      value.room.on(RoomEvent.EncryptionError, () => setError('A participant’s media could not be decrypted. Check the room encryption key.'));
      setSecureRoom(value.room);
    }).catch(() => { if (!cancelled) setError('This device could not initialize end-to-end encryption.'); });
    return () => { cancelled = true; secure?.dispose().catch(() => {}); };
  }, [session]);
  if (session.meeting.encrypted && !secureRoom) return <main className="boot"><Logo /><p role="status">{error || 'Preparing the encrypted room…'}</p><button className="button" onClick={onLeave}>Return to workspace</button></main>;
  return <LiveKitRoom room={secureRoom || undefined} serverUrl={session.serverUrl} token={session.token} audio={false} video={false}
    options={secureRoom ? undefined : videoOptions} onError={error => setError(error.message || 'Could not connect to the room.')}>
    <Call session={session} api={api} prefs={prefs} updatePrefs={updatePrefs} onLeave={onLeave}
      connectionError={error} refreshPlacement={refreshPlacement} />
    <RoomAudioRenderer volume={prefs.speakerVolume} />
  </LiveKitRoom>;
}

function Tile({ participant, isHost, raised, mirror, showNames, pauseCamera }) {
  const publication = participant.getTrackPublication(Track.Source.Camera);
  const showVideo = !pauseCamera && publication?.track && !publication.isMuted;
  const name = participant.name || 'Guest';
  return <article className={'tile' + (participant.isSpeaking ? ' speaking' : '')}>
    {showVideo ? <VideoTrack className={participant.isLocal && mirror ? 'mirrored-video' : undefined}
      trackRef={{ participant, publication, source: Track.Source.Camera }} />
      : <span className="tile-avatar">{initials(name)}</span>}
    <div className="tile-label" hidden={!showNames && !raised && participant.isMicrophoneEnabled}>
      {raised && <Hand size={15} />} {showNames && <>{name}{participant.isLocal && ' (you)'}{isHost && <small>Host</small>}</>}
      {!participant.isMicrophoneEnabled && <MicOff size={14} />}
    </div>
  </article>;
}

function ElapsedTime({ joinedAt }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - joinedAt) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = String(Math.floor(elapsed / 60) % 60).padStart(2, '0');
  const seconds = String(elapsed % 60).padStart(2, '0');
  return <time title="Time connected" className="call-timer">{hours ? hours + ':' : ''}{minutes}:{seconds}</time>;
}

function Call({ session, api, prefs, updatePrefs, onLeave, connectionError, refreshPlacement }) {
  const room = useRoomContext();
  const connection = useConnectionState();
  const { localParticipant, isCameraEnabled, isMicrophoneEnabled, isScreenShareEnabled } = useLocalParticipant();
  const participants = useParticipants();
  // Keep all tracks subscribed, including screen audio rendered by RoomAudioRenderer.
  const shares = useTracks([Track.Source.ScreenShare]);
  const [layout, setLayout] = useState(prefs.layout);
  const [panel, setPanel] = useState(session.meeting.isHost ? 'people' : '');
  const [error, setError] = useState('');
  const [toast, setToast] = useState(session.roomNotice || '');
  const [confirmation, setConfirmation] = useState(false);
  const [settings, setSettings] = useState(false);
  const [viewOptions, setViewOptions] = useState(false);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [exiting, setExiting] = useState(false);
  const [pending, setPending] = useState(false);
  const [joinedAt, setJoinedAt] = useState(null);
  const [guests, setGuests] = useState([]);
  const [locked, setLocked] = useState(session.meeting.locked);
  const [chat, setChat] = useState([]);
  const [hands, setHands] = useState({});
  const [reactionMenu, setReactionMenu] = useState(false);
  const [reaction, setReaction] = useState(null);
  const [typed, setTyped] = useState('');
  const didInitialize = useRef(false);
  const chartEnd = useRef(null);
  const id = session.meeting.id;
  const host = session.meeting.isHost;
  const online = connection === ConnectionState.Connected;
  const ended = joinedAt != null && connection === ConnectionState.Disconnected;
  const collaboration = !session.meeting.encrypted && !session.accountless && !session.breakoutName;

  async function run(operation) {
    setError('');
    try { await operation(); return true; }
    catch (failure) { setError(failure.message || 'That action could not be completed.'); return false; }
  }

  useEffect(() => {
    if (!online || didInitialize.current) return;
    setJoinedAt(Date.now());
    didInitialize.current = true;
    run(async () => {
      const media = session.media ?? prefs;
      const results = await Promise.allSettled([
        media.microphone ? localParticipant.setMicrophoneEnabled(true, microphoneOptions(prefs)) : null,
        media.camera ? localParticipant.setCameraEnabled(true, captureOptions(prefs.cameraId)) : null,
        prefs.speakerId ? room.switchActiveDevice('audiooutput', prefs.speakerId) : null,
      ]);
      if (results.some(result => result.status === 'rejected')) throw new Error('One or more selected devices could not be started.');
    });
  }, [online, localParticipant, prefs, room, session.media]);

  useEffect(() => {
    if (!prefs.pauseIncomingCameras) return;
    const paused = new Set();
    function pause(publication) {
      if (publication.source !== Track.Source.Camera || !publication.isDesired) return;
      publication.setSubscribed(false);
      paused.add(publication);
    }
    function remove(publication) { paused.delete(publication); }
    for (const participant of room.remoteParticipants.values()) participant.videoTrackPublications.forEach(pause);
    room.on(RoomEvent.TrackPublished, pause);
    room.on(RoomEvent.TrackUnpublished, remove);
    return () => {
      room.off(RoomEvent.TrackPublished, pause);
      room.off(RoomEvent.TrackUnpublished, remove);
      for (const publication of paused) publication.setSubscribed(true);
    };
  }, [prefs.pauseIncomingCameras, room]);

  useEffect(() => {
    function update() { setFullscreen(Boolean(document.fullscreenElement)); }
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  useEffect(() => {
    if (!host || ended) return;
    let stopped = false;
    let timer;
    async function update() {
      try {
        const result = await api('/meetings/' + id + '/lobby');
        if (!stopped) { setGuests(result.guests); setLocked(result.locked); }
      } catch (failure) { if (!stopped && failure.status === 401) setError(failure.message); }
      if (!stopped) timer = setTimeout(update, 4000);
    }
    update();
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, id, host, ended]);

  useEffect(() => {
    function receive(payload, participant, _kind, topic) {
      if (!participant && topic === placementTopic) { refreshPlacement(); return; }
      if (!participant && topic === breakoutMessageTopic && session.breakoutName && payload.byteLength <= 1200) {
        const text = decoder.decode(payload).trim();
        if (text && text.length <= 300) setToast('Host announcement · ' + text);
        return;
      }
      if (!participant || topic !== messageTopic || payload.byteLength > 6000) return;
      try {
        const event = JSON.parse(decoder.decode(payload));
        if (event.kind === 'message' && typeof event.text === 'string' && event.text.length <= 1000) {
          setChat(previous => [...previous.slice(-199), { key: crypto.randomUUID(), from: participant.name || 'Guest', text: event.text }]);
        }
        if (event.kind === 'reaction' && reactions.includes(event.emoji)) setReaction({ emoji: event.emoji, from: participant.name || 'Guest' });
        if (event.kind === 'hand' && typeof event.raised === 'boolean') {
          setHands(previous => ({ ...previous, [participant.identity]: event.raised }));
        }
      } catch { /* Ignore malformed room data. */ }
    }
    function remove(participant) {
      setHands(previous => {
        const next = { ...previous };
        delete next[participant.identity];
        return next;
      });
    }
    room.on(RoomEvent.DataReceived, receive);
    room.on(RoomEvent.ParticipantDisconnected, remove);
    room.on(RoomEvent.Disconnected, refreshPlacement);
    return () => {
      room.off(RoomEvent.DataReceived, receive);
      room.off(RoomEvent.ParticipantDisconnected, remove);
      room.off(RoomEvent.Disconnected, refreshPlacement);
    };
  }, [room, refreshPlacement, session.breakoutName]);
  useEffect(() => { chartEnd.current?.scrollIntoView({ block: 'nearest' }); }, [chat, panel]);
  useEffect(() => {
    if (!reaction) return;
    const timer = setTimeout(() => setReaction(null), 2600);
    return () => clearTimeout(timer);
  }, [reaction]);

  async function publish(event) {
    await localParticipant.publishData(encoder.encode(JSON.stringify(event)), { reliable: true, topic: messageTopic });
  }

  async function send(event) {
    event.preventDefault();
    const text = typed.trim();
    if (!text || pending) return;
    setPending(true);
    if (await run(() => publish({ kind: 'message', text }))) {
      setChat(previous => [...previous.slice(-199), { key: crypto.randomUUID(), from: 'You', text }]);
      setTyped('');
    }
    setPending(false);
  }

  async function react(emoji) {
    setReactionMenu(false);
    if (await run(() => publish({ kind: 'reaction', emoji }))) setReaction({ emoji, from: 'You' });
  }

  async function raiseHand() {
    const raised = !hands[localParticipant.identity];
    if (await run(() => publish({ kind: 'hand', raised }))) setHands(previous => ({ ...previous, [localParticipant.identity]: raised }));
  }

  async function moderate(command) {
    return run(async () => {
      await api('/meetings/' + id + '/moderate', { method: 'POST', body: command });
      if (command.action === 'decide') setGuests(previous => previous.filter(guest => guest.identity !== command.identity));
      if (command.action === 'lock') setLocked(command.locked);
    });
  }

  async function exit(end) {
    setExiting(true);
    if (end && !(await moderate({ action: 'end' }))) { setExiting(false); return; }
    await room.disconnect().catch(() => {});
    if (document.fullscreenElement === document.documentElement) await document.exitFullscreen().catch(() => {});
    onLeave();
  }

  async function changeDevice({ key, kind }, deviceId) {
    let roomDevice = deviceId;
    if (!roomDevice && kind !== 'audiooutput') {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === kind);
      const first = devices[0];
      const preferred = first?.deviceId === 'default'
        ? devices.find(device => !['default', 'communications'].includes(device.deviceId) && device.groupId === first.groupId)
        : first;
      roomDevice = preferred?.deviceId || 'default';
    }
    const changed = await room.switchActiveDevice(kind, roomDevice, roomDevice !== 'default');
    if (!changed) throw new Error('Device could not be changed.');
    updatePrefs({ [key + 'Id']: deviceId });
  }

  function togglePanel(value) { setPanel(previous => previous === value ? '' : value); }

  function toggleLayout() { setLayout(previous => previous === 'grid' ? 'speaker' : 'grid'); }

  function toggleMicrophone() {
    return run(() => localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled, microphoneOptions(prefs)));
  }

  function toggleCamera() {
    return run(() => localParticipant.setCameraEnabled(!isCameraEnabled, captureOptions(prefs.cameraId)));
  }

  function toggleShare() {
    const preset = ScreenSharePresets.h1080fps15;
    const resolution = prefs.shareFps ? { ...preset.resolution, frameRate: prefs.shareFps } : undefined;
    const publishOptions = prefs.shareFps
      ? { screenShareEncoding: { ...preset.encoding, maxFramerate: prefs.shareFps } }
      : undefined;
    return run(() => localParticipant.setScreenShareEnabled(!isScreenShareEnabled, {
      audio: false, resolution, contentHint: prefs.shareHint || undefined,
    }, publishOptions));
  }

  function toggleFullscreen() {
    return run(() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  }

  function requestLeave() {
    if (!ended && (host || prefs.confirmLeave)) setConfirmation(true);
    else exit(false);
  }

  const handleShortcut = useEffectEvent(event => {
    if (!online || !prefs.shortcutsEnabled || document.querySelector('dialog[open]')) return;
    const action = shortcutFor(event, prefs.shortcuts);
    if (!action) return;
    const handlers = {
      microphone: toggleMicrophone, camera: toggleCamera, people: () => togglePanel('people'),
      chat: () => togglePanel('chat'), hand: raiseHand, layout: toggleLayout, quality: () => togglePanel('quality'),
      fullscreen: toggleFullscreen,
    };
    event.preventDefault();
    handlers[action]();
  });
  useEffect(() => {
    function onKeyDown(event) { handleShortcut(event); }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const visibleParticipants = participants.filter(participant =>
    (!prefs.hideSelf || !participant.isLocal) && (!prefs.cameraOnly || participant.isCameraEnabled));
  const display = layout === 'speaker'
    ? visibleParticipants.toSorted((a, b) => Number(b.isSpeaking) - Number(a.isSpeaking)).slice(0, 1)
    : visibleParticipants;
  const activeShare = shares.find(({ publication }) => publication.track && !publication.isMuted);
  const stageClass = 'stage' + (activeShare ? ' with-share share-' + prefs.shareLayout : '');
  const hand = !!hands[localParticipant.identity];

  return <main className="call">
    <header className="call-header"><Logo /><div className="call-title"><strong>{session.meeting.title}</strong><span><i className="status-dot" />{ended ? 'Disconnected' : online ? 'Connected' : connection === ConnectionState.Reconnecting ? 'Reconnecting' : 'Connecting'}
      {online && prefs.meetingTimer && joinedAt && <ElapsedTime joinedAt={joinedAt} />}
    </span>{session.breakoutName && <span className="breakout-indicator">Breakout · {session.breakoutName}</span>}</div>
      <div className="call-header-actions">
        {session.meeting.encrypted && <span className="button subtle"><ShieldCheck size={16} /> Encrypted media</span>}
        <button className="button" disabled={!online} onClick={() => setSettings(true)}><Settings2 size={16} /> Devices</button>
        <button className="button" onClick={() => run(async () => { await navigator.clipboard.writeText(invitation(id)); setToast('Invite copied.'); })}><Clipboard size={16} /> Invite</button>
        <button className="button" onClick={toggleLayout}><Grid2X2 size={16} /> {layout === 'grid' ? 'Speaker' : 'Gallery'}</button>
        <button className="icon-button" title="View preferences" aria-label="View preferences" onClick={() => setViewOptions(true)}><SlidersHorizontal size={18} /></button>
        <button className="icon-button" title="Call statistics" aria-label="Call statistics" aria-pressed={panel === 'quality'} onClick={() => togglePanel('quality')}><Gauge size={18} /></button>
        {document.fullscreenEnabled && <button className="icon-button" title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen}><Maximize size={18} /></button>}
      </div>
    </header>
    {(error || connectionError || toast || ended) && <div className={'call-notice ' + (error || connectionError || ended ? 'error' : '')} role="status">
      <span>{error || connectionError || (ended ? 'You are disconnected from this room.' : toast)}</span>
      {(error || toast) && <button className="icon-button" aria-label="Dismiss notice" onClick={() => { setError(''); setToast(''); }}><X size={17} /></button>}
    </div>}
    <div className="call-body">
      {reaction && <div className="reaction-toast" role="status"><span>{reaction.emoji}</span> {reaction.from}</div>}
      <section className={stageClass} aria-label="Meeting stage">
        {!online && !participants.length ? <div className="empty"><Video size={28} /><strong>{ended ? 'Meeting connection closed' : 'Connecting to the room'}</strong></div> : null}
        {activeShare && <div className="share"><VideoTrack trackRef={activeShare} /><span>{activeShare.participant.name || 'Guest'} is sharing</span></div>}
        {online && !display.length && !activeShare && <div className="empty"><VideoOff size={28} /><strong>There are no visible participant tiles.</strong></div>}
        <div className="tile-grid" style={{ '--tiles': Math.min(3, Math.max(1, display.length)) }}>
          {display.map(participant => <Tile key={participant.identity} participant={participant}
            isHost={participant.identity === session.hostIdentity} raised={hands[participant.identity]} mirror={prefs.mirrorCamera}
            showNames={prefs.showNames} pauseCamera={prefs.pauseIncomingCameras && !participant.isLocal} />)}
        </div>
      </section>
      {panel && <aside className="call-side"><div className="dialog-head"><h2>{panelTitles[panel]}</h2><button className="icon-button" aria-label="Close panel" onClick={() => setPanel('')}><X size={18} /></button></div>
        {panel === 'people' && <>
          {host && <div className="host-actions"><button className="button" onClick={() => moderate({ action: 'lock', locked: !locked })}>{locked ? <Lock size={16} /> : <LockOpen size={16} />}{locked ? 'Unlock room' : 'Lock room'}</button></div>}
          {host && guests.length > 0 && <div className="waiting-list"><h3>Waiting room · {guests.length}</h3>{guests.map(guest => <div className="waiting-person" key={guest.identity}><strong>{guest.name}{guest.accountless && <small>Unverified guest</small>}</strong><div><button className="button primary small" onClick={() => moderate({ action: 'decide', identity: guest.identity, admit: true })}>Admit</button><button className="button small" onClick={() => moderate({ action: 'decide', identity: guest.identity, admit: false })}>Decline</button></div></div>)}</div>}
          <div className="people-list">{participants.map(participant => <div className="person" key={participant.identity}><span className="person-avatar">{initials(participant.name || 'Guest')}</span>
            <div><strong>{participant.name || 'Guest'}{participant.isLocal && ' (you)'}</strong>{participant.identity === session.hostIdentity && <small>Host</small>}{participant.identity.startsWith('guest_') && <small>Unverified guest</small>}</div>
            {hands[participant.identity] && <Hand size={16} />}
            {host && !participant.isLocal && <>
              <button className="icon-button" title="Mute participant" aria-label={'Mute ' + participant.name} onClick={() => moderate({ action: 'mute', identity: participant.identity })}><MicOff size={17} /></button>
              <button className="icon-button" title="Remove participant" aria-label={'Remove ' + participant.name} onClick={() => {
                if (window.confirm('Remove this participant and block them from rejoining?')) moderate({ action: 'remove', identity: participant.identity });
              }}><UserMinus size={17} /></button>
            </>}
          </div>)}</div>
        </>}
        {panel === 'chat' && <>
          <div className="chat-log" data-text-size={prefs.chatSize} aria-live={prefs.announceMessages ? 'polite' : 'off'}>{chat.length === 0 && <p className="muted">Messages are visible to participants in this room.</p>}
            {chat.map(message => <div className="chat-message" key={message.key}><strong>{message.from}</strong><p>{message.text}</p></div>)}<span ref={chartEnd} /></div>
          <form className="chat-form" onSubmit={send}><input aria-label="Message" placeholder="Message everyone" value={typed} maxLength={1000} onChange={event => setTyped(event.target.value)} /><button className="icon-button" disabled={pending || !online || !typed.trim()} aria-label="Send message"><Send size={19} /></button></form>
        </>}
        {panel === 'notes' && <Notes api={api} id={id} />}
        {panel === 'polls' && <Polls api={api} id={id} host={host} />}
        {panel === 'board' && <Whiteboard api={api} id={id} host={host} />}
        {panel === 'quality' && <CallStatistics room={room} online={online} />}
        {panel === 'breakouts' && <BreakoutRooms api={api} meetingId={id} participants={participants}
          removeParticipant={identity => moderate({ action: 'remove', identity })} />}
      </aside>}
    </div>
    <footer className="call-toolbar">
      <StartAudio label="Enable audio" className="button" />
      <button className="call-control" disabled={!online} aria-pressed={isMicrophoneEnabled} onClick={toggleMicrophone}>{isMicrophoneEnabled ? <Mic size={20} /> : <MicOff size={20} />}<span>{isMicrophoneEnabled ? 'Mute' : 'Unmute'}</span></button>
      <button className="call-control" disabled={!online} aria-pressed={isCameraEnabled} onClick={toggleCamera}>{isCameraEnabled ? <Video size={20} /> : <VideoOff size={20} />}<span>Camera</span></button>
      <button className="call-control" disabled={!online} aria-pressed={isScreenShareEnabled} onClick={toggleShare}><MonitorUp size={20} /><span>{isScreenShareEnabled ? 'Stop share' : 'Share'}</span></button>
      <button className="call-control" aria-pressed={panel === 'people'} onClick={() => togglePanel('people')}><Users size={20} /><span>People {participants.length + guests.length}</span></button>
      <button className="call-control" aria-pressed={panel === 'chat'} onClick={() => togglePanel('chat')}><MessageSquare size={20} /><span>Chat</span></button>
      {host && !session.meeting.encrypted && <button className="call-control" disabled={!online}
        aria-pressed={panel === 'breakouts'} onClick={() => togglePanel('breakouts')}>
        <PanelsTopLeft size={20} /><span>Breakouts</span>
      </button>}
      {collaboration && <button className="call-control" aria-pressed={panel === 'notes'} onClick={() => togglePanel('notes')}><FileText size={20} /><span>Notes</span></button>}
      {collaboration && <button className="call-control" aria-pressed={panel === 'polls'} onClick={() => togglePanel('polls')}><ChartNoAxesColumn size={20} /><span>Polls</span></button>}
      {collaboration && <button className="call-control" aria-pressed={panel === 'board'} onClick={() => togglePanel('board')}><PenTool size={20} /><span>Board</span></button>}
      <div className="reaction-control"><button className="call-control" disabled={!online} aria-expanded={reactionMenu} onClick={() => setReactionMenu(previous => !previous)}><SmilePlus size={20} /><span>React</span></button>
        {reactionMenu && <div className="reaction-menu">{reactions.map((emoji, index) => <button className="icon-button" key={emoji} onClick={() => react(emoji)} aria-label={['Thumbs up', 'Applaud', 'Celebrate', 'Heart'][index]}>{emoji}</button>)}</div>}
      </div>
      <button className="call-control" disabled={!online} aria-pressed={hand} onClick={raiseHand}><Hand size={20} /><span>{hand ? 'Lower hand' : 'Raise hand'}</span></button>
      <button className="button danger" onClick={requestLeave}><PhoneOff size={17} /> Leave</button>
    </footer>
    {settings && <Dialog title="Audio and video devices" close={() => setSettings(false)}>
      <DeviceFields prefs={prefs} changeDevice={changeDevice} inCall />
      <SpeakerVolume prefs={prefs} updatePrefs={updatePrefs} />
      <div className="dialog-actions"><button className="button primary" onClick={() => setSettings(false)}>Done</button></div>
    </Dialog>}
    {viewOptions && <Dialog title="View preferences" close={() => setViewOptions(false)}>
      <CallViewOptions prefs={prefs} updatePrefs={updatePrefs} />
      <div className="dialog-actions"><button className="button primary" onClick={() => setViewOptions(false)}>Done</button></div>
    </Dialog>}
    {confirmation && <Dialog title="Leave the meeting?" close={() => setConfirmation(false)}>
      {host && !ended && <p className="muted"><ShieldCheck size={16} /> Ending the meeting disconnects everyone and closes its invite.</p>}
      <div className="dialog-actions">
        <button className="button" disabled={exiting} onClick={() => exit(false)}>Leave room</button>
        {host && !ended && <button className="button danger" disabled={exiting} onClick={() => exit(true)}>End for everyone</button>}
      </div>
    </Dialog>}
  </main>;
}
