import { Room, RoomEvent } from 'livekit-client';
import { createEncryptedRoom } from '../src/encrypted-room.js';
import { generateRoomKey } from '../src/encryption.js';

window.generateRoomKey = generateRoomKey;
window.join = async (session, key) => {
  const secure = key ? await createEncryptedRoom(key) : null;
  const room = secure?.room || new Room();
  window.testRoom = room;
  window.messages = [];
  window.tracks = [];
  room.on(RoomEvent.DataReceived, data => window.messages.push(new TextDecoder().decode(data)));
  room.on(RoomEvent.TrackSubscribed, (track, publication) => {
    window.tracks.push({ kind: track.kind, encryption: publication.encryption });
    if (track.kind !== 'video') return;
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    document.body.append(video);
    track.attach(video);
    video.requestVideoFrameCallback(() => { window.receivedVideoFrame = true; });
  });
  await room.connect(session.serverUrl, session.token);
  return { connected: room.state, encrypted: room.localParticipant.isE2EEEnabled };
};
