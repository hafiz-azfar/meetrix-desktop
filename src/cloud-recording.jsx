import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { Dialog } from './ui.jsx';

function RecordingDownload({ id }) {
  return <a className="button" href={'/api/cloud-recordings/' + encodeURIComponent(id) + '/download'} download>
    <ArrowDownToLine size={16} /> Download MP4</a>;
}

export function CloudRecordingLibrary({ api, close }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api('/cloud-recordings', { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setFiles(data);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    return () => controller.abort();
  }, [api]);

  return <Dialog title="Cloud recordings" close={close}>
    {error ? <p role="alert">{error}</p> : files === null ? <p role="status">Loading recordings…</p>
      : files.length === 0 ? <p>No completed cloud recordings.</p>
        : <ul className="cloud-recording-library">{files.map(file => <li key={file.id}>
          <div><strong>{file.title}</strong><br /><time dateTime={new Date(file.startedAt).toISOString()}>
            {new Date(file.startedAt).toLocaleString()}</time></div>
          <RecordingDownload id={file.id} />
        </li>)}</ul>}
  </Dialog>;
}

export function useCloudRecording({ enabled, meetingId, online, api }) {
  const path = '/meetings/' + meetingId + '/cloud-recording';
  const [snapshot, setSnapshot] = useState({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const command = useRef(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled || !online) return;
    const controller = new AbortController();
    let timer;

    async function read() {
      const requested = generation.current;
      try {
        const result = await api(path, { signal: controller.signal });
        if (!controller.signal.aborted && !command.current && generation.current === requested) setSnapshot(result);
      } catch { /* Actions report errors. Polling can recover from a brief outage. */ }
      if (!controller.signal.aborted) timer = setTimeout(read, 2500);
    }
    read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, path, online, enabled]);

  useEffect(() => () => command.current?.abort(), [path, enabled, online]);

  async function change(action, fields) {
    if (!enabled || !online || command.current) return;
    const controller = new AbortController();
    const next = ++generation.current;
    command.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await api(path, {
        method: 'POST', body: { action, ...fields }, signal: controller.signal,
      });
      if (!controller.signal.aborted) setSnapshot(result);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || 'Cloud recording could not be updated.');
    } finally {
      if (generation.current === next) {
        generation.current++;
        command.current = null;
        setBusy(false);
      }
    }
  }

  return { snapshot: enabled && online ? snapshot : { state: 'idle' }, busy, error, change };
}

export function CloudRecordingBanner({ recording }) {
  const { snapshot, change, busy, error } = recording;
  const { state, id, canConsent, consent } = snapshot;
  if (!['requesting', 'recording', 'stopping'].includes(state)) return null;
  const message = state === 'requesting'
    ? 'The host requested cloud recording.'
    : state === 'recording' ? 'Cloud recording is active.' : 'Cloud recording is ending.';
  return <div className="recording-banner" data-active={state === 'recording'}>
    <p role="status"><strong>{message}</strong>
      {canConsent && state === 'requesting' && <span>{consent === true ? 'You approved.' : consent === false ? 'You declined.' : 'Your approval is required before recording begins.'}</span>}
      {error && <span>{error}</span>}
    </p>
    {canConsent && <div className="meeting-tool-actions">
      {state === 'requesting' && consent !== true && <button type="button" className="button primary small" disabled={busy}
        onClick={() => change('consent', { id, allow: true })}>Allow cloud recording</button>}
      {state !== 'stopping' && consent !== false && <button type="button" className="button small" disabled={busy}
        onClick={() => change('consent', { id, allow: false })}>{consent === true ? 'Withdraw cloud consent' : 'Decline cloud recording'}</button>}
    </div>}
  </div>;
}

export function CloudRecordingPanel({ recording, online }) {
  const { snapshot, change, busy, error } = recording;
  const { state, id, total, approved, canStart, file, reason } = snapshot;
  return <section className="meeting-tool-panel cloud-recording-panel" aria-label="Cloud recording">
    <h3>Cloud recording</h3>
    <p className="muted">Record this meeting to your workspace’s private storage. Every participant must approve before recording starts.</p>
    {error && <p role="alert">{error}</p>}
    {reason && <p role="status">{reason}</p>}
    {state === 'requesting' && <>
      <p role="status">{approved} of {total} approved</p>
      <div className="meeting-tool-actions">
        <button type="button" className="button primary" disabled={busy || !online || !canStart}
          onClick={() => change('start', { id })}>Start cloud recording</button>
        <button type="button" className="button" disabled={busy || !online}
          onClick={() => change('stop', { id })}>Cancel cloud request</button>
      </div>
    </>}
    {state === 'recording' && <button type="button" className="button danger" disabled={busy || !online}
      onClick={() => change('stop', { id })}>Stop cloud recording</button>}
    {state === 'stopping' && <p role="status">Finalizing cloud recording…</p>}
    {state === 'ready' && <><p role="status">Cloud recording finished.</p>{file && <RecordingDownload id={id} />}</>}
    {['idle', 'ready', 'failed'].includes(state) && <button type="button" className="button" disabled={busy || !online}
      onClick={() => change('request')}>Request cloud recording</button>}
  </section>;
}
