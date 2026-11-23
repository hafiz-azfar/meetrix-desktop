import { Track } from 'livekit-client';

const webmTypes = ['video/webm;codecs=vp8,opus', 'video/webm'];
const recordingLimit = 30 * 60 * 1000;
const byteLimit = 180 * 1024 * 1024;

function liveTrack(participant, source) {
  const publication = participant.getTrackPublication(source);
  const media = publication?.track?.mediaStreamTrack;
  return !publication?.isMuted && media?.readyState === 'live' ? media : null;
}

function fitVideo(context, video, x, y, width, height) {
  const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  context.drawImage(video, x + (width - w) / 2, y + (height - h) / 2, w, h);
}

export async function prepareRecorder(getParticipants, onLimit) {
  const type = webmTypes.find(value => globalThis.MediaRecorder?.isTypeSupported(value));
  if (!type || !globalThis.AudioContext || !HTMLCanvasElement.prototype.captureStream) {
    throw new Error('This device does not support WebM meeting recording.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 540;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Could not initialize meeting video recording.');

  const audio = new AudioContext();
  const sources = new Map();
  const videos = new Map();
  const chunks = [];
  let stream;
  let recorder;
  let interval;
  let deadline;
  let completion;
  let bytes = 0;
  let limitReached = false;

  function clearVideo(video) { video.srcObject = null; }

  function dispose() {
    clearInterval(interval);
    clearTimeout(deadline);
    for (const video of videos.values()) clearVideo(video);
    videos.clear();
    for (const node of sources.values()) node.disconnect();
    sources.clear();
    stream?.getTracks().forEach(track => track.stop());
    if (audio.state !== 'closed') void audio.close().catch(() => {});
  }

  function updateAudio(participants, mix) {
    const tracks = new Set(participants.flatMap(participant => [
      liveTrack(participant, Track.Source.Microphone), liveTrack(participant, Track.Source.ScreenShareAudio),
    ]).filter(Boolean));
    for (const [track, node] of sources) {
      if (tracks.has(track)) continue;
      node.disconnect();
      sources.delete(track);
    }
    for (const track of tracks) {
      if (sources.has(track)) continue;
      const node = audio.createMediaStreamSource(new MediaStream([track]));
      node.connect(mix);
      sources.set(track, node);
    }
  }

  function draw(participants) {
    const share = participants.find(participant => liveTrack(participant, Track.Source.ScreenShare));
    const tiles = share ? [share] : participants.slice(0, 9);
    const columns = Math.max(1, Math.ceil(Math.sqrt(tiles.length)));
    const width = canvas.width / columns;
    const height = canvas.height / Math.max(1, Math.ceil(tiles.length / columns));
    const visible = new Set();
    context.fillStyle = '#202438';
    context.fillRect(0, 0, canvas.width, canvas.height);
    tiles.forEach((participant, index) => {
      const track = liveTrack(participant, share ? Track.Source.ScreenShare : Track.Source.Camera);
      const x = (index % columns) * width;
      const y = Math.floor(index / columns) * height;
      context.fillStyle = '#292e48';
      context.fillRect(x + 2, y + 2, width - 4, height - 4);
      if (track) {
        visible.add(track);
        let video = videos.get(track);
        if (!video) {
          video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.srcObject = new MediaStream([track]);
          void video.play().catch(() => {});
          videos.set(track, video);
        }
        if (video.readyState >= 2 && !track.muted) fitVideo(context, video, x, y, width, height);
      }
      context.fillStyle = '#111423';
      context.fillRect(x + 2, y + height - 29, width - 4, 27);
      context.fillStyle = '#ffffff';
      context.font = '15px sans-serif';
      context.fillText(participant.name || 'Guest', x + 12, y + height - 10, width - 24);
    });
    for (const [track, video] of videos) {
      if (visible.has(track)) continue;
      clearVideo(video);
      videos.delete(track);
    }
  }

  try {
    const mix = audio.createMediaStreamDestination();
    stream = canvas.captureStream(15);
    mix.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 900_000 });
    await audio.resume();

    function update() {
      const participants = getParticipants();
      updateAudio(participants, mix);
      draw(participants);
    }

    function reachLimit(reason) {
      if (limitReached) return;
      limitReached = true;
      onLimit(reason);
    }

    return {
      start() {
        update();
        recorder.start(1000);
        completion = new Promise(resolve => {
          recorder.addEventListener('stop', () => {
            dispose();
            resolve(chunks.length ? new Blob(chunks, { type }) : null);
            chunks.length = 0;
          }, { once: true });
        });
        recorder.addEventListener('dataavailable', ({ data }) => {
          if (!data.size) return;
          chunks.push(data);
          bytes += data.size;
          if (bytes >= byteLimit) reachLimit('Recording reached the local file size limit.');
        });
        recorder.addEventListener('error', () => reachLimit('The device stopped recording.'));
        interval = setInterval(() => {
          try { update(); }
          catch { reachLimit('The device could not continue capturing meeting media.'); }
        }, 1000 / 15);
        deadline = setTimeout(() => reachLimit('Recording reached the 30-minute limit.'), recordingLimit);
      },
      async stop() {
        clearInterval(interval);
        clearTimeout(deadline);
        if (!completion) { dispose(); return null; }
        // Disconnect input immediately. The recorder emits its final chunk before stop.
        for (const node of sources.values()) node.disconnect();
        sources.clear();
        if (recorder.state !== 'inactive') recorder.stop();
        return completion;
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
