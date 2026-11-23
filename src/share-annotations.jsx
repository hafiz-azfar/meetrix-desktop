import React, { useEffect, useEffectEvent, useRef, useState } from 'react';
import { VideoTrack } from '@livekit/components-react';
import { ConnectionState, RoomEvent } from 'livekit-client';
import { Eraser, Pencil } from 'lucide-react';

const topic = 'meetrix.screen-annotations';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const maxStrokes = 48;
const maxPoints = 120;
const batchSize = 6;
const colors = { amber: '#ffc857', mint: '#72efb4', red: '#ff7184', white: '#f5f7ff' };

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validStroke(stroke) {
  return !!stroke && Object.hasOwn(colors, stroke.color) && Array.isArray(stroke.points) &&
    stroke.points.length > 0 && stroke.points.length <= maxPoints &&
    stroke.points.every(point => Array.isArray(point) && point.length === 2 &&
      point.every(value => integer(value) && value <= 1000));
}

function useAnnotations(room, share) {
  const { participant: presenter, publication } = share;
  const screen = publication.trackSid;
  const isPresenter = presenter.isLocal;
  const [state, setState] = useState({ revision: 0, round: 0, allowed: false });
  const [strokes, setStrokes] = useState([]);
  const [error, setError] = useState('');
  const policy = useRef(state);
  const history = useRef([]);
  const sequence = useRef(0);
  const lastRequest = useRef(new Map());
  const lastStroke = useRef(new Map());

  function publish(event, recipient) {
    return room.localParticipant.publishData(encoder.encode(JSON.stringify({ screen, ...event })), {
      reliable: true, topic, ...(recipient ? { destinationIdentities: [recipient] } : {}),
    });
  }

  function applyState(next) {
    if (next.revision < policy.current.revision || next.round < policy.current.round) return;
    if (next.round !== policy.current.round) replaceStrokes([]);
    policy.current = { revision: next.revision, round: next.round, allowed: next.allowed === true };
    setState(policy.current);
  }

  function replaceStrokes(next) {
    history.current = next;
    setStrokes(next);
  }

  function mergeStrokes(received) {
    const combined = new Map(history.current.map(stroke => [stroke.sequence, stroke]));
    for (const { sequence, color, points } of received) combined.set(sequence, { sequence, color, points });
    replaceStrokes([...combined.values()].sort((a, b) => a.sequence - b.sequence).slice(-maxStrokes));
  }

  async function relayStroke(stroke) {
    const accepted = { color: stroke.color, points: stroke.points, sequence: ++sequence.current };
    mergeStrokes([accepted]);
    await publish({ type: 'ink', round: policy.current.round, strokes: [accepted] });
  }

  async function synchronize(recipient) {
    const current = policy.current;
    const strokesAtRequest = history.current;
    await publish({ type: 'state', ...current }, recipient);
    for (let start = 0; start < strokesAtRequest.length; start += batchSize) {
      await publish({ type: 'ink', round: current.round, strokes: strokesAtRequest.slice(start, start + batchSize) }, recipient);
    }
  }

  function allowPacket(table, identity, interval) {
    const now = performance.now();
    if (now - (table.get(identity) ?? -Infinity) < interval) return false;
    table.set(identity, now);
    return true;
  }

  const receive = useEffectEvent((payload, participant, _kind, packetTopic) => {
    if (packetTopic !== topic || payload.byteLength > 11_000 || !participant ||
        room.remoteParticipants.get(participant.identity) !== participant) return;
    let packet;
    try { packet = JSON.parse(decoder.decode(payload)); } catch { return; }
    if (packet?.screen !== screen) return;

    if (isPresenter) {
      if (packet.type === 'sync' && allowPacket(lastRequest.current, participant.identity, 4000)) {
        void synchronize(participant.identity).catch(() => {});
      } else if (packet.type === 'draw' && policy.current.allowed && packet.revision === policy.current.revision &&
                 validStroke(packet.stroke) && allowPacket(lastStroke.current, participant.identity, 120)) {
        void relayStroke(packet.stroke).catch(() => {});
      }
      return;
    }

    if (participant.identity !== presenter.identity || participant.sid !== presenter.sid) return;
    if (packet.type === 'state' && integer(packet.revision) && integer(packet.round) && typeof packet.allowed === 'boolean') {
      applyState(packet);
    } else if (packet.type === 'ink' && packet.round === policy.current.round &&
               Array.isArray(packet.strokes) && packet.strokes.length <= batchSize &&
               packet.strokes.every(stroke => validStroke(stroke) && integer(stroke.sequence))) {
      mergeStrokes(packet.strokes);
    }
  });

  useEffect(() => {
    function onData(...args) { receive(...args); }
    function requestState() {
      if (isPresenter || room.state !== ConnectionState.Connected) return;
      const data = encoder.encode(JSON.stringify({ screen, type: 'sync' }));
      void room.localParticipant.publishData(data, {
        reliable: true, topic, destinationIdentities: [presenter.identity],
      }).catch(() => {});
    }
    function forget(participant) {
      lastRequest.current.delete(participant.identity);
      lastStroke.current.delete(participant.identity);
    }
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.Connected, requestState);
    room.on(RoomEvent.Reconnected, requestState);
    room.on(RoomEvent.ParticipantDisconnected, forget);
    requestState();
    const retry = setTimeout(requestState, 4500);
    return () => {
      clearTimeout(retry);
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.Connected, requestState);
      room.off(RoomEvent.Reconnected, requestState);
      room.off(RoomEvent.ParticipantDisconnected, forget);
    };
  }, [room, isPresenter, screen, presenter.identity]);

  async function change(patch) {
    if (!isPresenter || room.state !== ConnectionState.Connected) return;
    setError('');
    const next = { ...policy.current, ...patch, revision: policy.current.revision + 1 };
    applyState(next);
    try { await publish({ type: 'state', ...next }); }
    catch { setError('Could not update the shared annotations.'); }
  }

  async function draw(stroke) {
    if (room.state !== ConnectionState.Connected) return;
    setError('');
    try {
      if (isPresenter) await relayStroke(stroke);
      else if (policy.current.allowed) {
        await publish({ type: 'draw', revision: policy.current.revision, stroke }, presenter.identity);
      }
    } catch { setError('Could not send the annotation.'); }
  }

  return { isPresenter, canDraw: isPresenter || state.allowed, state, draw, change, strokes, error };
}

