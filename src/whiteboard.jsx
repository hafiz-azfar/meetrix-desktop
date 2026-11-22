import React, { useEffect, useRef, useState } from 'react';

const colors = { mint: '#b8f38c', sky: '#95ccfa', peach: '#ffb397', white: '#f5f7f4' };

export function Whiteboard({ api, id, host }) {
  const [strokes, setStrokes] = useState([]);
  const [color, setColor] = useState('mint');
  const [drawing, setDrawing] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const canvas = useRef(null);
  const active = useRef(null);
  const latest = useRef(-1);
  const path = '/meetings/' + id + '/board';

  function accept(result) {
    if (!result || result.version < latest.current) return;
    latest.current = result.version;
    setStrokes(result.strokes);
  }

  useEffect(() => {
    let stopped = false;
    let timer;
    async function read() {
      try {
        const result = await api(path + '?since=' + latest.current);
        if (!stopped) accept(result);
      } catch (failure) { if (!stopped) setError(failure.message); }
      if (!stopped) timer = setTimeout(read, 2500);
    }
    read();
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, path]);

  useEffect(() => {
    const board = canvas.current;
    const ctx = board.getContext('2d');
    ctx.fillStyle = '#101715';
    ctx.fillRect(0, 0, board.width, board.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    for (const { color, points } of drawing ? [...strokes, drawing] : strokes) {
      ctx.strokeStyle = colors[color];
      ctx.beginPath();
      ctx.moveTo(points[0][0] * board.width, points[0][1] * board.height);
      for (const [x, y] of points) ctx.lineTo(x * board.width, y * board.height);
      if (points.length === 1) ctx.lineTo(points[0][0] * board.width + .1, points[0][1] * board.height + .1);
      ctx.stroke();
    }
  }, [drawing, strokes]);

  function point(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const clamp = value => Number(Math.max(0, Math.min(1, value)).toFixed(4));
    return [clamp((event.clientX - bounds.left) / bounds.width), clamp((event.clientY - bounds.top) / bounds.height)];
  }

  function begin(event) {
    if (active.current || saving || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    active.current = { pointer: event.pointerId, stroke: { color, points: [point(event)] } };
    setDrawing(active.current.stroke);
  }

  function extend(event) {
    if (active.current?.pointer !== event.pointerId) return;
    const { stroke } = active.current;
    const [x, y] = point(event);
    const [priorX, priorY] = stroke.points.at(-1);
    if (Math.hypot(x - priorX, y - priorY) < 0.004) return;
    if (stroke.points.length >= 192) return;
    active.current.stroke = { ...stroke, points: [...stroke.points, [x, y]] };
    setDrawing(active.current.stroke);
  }

  async function change(method, body) {
    setSaving(true);
    setError('');
    try { accept(await api(path, { method, body })); }
    catch (failure) { setError(failure.message); }
    finally { setSaving(false); setDrawing(null); }
  }

  async function finish(event) {
    if (active.current?.pointer !== event.pointerId) return;
    const { stroke } = active.current;
    active.current = null;
    if (event.type === 'pointercancel') { setDrawing(null); return; }
    await change('POST', stroke);
  }

  return <section className="whiteboard">
    <span className="muted">Draw on the shared canvas.</span>
    <div className="board-tools">{Object.entries(colors).map(([name, fill]) => <button type="button" key={name} className="swatch"
      title={name} aria-label={name + ' pen'} aria-pressed={color === name} style={{ '--ink': fill }} onClick={() => setColor(name)} />)}</div>
    <canvas width={900} height={600} aria-label="Shared drawing area" ref={canvas} onPointerDown={begin}
      onPointerMove={extend} onPointerUp={finish} onPointerCancel={finish} />
    <div className="notes-actions">
      <button className="button" disabled={!strokes.length} onClick={() => {
        const link = document.createElement('a');
        link.download = 'meetrix-whiteboard.png';
        link.href = canvas.current.toDataURL('image/png');
        link.click();
      }}>Export image</button>
      {host && <button className="button" disabled={saving || !strokes.length} onClick={() => {
        if (window.confirm('Clear this whiteboard for everyone?')) change('DELETE', {});
      }}>Clear board</button>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
