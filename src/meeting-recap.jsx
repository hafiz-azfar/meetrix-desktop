import React from 'react';
import { download } from './api.js';

export function MeetingRecap({ recap, online = false, review = false }) {
  const { status, count, draft, progress } = recap;
  return <section className="summary-panel form" aria-label="Meeting recap">
    {!review && <h3>Meeting recap</h3>}
    {status === 'idle' && <>
      <p className="muted">Collect shared captions from now on and draft a recap on this device when you leave. Automatic captions work with speakers who opt in.</p>
      <div><button className="button small" disabled={!online} onClick={recap.start}>Start collecting captions</button></div>
    </>}
    {status === 'collecting' && <>
      <p role="status">{count ? count + (count === 1 ? ' caption line collected.' : ' caption lines collected.') : 'Collecting shared captions…'}</p>
      {recap.limited && <p className="muted">Collection reached its local limit.</p>}
      <div className="meeting-tool-actions">
        <button className="button small" disabled={!count} onClick={recap.finish}>Draft recap now</button>
        <button className="button small" onClick={() => {
          if (!count || window.confirm('Discard the captions collected for this recap?')) recap.discard();
        }}>Discard collection</button>
      </div>
    </>}
    {progress && <p role="status">{progress}</p>}
    {status === 'generating' && !review && <div><button className="button small" onClick={() => {
      if (window.confirm('Cancel and discard this recap?')) recap.discard();
    }}>Cancel recap</button></div>}
    {['ready', 'error'].includes(status) && <>
      {!!draft && <p className="muted">Review names, decisions, and next steps before sharing.</p>}
      <label>Recap draft<textarea rows={review ? 9 : 5} value={draft} maxLength={62000}
        onChange={event => recap.setDraft(event.target.value)} /></label>
      <div className="meeting-tool-actions">
        <button className="button primary small" disabled={!draft.trim()}
          onClick={() => download('meetrix-meeting-recap.txt', draft + '\n', 'text/plain;charset=utf-8')}>Download recap</button>
        {!review && <button className="button small" onClick={() => {
          if (window.confirm('Discard this recap draft?')) recap.discard();
        }}>Discard draft</button>}
      </div>
    </>}
  </section>;
}
