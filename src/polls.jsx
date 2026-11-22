import React, { useEffect, useState } from 'react';

export function Polls({ api, id, host }) {
  const [poll, setPoll] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const path = '/meetings/' + id + '/poll';
  useEffect(() => {
    let stopped = false;
    let timer;
    async function read() {
      try {
        const current = await api(path);
        if (!stopped) { setPoll(current); setLoaded(true); }
      } catch (failure) { if (!stopped) setError(failure.message); }
      if (!stopped) timer = setTimeout(read, 3500);
    }
    read();
    return () => { stopped = true; clearTimeout(timer); };
  }, [api, path]);

  async function send(suffix, body) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setPoll(await api(path + suffix, { method: 'POST', body }));
      setDraft(false);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return <section className="polls">
    {!poll && <p className="muted">{loaded ? 'No active poll.' : 'Loading polls…'}</p>}
    {poll && <>
      <h3>{poll.question}</h3>
      <div className="poll-options">{poll.choices.map((choice, index) => <button className="button" key={choice}
        aria-pressed={poll.voted === index} disabled={busy || poll.voted !== null || poll.closed}
        onClick={() => send('/vote', { poll: poll.id, choice: index })}>
        <span>{choice}</span>{poll.totals && <strong>{poll.totals[index]}</strong>}
      </button>)}</div>
      {poll.closed ? <p className="muted">Poll closed</p> : poll.voted !== null && <p className="muted">Vote submitted</p>}
      {host && !poll.closed && <button className="button" disabled={busy} onClick={() => send('/close', { poll: poll.id })}>Close voting</button>}
    </>}
    {host && loaded && (!poll || poll.closed) && !draft && <button className="button primary" onClick={() => setDraft(true)}>Create poll</button>}
    {draft && <form className="form" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      send('', { question: data.get('question'), choices: data.getAll('choice').map(choice => choice.trim()).filter(Boolean) });
    }}>
      <label>Question<input name="question" required maxLength={200} autoFocus /></label>
      {[1, 2, 3, 4].map(number => <label key={number}>Option {number}<input name="choice" required={number <= 2} maxLength={80} /></label>)}
      <div className="notes-actions"><button className="button primary" disabled={busy}>Open voting</button><button type="button" className="button" onClick={() => setDraft(false)}>Cancel</button></div>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
