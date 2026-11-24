import React, { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  LiveKitRoom, RoomAudioRenderer, StartAudio, VideoTrack, useConnectionState,
  useLocalParticipant, useParticipants, useRoomContext, useTracks,
} from '@livekit/components-react';
import { ConnectionState, createLocalVideoTrack, RoomEvent, ScreenSharePresets, Track } from 'livekit-client';
import { createEncryptedRoom } from './encrypted-room.js';
import {
  Captions, ChartNoAxesColumn, CircleDot, Clipboard, Crown, FileText, Grid2X2, Hand, Lock, LockOpen, MessageSquare, Mic, MicOff, MonitorUp, SmilePlus,
  Gauge, Hourglass, Maximize, PanelsTopLeft, PenTool, PhoneOff, Send, Settings2, ShieldCheck, ShieldMinus, ShieldPlus, SlidersHorizontal, UserMinus, Users, Video, VideoOff, X,
} from 'lucide-react';
import { invitation } from './api.js';
import { MeetingRecap } from './meeting-recap.jsx';
import { useMeetingRecap } from './meeting-recap.js';
import { Notes } from './notes.jsx';
import { Polls } from './polls.jsx';
import { Whiteboard } from './whiteboard.jsx';
import { Dialog, Logo } from './ui.jsx';
import { captureOptions, DeviceFields, microphoneOptions, SpeakerVolume } from './media-devices.jsx';
import { applyCameraBackground, CameraBackgroundFields } from './camera-background.jsx';
import { CallViewOptions } from './settings.jsx';
import { CallStatistics } from './call-statistics.jsx';
import { usePushToTalk } from './push-to-talk.js';
import { shortcutFor } from './shortcuts.js';
import { BreakoutCountdown, BreakoutRooms, ChooseBreakoutRoom } from './breakout-rooms.jsx';
import { BreakoutVoicePlayback } from './breakout-voice.jsx';
import { breakoutHelpTopic } from '../server/breakout-voice-format.mjs';
import { CaptionsOverlay, CaptionsPanel, useManualCaptions } from './meeting-captions.jsx';
import { RecordingBanner, RecordingPanel, useMeetingRecording } from './meeting-recording.jsx';
import { hostRolesTopic, placementTopic, useRoomPlacement } from './room-placement.js';
import { ScreenPresentation } from './share-annotations.jsx';
import { CloudRecordingBanner, CloudRecordingPanel, useCloudRecording } from './cloud-recording.jsx';

const videoOptions = { adaptiveStream: true, dynacast: true, stopLocalTrackOnUnpublish: true };
const messageTopic = 'meetrix.meeting';
const breakoutMessageTopic = 'meetrix.breakout-announcement';
const microphoneRequestTopic = 'meetrix.microphone-request';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const reactions = ['👍', '👏', '🎉', '❤️'];
const panelTitles = {
  people: 'Participants', chat: 'Meeting chat', polls: 'Polls', board: 'Whiteboard', notes: 'Notes',
  quality: 'Call statistics', breakouts: 'Breakout rooms', captions: 'Live captions', recap: 'Meeting recap', recording: 'Local recording',
};

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(word => word[0]?.toUpperCase()).join('') || '?';
}

