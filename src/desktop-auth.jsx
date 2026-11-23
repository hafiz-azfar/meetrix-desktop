import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Copy, LogOut } from 'lucide-react';
import { UserButton, useClerk } from '@clerk/react';
import { Logo } from './ui.jsx';

const endpoint = '/api/desktop-auth';

export async function desktopRequest(path, { body, token, signal } = {}) {
  const response = await fetch(endpoint + path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Could not complete desktop sign-in.'), { status: response.status });
  return result;
}

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function DesktopBrowserSignIn({ onSignedIn }) {
  const [attempt, setAttempt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!attempt) return;
    const controller = new AbortController();
    let timer;
    async function claim() {
      if (Date.now() >= attempt.expiresAt) {
        const existing = await desktopRequest('/session', { signal: controller.signal }).catch(() => null);
        if (controller.signal.aborted) return;
        if (existing?.user) onSignedIn(existing.user);
        else {
          setAttempt(null);
          setError('The pairing code expired. Start sign-in again.');
        }
        return;
      }
      try {
        const result = await desktopRequest('/requests/' + attempt.id + '/claim', {
          body: { verifier: attempt.verifier }, signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (result.user) { onSignedIn(result.user); return; }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure.status === 410) {
          const existing = await desktopRequest('/session', { signal: controller.signal }).catch(() => null);
          if (controller.signal.aborted) return;
          if (existing?.user) onSignedIn(existing.user);
          else { setAttempt(null); setError(failure.message); }
          return;
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(claim, 3000);
    }
    timer = setTimeout(claim, 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [attempt, onSignedIn]);

  async function start() {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      const request = await desktopRequest('/requests', { body: { challenge } });
      setAttempt({ ...request, verifier });
      await window.meetrixDesktop.openSignIn(request.id);
    } catch (failure) {
      setError(failure.message || 'Could not open your browser.');
    } finally { setLoading(false); }
  }

  return <section className="desktop-sign-in" aria-label="Social sign-in">
    {attempt ? <>
      <h2>Approve sign-in in your browser</h2>
      <p>Enter this code on the Meetrix approval page.</p>
      <div className="pairing-code-row"><output aria-label="Desktop pairing code" className="pairing-code">{attempt.code}</output>
        <button className="icon-button" title="Copy pairing code" aria-label="Copy pairing code" onClick={async () => {
          try { await navigator.clipboard.writeText(attempt.code); setMessage('Code copied.'); }
          catch { setMessage('Enter the code manually in your browser.'); }
        }}><Copy size={18} /></button></div>
      <div className="desktop-sign-in-actions">
        <button className="button" onClick={() => window.meetrixDesktop.openSignIn(attempt.id).catch(() => setError('Could not open your browser.'))}>Reopen browser <ArrowUpRight size={16} /></button>
        <button className="button subtle" onClick={() => { setAttempt(null); setMessage(''); setError(''); }}>Cancel</button>
      </div>
      {message && <p role="status">{message}</p>}
    </> : <button className="button primary desktop-social-button" disabled={loading} onClick={start}>
      {loading ? 'Opening browser…' : 'Continue with Google, Apple, or GitHub'} <ArrowUpRight size={17} />
    </button>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

export function ApproveDesktop({ requestId, getToken, user }) {
  const clerk = useClerk();
  const [status, setStatus] = useState('ready');
  const [error, setError] = useState('');
  const name = (user?.fullName || user?.username || user?.firstName || 'Participant').slice(0, 60);
  const email = user?.primaryEmailAddress?.emailAddress;

  async function submit(event) {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get('code');
    setStatus('submitting');
    setError('');
    try {
      const token = await getToken();
      if (!token) throw new Error('Sign in before approving the desktop app.');
      await desktopRequest('/requests/' + requestId + '/approve', { body: { code, name }, token });
      setStatus('done');
    } catch (failure) { setError(failure.message); setStatus('ready'); }
  }

  return <main className="browser-approval">
    <section className="approval-card">
      <Logo />
      {status === 'done' ? <>
        <h1>Desktop sign-in approved</h1>
        <p>You can close this tab and return to Meetrix for Windows.</p>
      </> : <>
        <h1>Sign in to Meetrix for Windows</h1>
        <div className="approval-account"><UserButton /><div><strong>{name}</strong>{email && <p>{email}</p>}</div></div>
        <p>Enter the code shown in your Meetrix app to approve this account on Windows.</p>
        <form className="form" onSubmit={submit}>
          <label htmlFor="approval-code">Code from Meetrix</label>
          <input id="approval-code" name="code" type="text" placeholder="ABCD-EFGH" minLength={8} maxLength={16}
            autoComplete="off" autoCapitalize="characters" spellCheck={false} required autoFocus />
          {error && <p className="error" role="alert">{error}</p>}
          <button className="button primary" disabled={status === 'submitting'}>{status === 'submitting' ? 'Approving…' : 'Approve desktop sign-in'}</button>
        </form>
        <button className="button subtle" onClick={() => clerk.signOut({ redirectUrl: location.pathname + location.search }).catch(() => setError('Could not switch accounts.'))}>Use a different account</button>
      </>}
    </section>
  </main>;
}

export function DesktopSignOut({ onSignedOut }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function signOut() {
    setBusy(true);
    setError('');
    try {
      await desktopRequest('/sign-out', { body: {} });
      onSignedOut(null);
    } catch (failure) { setError(failure.message); setBusy(false); }
  }
  return <>
    <button className="icon-button" title="Sign out" aria-label="Sign out" onClick={signOut} disabled={busy}><LogOut size={18} /></button>
    {error && <p className="desktop-sign-out-error" role="alert">{error}</p>}
  </>;
}