function containedVideo(video) {
  if (!video?.videoWidth || !video.videoHeight || !video.clientWidth || !video.clientHeight) return null;
  const scale = Math.min(video.clientWidth / video.videoWidth, video.clientHeight / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  return { width, height, left: (video.clientWidth - width) / 2, top: (video.clientHeight - height) / 2 };
}

export function ScreenPresentation({ room, share, withSound, online }) {
  const { isPresenter, canDraw, state, draw, change, strokes, error } = useAnnotations(room, share);
  const [drawing, setDrawing] = useState(false);
  const [color, setColor] = useState('amber');
  const [fit, setFit] = useState(null);
  const [draft, setDraft] = useState(null);
  const video = useRef(null);
  const canvas = useRef(null);
  const active = useRef(null);
  const editing = drawing && canDraw && online && fit !== null;

  useEffect(() => {
    const element = video.current;
    const inspect = () => setFit(containedVideo(element));
    const size = new ResizeObserver(inspect);
    size.observe(element);
    element.addEventListener('loadedmetadata', inspect);
    element.addEventListener('resize', inspect);
    inspect();
    return () => {
      size.disconnect();
      element.removeEventListener('loadedmetadata', inspect);
      element.removeEventListener('resize', inspect);
    };
  }, []);

  useEffect(() => {
    if (editing) return;
    active.current = null;
    setDraft(null);
    setDrawing(false);
  }, [editing]);

  useEffect(() => {
    const board = canvas.current;
    if (!board || !fit) return;
    const ratio = Math.min(window.devicePixelRatio, 2);
    const width = Math.max(1, Math.round(fit.width * ratio));
    const height = Math.max(1, Math.round(fit.height * ratio));
    if (board.width !== width) board.width = width;
    if (board.height !== height) board.height = height;
    const paint = board.getContext('2d');
    if (!paint) return;
    paint.clearRect(0, 0, board.width, board.height);
    paint.lineWidth = Math.max(3 * ratio, board.width * 0.004);
    paint.lineCap = 'round';
    paint.lineJoin = 'round';
    for (const stroke of draft ? [...strokes, draft] : strokes) {
      paint.strokeStyle = colors[stroke.color];
      paint.beginPath();
      stroke.points.forEach(([x, y], index) => {
        const left = x * board.width / 1000;
        const top = y * board.height / 1000;
        if (index === 0) paint.moveTo(left, top);
        paint.lineTo(left + (stroke.points.length === 1 ? 0.1 : 0), top);
      });
      paint.stroke();
    }
  }, [draft, fit, strokes]);

  function location(event) {
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
    const normalized = (value, size) => Math.max(0, Math.min(1000, Math.round(value / size * 1000)));
    return [normalized(event.clientX - left, width), normalized(event.clientY - top, height)];
  }

  function begin(event) {
    if (!editing || active.current || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    active.current = { pointer: event.pointerId, stroke: { color, points: [location(event)] } };
    setDraft(active.current.stroke);
  }

  function extend(event) {
    if (active.current?.pointer !== event.pointerId) return;
    const stroke = active.current.stroke;
    const point = location(event);
    const [x, y] = stroke.points.at(-1);
    if (stroke.points.length >= maxPoints || Math.hypot(point[0] - x, point[1] - y) < 4) return;
    active.current.stroke = { ...stroke, points: [...stroke.points, point] };
    setDraft(active.current.stroke);
  }

  function finish(event) {
    if (active.current?.pointer !== event.pointerId) return;
    const stroke = active.current.stroke;
    active.current = null;
    setDraft(null);
    if (editing && event.type === 'pointerup') void draw(stroke);
  }

  return <div className="share">
    <VideoTrack ref={video} trackRef={share} />
    {fit && <canvas className="share-ink" aria-label="Presentation annotation canvas"
      data-drawing={editing} style={fit} ref={canvas}
      onPointerDown={begin} onPointerMove={extend} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} />}
    <span className="share-label">{share.participant.name || 'Guest'} is sharing{withSound && ' with sound'}</span>
    {online && (canDraw || strokes.length > 0) && <div className="share-annotation-tools" aria-label="Presentation annotations">
      {canDraw && <button type="button" className="button small" disabled={!fit} aria-pressed={editing}
        onClick={() => setDrawing(previous => !previous)}><Pencil size={15} /> Annotate</button>}
      {editing && Object.entries(colors).map(([name, ink]) => <button type="button" className="swatch"
        key={name} title={name} aria-label={name + ' annotation pen'} aria-pressed={color === name}
        style={{ '--ink': ink }} onClick={() => setColor(name)} />)}
      {isPresenter && <button type="button" className="button small" aria-pressed={state.allowed}
        onClick={() => change({ allowed: !state.allowed })}>Allow attendee drawing</button>}
      {isPresenter && strokes.length > 0 && <button type="button" className="icon-button" aria-label="Clear annotations"
        title="Clear annotations" onClick={() => change({ round: state.round + 1 })}><Eraser size={17} /></button>}
    </div>}
    {error && <p className="share-annotation-error" role="alert">{error}</p>}
  </div>;
}