export function Conference({ session, api, prefs, updatePrefs, onLeave }) {
  const placement = useRoomPlacement(api, session);
  const recap = useMeetingRecap();
  const [review, setReview] = useState(false);
  const finishAfterEnd = useEffectEvent(() => {
    if (recap.finish()) setReview(true);
  });
  useEffect(() => { if (placement.ended) finishAfterEnd(); }, [placement.ended]);
  function leave() {
    if (recap.finish()) setReview(true);
    else onLeave();
  }
  if (review) return <main className="boot recap-review"><Logo /><section className="settings-card">
    <h1>Meeting recap</h1><p>{session.meeting.title}</p>
    <MeetingRecap recap={recap} review />
    <button className="button" onClick={() => {
      if (recap.status !== 'generating' || window.confirm('Leave and cancel this recap?')) onLeave();
    }}>Return to workspace</button>
  </section></main>;
  if (placement.ended) return <main className="boot"><Logo />
    <p role="status">You are disconnected from this room.</p>
    <button className="button" onClick={onLeave}>Return to workspace</button>
  </main>;
  if (placement.waiting) return <main className="boot"><Logo />
    <h1>Waiting room</h1>
    <p role="status">The host moved you to the waiting room.</p>
    <button className="button" onClick={leave}>Leave meeting</button>
  </main>;
  return <ConferenceConnection key={placement.session.roomId + ':' + (placement.session.placementEpoch ?? 0)} session={placement.session} api={api}
    prefs={prefs} updatePrefs={updatePrefs} onLeave={leave} recap={recap} roles={placement.roles}
    updateRoles={placement.updateRoles} refreshPlacement={placement.refreshPlacement}
    breakoutChoices={placement.breakoutChoices} breakoutClosesAt={placement.breakoutClosesAt} chooseBreakout={placement.chooseBreakout} />;
}

function ConferenceConnection({ session, api, prefs, updatePrefs, onLeave, recap, roles, updateRoles, refreshPlacement, breakoutChoices, breakoutClosesAt, chooseBreakout }) {
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
    <Call session={session} api={api} prefs={prefs} updatePrefs={updatePrefs} onLeave={onLeave} recap={recap}
      connectionError={error} roles={roles} updateRoles={updateRoles} refreshPlacement={refreshPlacement}
      breakoutChoices={breakoutChoices} breakoutClosesAt={breakoutClosesAt} chooseBreakout={chooseBreakout} />
    <RoomAudioRenderer volume={prefs.speakerVolume} />
  </LiveKitRoom>;
}

