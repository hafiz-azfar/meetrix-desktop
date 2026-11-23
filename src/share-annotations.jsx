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
const tools = { pen: 'Freehand', line: 'Line', arrow: 'Arrow', rectangle: 'Rectangle', ellipse: 'Ellipse', text: 'Text' };
const maxText = 80;
const colors = { amber: '#ffc857', mint: '#72efb4', red: '#ff7184', white: '#f5f7ff' };

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validStroke(stroke) {
  if (!stroke || !Object.hasOwn(colors, stroke.color) || !Array.isArray(stroke.points) ||
      !stroke.points.length || stroke.points.length > maxPoints ||
      !stroke.points.every(point => Array.isArray(point) && point.length === 2 &&
        point.every(value => integer(value) && value <= 1000))) return false;
  const tool = stroke.tool ?? 'pen';
  if (!Object.hasOwn(tools, tool)) return false;
  if (tool === 'pen') return true;
  if (tool === 'text') return stroke.points.length === 1 && typeof stroke.text === 'string' &&
    stroke.text.trim().length > 0 && stroke.text.length <= maxText;
  return stroke.points.length === 2;
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
    for (const stroke of received) combined.set(stroke.sequence, stroke);
    replaceStrokes([...combined.values()].sort((a, b) => a.sequence - b.sequence).slice(-maxStrokes));
  }

  async function relayStroke(stroke) {
    const { color, points, tool } = stroke;
    const accepted = { color, points, tool, text: tool === 'text' ? stroke.text : undefined, sequence: ++sequence.current };
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

function paintAnnotation(context, annotation, width, height) {
  const points = annotation.points.map(([x, y]) => [x * width / 1000, y * height / 1000]);
  const [x, y] = points[0];
  const [endX, endY] = points.at(-1);
  context.strokeStyle = context.fillStyle = colors[annotation.color];
  context.beginPath();
  switch (annotation.tool) {
    case 'text': {
      const fontSize = Math.max(13, width * .021);
      context.font = '600 ' + fontSize + 'px system-ui';
      context.textBaseline = 'top';
      const left = Math.min(x, Math.max(0, width - context.measureText(annotation.text).width));
      context.fillText(annotation.text, left, Math.max(0, Math.min(y, height - fontSize)), width);
      return;
    }
    case 'rectangle':
      context.rect(x, y, endX - x, endY - y);
      break;
    case 'ellipse':
      context.ellipse((x + endX) / 2, (y + endY) / 2,
        Math.abs(x - endX) / 2, Math.abs(y - endY) / 2, 0, 0, 2 * Math.PI);
      break;
    case 'arrow': {
      const angle = Math.atan2(endY - y, endX - x);
      const tip = Math.min(Math.hypot(endX - x, endY - y) / 2, context.lineWidth * 5);
      context.moveTo(x, y);
      context.lineTo(endX, endY);
      for (const offset of [-Math.PI / 6, Math.PI / 6]) {
        context.moveTo(endX, endY);
        context.lineTo(endX - tip * Math.cos(angle + offset), endY - tip * Math.sin(angle + offset));
      }
      break;
    }
    default:
      context.moveTo(x, y);
      if (points.length === 1) context.lineTo(x + .1, y);
      else for (const [left, top] of points.slice(1)) context.lineTo(left, top);
  }
  context.stroke();
}

export function ScreenPresentation({ room, share, withSound, online }) {
  const { isPresenter, canDraw, state, draw, change, strokes, error } = useAnnotations(room, share);
  const [drawing, setDrawing] = useState(false);
  const [color, setColor] = useState('amber');
  const [tool, setTool] = useState('pen');
  const [text, setText] = useState('');
  const [saveError, setSaveError] = useState('');
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
    for (const stroke of draft ? [...strokes, draft] : strokes) paintAnnotation(paint, stroke, width, height);
  }, [draft, fit, strokes]);

  function location(event) {
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
    const normalized = (value, size) => Math.max(0, Math.min(1000, Math.round(value / size * 1000)));
    return [normalized(event.clientX - left, width), normalized(event.clientY - top, height)];
  }

  function begin(event) {
    if (!editing || active.current || event.button !== 0) return;
    const point = location(event);
    if (tool === 'text') {
      if (text.trim()) { void draw({ tool, color, text: text.trim(), points: [point] }); setText(''); }
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    active.current = { pointer: event.pointerId, stroke: { color, tool, points: tool === 'pen' ? [point] : [point, point] } };
    setDraft(active.current.stroke);
  }

  function extend(event) {
    if (active.current?.pointer !== event.pointerId) return;
    const stroke = active.current.stroke;
    const point = location(event);
    if (stroke.tool !== 'pen') {
      active.current.stroke = { ...stroke, points: [stroke.points[0], point] };
      setDraft(active.current.stroke);
      return;
    }
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
    if (editing && event.type === 'pointerup') void draw(stroke.tool === 'pen'
      ? stroke : { ...stroke, points: [stroke.points[0], location(event)] });
  }

  function saveSnapshot() {
    const source = video.current;
    if (!source || source.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      setSaveError('Wait for the shared video before saving.');
      return;
    }
    setSaveError('');
    const snapshot = document.createElement('canvas');
    const scale = Math.min(1, 1920 / Math.max(source.videoWidth, source.videoHeight));
    snapshot.width = Math.round(source.videoWidth * scale);
    snapshot.height = Math.round(source.videoHeight * scale);
    try {
      const paint = snapshot.getContext('2d');
      paint.drawImage(source, 0, 0, snapshot.width, snapshot.height);
      paint.lineWidth = Math.max(3, snapshot.width * .004);
      paint.lineCap = paint.lineJoin = 'round';
      for (const stroke of strokes) paintAnnotation(paint, stroke, snapshot.width, snapshot.height);
      const link = document.createElement('a');
      link.href = snapshot.toDataURL('image/png');
      link.download = 'meetrix-presentation.png';
      link.click();
    } catch { setSaveError('Could not save the annotated presentation.'); }
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
      {editing && <select className="annotation-field" aria-label="Annotation tool" value={tool} onChange={event => setTool(event.target.value)}>
        {Object.entries(tools).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select>}
      {editing && tool === 'text' && <input className="annotation-field" aria-label="Annotation text"
        placeholder="Type, then click on the share" value={text} maxLength={maxText} onChange={event => setText(event.target.value)} />}
      {editing && Object.entries(colors).map(([name, ink]) => <button type="button" className="swatch"
        key={name} title={name} aria-label={name + ' annotation pen'} aria-pressed={color === name}
        style={{ '--ink': ink }} onClick={() => setColor(name)} />)}
      {isPresenter && <button type="button" className="button small" aria-pressed={state.allowed}
        onClick={() => change({ allowed: !state.allowed })}>Allow attendee drawing</button>}
      {isPresenter && strokes.length > 0 && <button type="button" className="button small" onClick={saveSnapshot}>Save annotated image</button>}
      {isPresenter && strokes.length > 0 && <button type="button" className="icon-button" aria-label="Clear annotations"
        title="Clear annotations" onClick={() => change({ round: state.round + 1 })}><Eraser size={17} /></button>}
    </div>}
    {(error || saveError) && <p className="share-annotation-error" role="alert">{error || saveError}</p>}
  </div>;
}
