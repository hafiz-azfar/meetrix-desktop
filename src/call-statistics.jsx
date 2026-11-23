import React, { useEffect, useState } from 'react';
import { Track } from 'livekit-client';
import { download } from './api.js';

const sourceLabels = {
  [Track.Source.Microphone]: 'Microphone',
  [Track.Source.Camera]: 'Camera',
  [Track.Source.ScreenShare]: 'Shared screen',
  [Track.Source.ScreenShareAudio]: 'Shared audio',
};

function readSample(report, direction) {
  if (!report) return null;
  const receiving = direction === 'Received';
  let stream;
  let candidateRtt;
  const remoteReports = new Map();
  for (const row of report.values()) {
    if (row.type === (receiving ? 'inbound-rtp' : 'outbound-rtp') && !row.isRemote) {
      const bytes = receiving ? row.bytesReceived : row.bytesSent;
      if (Number.isFinite(bytes) && (!stream || bytes > stream.bytes)) stream = { row, bytes };
    }
    if (row.type === 'candidate-pair' && row.nominated && row.state === 'succeeded') {
      candidateRtt = row.currentRoundTripTime;
    }
    if (!receiving && row.type === 'remote-inbound-rtp') {
      if (row.localId) remoteReports.set(row.localId, row);
    }
  }
  if (!stream) return null;
  const { row, bytes } = stream;
  const remote = receiving ? null : report.get(row.remoteId) ?? remoteReports.get(row.id);
  const remoteRtt = remote?.type === 'remote-inbound-rtp' ? remote.roundTripTime : null;
  const jitter = receiving ? row.jitter : remote?.jitter;
  const millis = seconds => Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  const codec = report.get(row.codecId)?.mimeType;
  const packetsLost = Number.isFinite(row.packetsLost) ? Math.max(0, row.packetsLost) : null;
  const total = row.packetsReceived + packetsLost;
  return {
    streamId: row.id, bytes, timestamp: row.timestamp,
    roundTrip: millis(remoteRtt ?? candidateRtt), jitter: millis(jitter),
    codec: typeof codec === 'string' ? codec.split('/').at(-1) : null,
    loss: receiving && packetsLost != null && total > 0 ? 100 * packetsLost / total : null,
    resolution: row.frameWidth && row.frameHeight ? row.frameWidth + ' × ' + row.frameHeight : null,
    fps: Number.isFinite(row.framesPerSecond) ? Math.round(row.framesPerSecond) : null,
  };
}

function selectTracks(room) {
  const tracks = new Map();
  const participants = [room.localParticipant, ...room.remoteParticipants.values()];
  for (const participant of participants) {
    const direction = participant.isLocal ? 'Sent' : 'Received';
    for (const publication of participant.trackPublications.values()) {
      const label = sourceLabels[publication.source];
      const key = direction + ' ' + label;
      if (label && publication.track && !publication.isMuted && !tracks.has(key)) {
        tracks.set(key, { key, direction, label, publication });
      }
    }
  }
  return [...tracks.values()];
}

export function CallStatistics({ room, online }) {
  const [samples, setSamples] = useState([]);
  useEffect(() => {
    if (!online) return;
    let closed = false;
    let timer;
    let previous = new Map();
    async function refresh() {
      const current = new Map();
      const results = await Promise.allSettled(selectTracks(room).map(async track => {
        const sample = readSample(await track.publication.track.getRTCStatsReport(), track.direction);
        if (!sample) return null;
        const id = track.publication.trackSid + ':' + sample.streamId;
        const last = previous.get(id);
        current.set(id, sample);
        const elapsed = last && sample.timestamp - last.timestamp;
        const rate = elapsed > 0 && sample.bytes >= last.bytes ? Math.round((sample.bytes - last.bytes) * 8 / elapsed) : null;
        return { key: track.key, label: track.label, direction: track.direction, ...sample, rate };
      }));
      if (closed) return;
      previous = current;
      setSamples(results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []));
      timer = setTimeout(refresh, 1800);
    }
    refresh();
    return () => { closed = true; clearTimeout(timer); };
  }, [room, online]);

  function save() {
    const tracks = samples.map(({ label, direction, rate, roundTrip, loss, jitter, resolution, fps, codec }) => ({
      track: label, direction, bitrateKbps: rate, roundTripMs: roundTrip, packetLossPercent: loss,
      jitterMs: jitter, resolution, framesPerSecond: fps, codec,
    }));
    download('meetrix-call-statistics.json',
      JSON.stringify({ exportedAt: new Date().toISOString(), tracks }, null, 2), 'application/json');
  }

  return <div className="call-statistics">
    <p className="muted">Live samples from one active track of each type and direction.</p>
    {online && samples.length > 0 && <button type="button" className="button small" onClick={save}>Save call statistics</button>}
    {!online ? <p className="muted">Connection unavailable.</p> : samples.length === 0
      ? <p className="muted">Waiting for a camera, microphone, or screen share.</p>
      : samples.map(({ key, direction, label, rate, roundTrip, loss, jitter, resolution, fps, codec }) => <section key={key} className="stat-sample">
        <h3>{label} <small>{direction}</small></h3>
        <dl>
          <div><dt>Bitrate</dt><dd>{rate == null ? '—' : rate + ' kb/s'}</dd></div>
          <div><dt>Round trip</dt><dd>{roundTrip == null ? '—' : roundTrip + ' ms'}</dd></div>
          {jitter != null && <div><dt>Jitter</dt><dd>{jitter} ms</dd></div>}
          {codec && <div><dt>Codec</dt><dd>{codec}</dd></div>}
          {direction === 'Received' && <div><dt>Packet loss</dt><dd>{loss == null ? '—' : loss.toFixed(1) + '%'}</dd></div>}
          {resolution && <div><dt>Video</dt><dd>{resolution}{fps == null ? '' : ' at ' + fps + ' fps'}</dd></div>}
        </dl>
      </section>)}
  </div>;
}