function Tile({ participant, role, raised, mirror, showNames, pauseCamera }) {
  const publication = participant.getTrackPublication(Track.Source.Camera);
  const showVideo = !pauseCamera && publication?.track && !publication.isMuted;
  const name = participant.name || 'Guest';
  return <article className={'tile' + (participant.isSpeaking ? ' speaking' : '')}>
    {showVideo ? <VideoTrack className={participant.isLocal && mirror ? 'mirrored-video' : undefined}
      trackRef={{ participant, publication, source: Track.Source.Camera }} />
      : <span className="tile-avatar">{initials(name)}</span>}
    <div className="tile-label" hidden={!showNames && !raised && participant.isMicrophoneEnabled}>
      {raised && <Hand size={15} />} {showNames && <>{name}{participant.isLocal && ' (you)'}{role && <small>{role}</small>}</>}
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

function Call({ session, api, prefs, updatePrefs, onLeave, recap, connectionError, roles, updateRoles, refreshPlacement, breakoutChoices, breakoutClosesAt, chooseBreakout }) {
  const room = useRoomContext();
  const connection = useConnectionState();
  const { localParticipant, isCameraEnabled, isMicrophoneEnabled, isScreenShareEnabled } = useLocalParticipant();
  const participants = useParticipants();
  // Keep all tracks subscribed, including screen audio rendered by RoomAudioRenderer.
  const shares = useTracks([Track.Source.ScreenShare]);
  const sharedAudio = useTracks([Track.Source.ScreenShareAudio]);
  const [layout, setLayout] = useState(prefs.layout);
  const [panel, setPanel] = useState(session.meeting.isHost ? 'people' : '');
  const [error, setError] = useState('');
  const [toast, setToast] = useState(session.roomNotice || '');
  const [confirmation, setConfirmation] = useState(false);
  const [microphoneRequest, setMicrophoneRequest] = useState(false);
  const [requestingHelp, setRequestingHelp] = useState(false);
  const [settings, setSettings] = useState(false);
  const [shareOptions, setShareOptions] = useState(false);
  const [shareSound, setShareSound] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [audioShare, setAudioShare] = useState(false);
  const audioCapture = useRef(null);
  const shareMounted = useRef(false);
  useEffect(() => {
    shareMounted.current = true;
    return () => {
      shareMounted.current = false;
      audioCapture.current?.stop();
      audioCapture.current = null;
    };
  }, []);
  const [cameraBusy, setCameraBusy] = useState(false);
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
  const changingCamera = useRef(false);
  const chartEnd = useRef(null);
  const id = session.meeting.id;
  const { hostIdentity, hostVersion, coHosts } = roles;
  const host = localParticipant.identity ? localParticipant.identity === hostIdentity : session.meeting.isHost;
  const online = connection === ConnectionState.Connected;
  const ended = joinedAt != null && connection === ConnectionState.Disconnected;
  const collaboration = !session.meeting.encrypted && !session.accountless && !session.breakoutName;
  const meetingTools = !session.meeting.encrypted && !session.breakoutName;
  const delegates = new Map(coHosts.map(({ identity, sid }) => [identity, sid]));
  const isCoHost = participant => !!participant.sid && delegates.get(participant.identity) === participant.sid;
  const roleOf = participant => participant.identity === hostIdentity ? 'Host' : isCoHost(participant) ? 'Co-host' : '';
  const coHost = online && !host && meetingTools && !session.accountless && isCoHost(localParticipant);
  const canModerate = host || coHost;
  const canManageBreakouts = meetingTools && canModerate;
  const canOpenBreakouts = canManageBreakouts || breakoutChoices.length > 0;
  const pushToTalk = usePushToTalk(room, {
    key: prefs.pushToTalk, online, deviceId: prefs.microphoneId, reduceNoise: prefs.reduceNoise, onError: setError,
  });
  const microphoneTrack = isMicrophoneEnabled
    ? localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack : null;
  const captions = useManualCaptions(room, { enabled: meetingTools, hostIdentity, hostVersion, online, microphone: microphoneTrack, onCaption: recap.append });
  const recording = useMeetingRecording(room, { enabled: meetingTools, hostIdentity, host, meetingId: id });
  const cloudRecordingEnabled = meetingTools && session.cloudRecording === true;
  const cloudRecording = useCloudRecording({ enabled: cloudRecordingEnabled, meetingId: id, online, api });

  async function run(operation) {
    setError('');
    try { await operation(); return true; }
    catch (failure) { setError(failure.message || 'That action could not be completed.'); return false; }
  }
  async function askForHelp() {
    if (!online || requestingHelp) return;
    setRequestingHelp(true);
    try {
      await run(async () => {
        const { requested } = await api('/meetings/' + id + '/breakout-help', {
          method: 'POST', body: { key: session.routingKey },
        });
        setToast(requested ? 'Your room asked the host for help.' : 'Your room already has a pending help request.');
      });
    } finally { setRequestingHelp(false); }
  }

  useEffect(() => {
    if (!online || didInitialize.current) return;
    setJoinedAt(Date.now());
    didInitialize.current = true;
    run(async () => {
      const media = session.media ?? prefs;
      const results = await Promise.allSettled([
        media.microphone ? localParticipant.setMicrophoneEnabled(true, microphoneOptions(prefs)) : null,
        media.camera ? withCamera(() => setCamera(true)) : null,
        prefs.speakerId ? room.switchActiveDevice('audiooutput', prefs.speakerId) : null,
      ]);
      if (results[1].status === 'rejected' && prefs.background !== 'off') {
        throw new Error('The camera stayed off because its background could not be started.');
      }
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
    if (!canModerate || ended) return;
    const controller = new AbortController();
    let timer;
    async function update() {
      try {
        const result = await api('/meetings/' + id + '/lobby', { signal: controller.signal });
        if (!controller.signal.aborted) {
          setGuests(result.guests);
          setLocked(result.locked);
          updateRoles(result);
        }
      } catch (failure) { if (!controller.signal.aborted && failure.status === 401) setError(failure.message); }
      if (!controller.signal.aborted) timer = setTimeout(update, 4000);
    }
    update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, id, canModerate, ended, updateRoles]);

  useEffect(() => {
    setPanel(previous => (!canOpenBreakouts && previous === 'breakouts') || (!host && previous === 'recording') ? 'people' : previous);
  }, [canOpenBreakouts, host]);

  useEffect(() => {
    function receive(payload, participant, _kind, topic, _encryption, senderIdentity) {
      const serverPacket = !participant && !senderIdentity;
      if (serverPacket && topic === placementTopic) { refreshPlacement(); return; }
      if (serverPacket && topic === hostRolesTopic && payload.byteLength <= 256) {
        try { updateRoles(JSON.parse(decoder.decode(payload))); } catch { /* Ignore malformed role updates. */ }
        refreshPlacement();
        return;
      }
      if (serverPacket && topic === microphoneRequestTopic && meetingTools && payload.byteLength === 1 && payload[0] === 1) {
        if (!room.localParticipant.isMicrophoneEnabled) setMicrophoneRequest(true);
        return;
      }
      if (serverPacket && topic === breakoutMessageTopic && session.breakoutName && payload.byteLength <= 1200) {
        const text = decoder.decode(payload).trim();
        if (text && text.length <= 300) setToast('Host announcement · ' + text);
        return;
      }
      if (serverPacket && topic === breakoutHelpTopic && canModerate && meetingTools && payload.byteLength === 1 && payload[0] === 1) {
        setToast('A breakout room asked for help. Open Breakouts to see the request.');
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
  }, [room, refreshPlacement, session.breakoutName, meetingTools, canModerate, updateRoles]);
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
      const result = await api('/meetings/' + id + '/moderate', { method: 'POST', body: command });
      updateRoles(result);
      if (command.action === 'decide') setGuests(previous => previous.filter(guest => guest.identity !== command.identity));
      if (command.action === 'lock') setLocked(command.locked);
      if (command.action === 'mute-all') setToast('Attendee microphones muted.');
      if (command.action === 'ask-unmute') setToast('Microphone request sent.');
    });
  }

  async function moveToWaitingRoom(participant) {
    const name = participant.name || 'this participant';
    if (!window.confirm('Move ' + name + ' to the waiting room?')) return false;
    return moderate({ action: 'wait', identity: participant.identity });
  }

  async function transferHost(participant) {
    const name = participant.name || 'this participant';
    if (!window.confirm('Make ' + name + ' the host? You will become an attendee.')) return;
    await recording.finishForExit();
    if (await moderate({ action: 'transfer-host', identity: participant.identity, sid: participant.sid })) {
      setToast(name + ' is now the host.');
    }
  }

  async function exit(end) {
    pushToTalk.cancel();
    setExiting(true);
    await stopAudioShare();
    await recording.finishForExit();
    if (end && !(await moderate({ action: 'end' }))) { setExiting(false); return; }
    await room.disconnect().catch(() => {});
    if (document.fullscreenElement === document.documentElement) await document.exitFullscreen().catch(() => {});
    onLeave();
  }

  async function changeDevice({ key, kind }, deviceId) {
    if (key === 'camera') return withCamera(() => switchDevice(key, kind, deviceId));
    return switchDevice(key, kind, deviceId);
  }

  async function switchDevice(key, kind, deviceId) {
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
    if (pushToTalk.busy()) { pushToTalk.cancel(); return; }
    setMicrophoneRequest(false);
    return run(() => localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled, microphoneOptions(prefs)));
  }

  function toggleCamera() {
    if (changingCamera.current) return;
    return run(() => withCamera(() => setCamera(!isCameraEnabled)));
  }

  async function withCamera(operation) {
    if (changingCamera.current) throw new Error('The camera is already updating. Try again in a moment.');
    changingCamera.current = true;
    setCameraBusy(true);
    try { return await operation(); }
    finally { changingCamera.current = false; setCameraBusy(false); }
  }

  async function setCamera(enabled) {
    const existing = localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!enabled && existing?.getProcessor()) {
      await localParticipant.unpublishTrack(existing, true);
      return;
    }
    if (!enabled || existing || prefs.background === 'off') {
      await localParticipant.setCameraEnabled(enabled, captureOptions(prefs.cameraId));
      return;
    }
    const track = await createLocalVideoTrack(captureOptions(prefs.cameraId));
    try {
      await applyCameraBackground(track, prefs, setError);
      if (room.state !== ConnectionState.Connected) throw new Error('The meeting connection was interrupted.');
      await localParticipant.publishTrack(track, { source: Track.Source.Camera });
    } catch (failure) {
      track.stop();
      throw new Error('The camera stayed off because its background could not be started.', { cause: failure });
    }
  }

  function changeBackground(changes) {
    return withCamera(async () => {
      const publication = localParticipant.getTrackPublication(Track.Source.Camera);
      if (publication?.track) {
        if (publication.isMuted) await localParticipant.unpublishTrack(publication.track, true);
        else await applyCameraBackground(publication.track, { ...prefs, ...changes }, setError);
      }
      updatePrefs(changes);
    });
  }

  async function stopAudioShare(track = audioCapture.current) {
    if (!track || track !== audioCapture.current) return;
    audioCapture.current = null;
    track.stop();
    setAudioShare(false);
    await localParticipant.unpublishTrack(track, true).catch(() => {});
  }

  async function shareAudioOnly() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include', selfBrowserSurface: 'exclude',
    });
    const [track, ...extra] = stream.getAudioTracks();
    [...stream.getVideoTracks(), ...extra].forEach(source => source.stop());
    if (!track || track.readyState !== 'live' || !shareMounted.current || room.state !== ConnectionState.Connected) {
      stream.getTracks().forEach(source => source.stop());
      throw new Error('The selected source did not provide shareable audio.');
    }
    audioCapture.current = track;
    track.addEventListener('ended', () => { void stopAudioShare(track); }, { once: true });
    try {
      await localParticipant.publishTrack(track, { source: Track.Source.ScreenShareAudio });
      if (audioCapture.current !== track || track.readyState !== 'live') {
        throw new Error('The selected audio source stopped.');
      }
      setAudioShare(true);
    } catch (error) {
      if (audioCapture.current === track) await stopAudioShare(track);
      else await localParticipant.unpublishTrack(track, true).catch(() => {});
      throw error;
    }
  }

  async function startShare(soundOnly = false) {
    if (!online || sharing || isScreenShareEnabled || audioCapture.current) return;
    setShareOptions(false);
    setSharing(true);
    const preset = ScreenSharePresets.h1080fps15;
    const resolution = prefs.shareFps ? { ...preset.resolution, frameRate: prefs.shareFps } : undefined;
    const publishOptions = prefs.shareFps
      ? { screenShareEncoding: { ...preset.encoding, maxFramerate: prefs.shareFps } }
      : undefined;
    try {
      await run(async () => {
        if (soundOnly) { await shareAudioOnly(); return; }
        await localParticipant.setScreenShareEnabled(true, {
          audio: shareSound ? { restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
          systemAudio: shareSound ? 'include' : 'exclude', selfBrowserSurface: 'exclude',
          resolution, contentHint: prefs.shareHint || undefined,
        }, publishOptions);
        const audioTrack = localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track?.mediaStreamTrack;
        if (shareSound && audioTrack?.readyState !== 'live') setToast('Video is sharing. This source supplied no sound.');
      });
    } finally { setSharing(false); }
  }

  function toggleShare() {
    if (audioCapture.current) return stopAudioShare();
    if (isScreenShareEnabled) return run(() => localParticipant.setScreenShareEnabled(false));
    setShareSound(false);
    setShareOptions(true);
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
  const anyShareAudio = activeShare && sharedAudio.some(({ participant, publication }) =>
    participant.identity === activeShare.participant.identity && publication.track && !publication.isMuted);
  const stageClass = 'stage' + (activeShare ? ' with-share share-' + prefs.shareLayout : '');
  const hand = !!hands[localParticipant.identity];

  return <main className="call">
    <header className="call-header"><Logo /><div className="call-title"><strong>{session.meeting.title}</strong><span><i className="status-dot" />{ended ? 'Disconnected' : online ? 'Connected' : connection === ConnectionState.Reconnecting ? 'Reconnecting' : 'Connecting'}
      {online && prefs.meetingTimer && joinedAt && <ElapsedTime joinedAt={joinedAt} />}
    </span>{session.breakoutName && <span className="breakout-indicator">Breakout · {session.breakoutName}</span>}
      {session.breakoutName && <BreakoutCountdown closesAt={breakoutClosesAt} />}
      {coHost && <span className="breakout-indicator" role="status">You’re a co-host</span>}
      {online && host && hostVersion > 0 && <span className="breakout-indicator" role="status">You’re the host</span>}</div>
      <div className="call-header-actions">
        {session.meeting.encrypted && <span className="button subtle"><ShieldCheck size={16} /> Encrypted media</span>}
        {session.breakoutName && session.routingKey && <button className="button" disabled={!online || requestingHelp}
          onClick={askForHelp}>Ask for help</button>}
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
    {pushToTalk.status && <div className="call-notice" role="status">{pushToTalk.status}</div>}
    {session.breakoutName && online && <BreakoutVoicePlayback room={room} speakerId={prefs.speakerId} volume={prefs.speakerVolume} />}
    {online && microphoneRequest && !isMicrophoneEnabled && <div className="call-notice" role="status">
      <span>A moderator asked you to turn on your microphone.</span>
      <div className="meeting-tool-actions"><button className="button primary small" onClick={toggleMicrophone}>Turn on microphone</button>
        <button className="button small" onClick={() => setMicrophoneRequest(false)}>Dismiss request</button></div>
    </div>}
    {meetingTools && <RecordingBanner recording={recording} host={host} />}
    {cloudRecordingEnabled && <CloudRecordingBanner recording={cloudRecording} />}
    <div className="call-body">
      {reaction && <div className="reaction-toast" role="status"><span>{reaction.emoji}</span> {reaction.from}</div>}
      <div className="stage-wrap"><section className={stageClass} aria-label="Meeting stage">
        {!online && !participants.length ? <div className="empty"><Video size={28} /><strong>{ended ? 'Meeting connection closed' : 'Connecting to the room'}</strong></div> : null}
        {activeShare && <ScreenPresentation key={activeShare.publication.trackSid} room={room}
          share={activeShare} withSound={anyShareAudio} online={online} />}
        {online && !display.length && !activeShare && <div className="empty"><VideoOff size={28} /><strong>There are no visible participant tiles.</strong></div>}
        <div className="tile-grid" style={{ '--tiles': Math.min(3, Math.max(1, display.length)) }}>
          {display.map(participant => <Tile key={participant.identity} participant={participant}
            role={roleOf(participant)} raised={hands[participant.identity]} mirror={prefs.mirrorCamera}
            showNames={prefs.showNames} pauseCamera={prefs.pauseIncomingCameras && !participant.isLocal} />)}
        </div>
      </section>{meetingTools && !ended && <CaptionsOverlay captions={captions} prefs={prefs} />}</div>
      {panel && <aside className="call-side"><div className="dialog-head"><h2>{panelTitles[panel]}</h2><button className="icon-button" aria-label="Close panel" onClick={() => setPanel('')}><X size={18} /></button></div>
        {panel === 'people' && <>
          {canModerate && <div className="host-actions">
            <button className="button" onClick={() => moderate({ action: 'lock', locked: !locked })}>{locked ? <Lock size={16} /> : <LockOpen size={16} />}{locked ? 'Unlock room' : 'Lock room'}</button>
            <button className="button" disabled={!online} onClick={() => moderate({ action: 'mute-all' })}><MicOff size={16} /> Mute attendees</button>
          </div>}
          {canModerate && guests.length > 0 && <div className="waiting-list">
            <h3>Waiting room · {guests.length}</h3>
            {guests.map(guest => <div className="waiting-person" key={guest.identity}>
              <strong>{guest.name}{guest.accountless && <small>Unverified guest</small>}</strong>
              {guest.evicting ? <div><span role="status">Disconnecting…</span>
                <button className="button small" onClick={() => moderate({ action: 'wait', identity: guest.identity })}>Retry</button></div>
                : <div><button className="button primary small" onClick={() => moderate({ action: 'decide', identity: guest.identity, admit: true })}>Admit</button>
                  <button className="button small" onClick={() => moderate({ action: 'decide', identity: guest.identity, admit: false })}>Decline</button></div>}
            </div>)}
          </div>}
          <div className="people-list">{participants.map(participant => <div className="person" key={participant.identity}><span className="person-avatar">{initials(participant.name || 'Guest')}</span>
            <div><strong>{participant.name || 'Guest'}{participant.isLocal && ' (you)'}</strong>{roleOf(participant) && <small>{roleOf(participant)}</small>}{participant.identity.startsWith('guest_') && <small>Unverified guest</small>}</div>
            {hands[participant.identity] && <Hand size={16} />}
            {host && meetingTools && !participant.isLocal && !participant.identity.startsWith('guest_') && <button className="icon-button" disabled={!online || !participant.sid}
              title={isCoHost(participant) ? 'Revoke co-host access' : 'Make co-host'}
              aria-label={(isCoHost(participant) ? 'Revoke co-host access for ' : 'Make co-host: ') + participant.name}
              onClick={() => {
                const enabled = !isCoHost(participant);
                if (enabled && !window.confirm('Let ' + (participant.name || 'this participant') + ' manage attendees, the waiting room, and breakout rooms?')) return;
                moderate({ action: 'co-host', identity: participant.identity, sid: participant.sid, enabled });
              }}>
              {isCoHost(participant) ? <ShieldMinus size={17} /> : <ShieldPlus size={17} />}
            </button>}
            {host && meetingTools && !participant.isLocal && !participant.identity.startsWith('guest_') && <button className="icon-button"
              disabled={!online || !participant.sid} title="Transfer host" aria-label={'Transfer host to ' + participant.name}
              onClick={() => transferHost(participant)}><Crown size={17} /></button>}
            {canModerate && !participant.isLocal && (host || !roleOf(participant)) && <>
              {participant.isMicrophoneEnabled || !meetingTools
                ? <button className="icon-button" title="Mute participant" aria-label={'Mute ' + participant.name} onClick={() => moderate({ action: 'mute', identity: participant.identity })}><MicOff size={17} /></button>
                : <button className="icon-button" title="Ask to unmute" aria-label={'Ask ' + participant.name + ' to unmute'} onClick={() => moderate({ action: 'ask-unmute', identity: participant.identity })}><Mic size={17} /></button>}
              {participant.isCameraEnabled && <button className="icon-button" title="Stop camera" aria-label={'Stop camera for ' + participant.name}
                onClick={() => moderate({ action: 'stop-video', identity: participant.identity })}><VideoOff size={17} /></button>}
              {meetingTools && <button className="icon-button" title="Move to waiting room"
                aria-label={'Move ' + (participant.name || 'Guest') + ' to waiting room'}
                onClick={() => moveToWaitingRoom(participant)}><Hourglass size={17} /></button>}
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
        {panel === 'notes' && <Notes api={api} id={id} captionEntries={captions.entries} />}
        {panel === 'polls' && <Polls api={api} id={id} host={host} />}
        {panel === 'board' && <Whiteboard api={api} id={id} host={host} />}
        {panel === 'quality' && <CallStatistics room={room} online={online} />}
        {panel === 'captions' && <CaptionsPanel captions={captions} host={host} online={online} meetingId={id}
          openRecap={() => setPanel('recap')} />}
        {panel === 'recap' && meetingTools && <MeetingRecap recap={recap} online={online} />}
        {panel === 'recording' && host && <>
          <RecordingPanel recording={recording} participants={participants} online={online} />
          {cloudRecordingEnabled && <CloudRecordingPanel recording={cloudRecording} online={online} />}
        </>}
        {panel === 'breakouts' && canManageBreakouts && <BreakoutRooms api={api} meetingId={id} online={online} prefs={prefs}
          participants={participants.filter(participant => !roleOf(participant))}
          moveToWaitingRoom={moveToWaitingRoom}
          removeParticipant={identity => moderate({ action: 'remove', identity })} />}
        {panel === 'breakouts' && !canManageBreakouts && breakoutChoices.length > 0 && <ChooseBreakoutRoom
          rooms={breakoutChoices} roomId={session.roomId} meetingId={id} onChoose={chooseBreakout} />}
      </aside>}
    </div>
    <footer className="call-toolbar">
      <StartAudio label="Enable audio" className="button" />
      <button className="call-control" disabled={!online} aria-pressed={isMicrophoneEnabled} onClick={toggleMicrophone}>{isMicrophoneEnabled ? <Mic size={20} /> : <MicOff size={20} />}<span>{isMicrophoneEnabled ? 'Mute' : 'Unmute'}</span></button>
      <button className="call-control" disabled={!online || cameraBusy} aria-pressed={isCameraEnabled} onClick={toggleCamera}>{isCameraEnabled ? <Video size={20} /> : <VideoOff size={20} />}<span>Camera</span></button>
      <button className="call-control" disabled={!online || sharing} aria-pressed={isScreenShareEnabled || audioShare} onClick={toggleShare}><MonitorUp size={20} /><span>{audioShare ? 'Stop audio share' : isScreenShareEnabled ? 'Stop share' : 'Share'}</span></button>
      <button className="call-control" aria-pressed={panel === 'people'} onClick={() => togglePanel('people')}><Users size={20} /><span>People {participants.length + (canModerate ? guests.length : 0)}</span></button>
      <button className="call-control" aria-pressed={panel === 'chat'} onClick={() => togglePanel('chat')}><MessageSquare size={20} /><span>Chat</span></button>
      {meetingTools && <button className="call-control" aria-pressed={panel === 'captions'} onClick={() => togglePanel('captions')}><Captions size={20} /><span>{captions.automatic.active ? 'Captions on' : 'Captions'}</span></button>}
      {meetingTools && host && <button className="call-control" aria-pressed={panel === 'recording'} onClick={() => togglePanel('recording')}><CircleDot size={20} /><span>Record</span></button>}
      {canOpenBreakouts && <button className="call-control" disabled={!online}
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
      <CameraBackgroundFields prefs={prefs} onChange={changeBackground} />
      <div className="dialog-actions"><button className="button primary" onClick={() => setSettings(false)}>Done</button></div>
    </Dialog>}
    {shareOptions && <Dialog title="Share your screen" close={() => setShareOptions(false)}>
      <label className="check"><input type="checkbox" checked={shareSound} onChange={event => setShareSound(event.target.checked)} />
        <span><strong>Include sound</strong><small>{window.meetrixDesktop
          ? 'Choose a display to share its picture and system audio, including sounds from other apps.'
          : 'Your browser decides which screens or tabs can share audio.'}</small></span></label>
      <div className="dialog-actions"><button className="button" onClick={() => setShareOptions(false)}>Cancel</button>
        <button className="button" disabled={!online} onClick={() => startShare(true)}>Share audio only</button>
        <button className="button primary" disabled={!online} onClick={() => startShare()}>Choose source</button></div>
    </Dialog>}
    {viewOptions && <Dialog title="View preferences" close={() => setViewOptions(false)}>
      <CallViewOptions prefs={prefs} updatePrefs={updatePrefs} />
      <div className="dialog-actions"><button className="button primary" onClick={() => setViewOptions(false)}>Done</button></div>
    </Dialog>}
    {confirmation && <Dialog title="Leave the meeting?" close={() => setConfirmation(false)}>
      {host && !ended && <p className="muted"><ShieldCheck size={16} /> Ending the meeting disconnects everyone and closes its invite.</p>}
      {host && (recording.state?.phase === 'active' || recording.file || recording.saving) && <p className="muted">Meetrix will save your local recording before you leave.</p>}
      <div className="dialog-actions">
        <button className="button" disabled={exiting} onClick={() => exit(false)}>Leave room</button>
        {host && !ended && <button className="button danger" disabled={exiting} onClick={() => exit(true)}>End for everyone</button>}
      </div>
    </Dialog>}
  </main>;
}
