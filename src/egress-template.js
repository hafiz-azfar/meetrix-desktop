import { ConnectionState, Room, RoomEvent, Track } from 'livekit-client';
import './egress-template.css';

const params = new URL(location.href).searchParams;
const access = params.get('access');
const token = params.get('token');
history.replaceState(null, '', location.pathname);

const room = new Room({ adaptiveStream: false });
const gallery = document.querySelector('.recording-gallery');
const presentation = document.querySelector('.recording-presentation');
const rendered = new Map();
const sources = new Set([Track.Source.Camera, Track.Source.Microphone, Track.Source.ScreenShare, Track.Source.ScreenShareAudio]);
let approved;
let ended = false;

function hasConsent(participant) {
  return approved?.get(participant.identity) === participant.sid;
}

function rosterMatches() {
  const participants = [...room.remoteParticipants.values()];
  return !!approved && participants.length === approved.size && participants.every(hasConsent);
}

function detach(sid, item) {
  item.media.muted = true;
  item.track.detach(item.media);
  item.container.remove();
  rendered.delete(sid);
}

function endRecording() {
  if (ended) return;
  ended = true;
  for (const [sid, item] of rendered) detach(sid, item);
  gallery.replaceChildren();
  presentation.replaceChildren();
  console.log('END_RECORDING');
  void room.disconnect().catch(() => {});
}

function labelFor(participant) {
  const label = document.createElement('span');
  label.textContent = participant.name || 'Participant';
  return label;
}

function videoItem(participant) {
  const tile = document.createElement('div');
  const video = document.createElement('video');
  tile.className = 'recording-tile';
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  tile.append(video, labelFor(participant));
  return { container: tile, media: video };
}

function audioItem() {
  const audio = document.createElement('audio');
  audio.autoplay = true;
  document.body.append(audio);
  return { container: audio, media: audio };
}

function attach(participant, publication, target) {
  let item = rendered.get(publication.trackSid);
  if (item?.track !== publication.track) {
    if (item) detach(publication.trackSid, item);
    item = target ? videoItem(participant) : audioItem();
    item.track = publication.track;
    rendered.set(publication.trackSid, item);
    publication.track.attach(item.media);
    if (!target) void item.media.play().catch(endRecording);
  }
  if (target && item.container.parentNode !== target) target.append(item.container);
}

function render() {
  if (ended || room.state !== ConnectionState.Connected) return;
  if (!rosterMatches()) return endRecording();

  const used = new Set();
  let shares = 0;
  for (const participant of room.remoteParticipants.values()) {
    if (!hasConsent(participant)) continue;
    for (const publication of participant.trackPublications.values()) {
      if (!sources.has(publication.source)) continue;
      if (!publication.isDesired) publication.setSubscribed(true);
      if (!publication.track || publication.isMuted) continue;
      const share = publication.source === Track.Source.ScreenShare;
      if (share && shares++) continue;
      const target = publication.kind === Track.Kind.Video ? (share ? presentation : gallery) : null;
      attach(participant, publication, target);
      used.add(publication.trackSid);
    }
  }
  for (const [sid, item] of rendered) if (!used.has(sid)) detach(sid, item);
  presentation.hidden = shares === 0;
  gallery.style.setProperty('--columns', Math.max(1, Math.ceil(Math.sqrt(gallery.childElementCount))));
}

async function readAuthorization() {
  const response = await fetch('/api/recording-template', {
    credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(3000),
    headers: { Authorization: 'Bearer ' + access },
  });
  if (!response.ok) throw new Error('Recording authorization is no longer active.');
  return response.json();
}

async function checkAuthorization() {
  if (ended) return;
  try {
    const { participants } = await readAuthorization();
    if (participants.length !== approved.size ||
        participants.some(({ identity, sid }) => approved.get(identity) !== sid)) return endRecording();
    setTimeout(checkAuthorization, 1600);
  } catch { endRecording(); }
}

async function start() {
  if (!access || !token) return endRecording();
  try {
    const { participants, room: expectedRoom, serverUrl } = await readAuthorization();
    approved = new Map(participants.map(({ identity, sid }) => [identity, sid]));
    room.on(RoomEvent.Disconnected, endRecording);
    room.on(RoomEvent.Reconnecting, endRecording);
    room.on(RoomEvent.SignalReconnecting, endRecording);
    await room.connect(serverUrl, token, { autoSubscribe: false });
    if (room.name !== expectedRoom || !rosterMatches() || ended) return endRecording();
    const events = [RoomEvent.TrackPublished, RoomEvent.TrackSubscribed, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
      RoomEvent.TrackUnpublished, RoomEvent.TrackUnsubscribed, RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected];
    for (const event of events) room.on(event, render);
    render();
    if (!ended) {
      console.log('START_RECORDING');
      void checkAuthorization();
    }
  } catch { endRecording(); }
}

void start();
