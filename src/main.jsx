import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DoorOpen } from 'lucide-react';
import { ApproveDesktop, DesktopBrowserSignIn, DesktopSignOut, desktopRequest } from './desktop-auth.jsx';
import { SignInForm } from './insforge-sign-in.jsx';
import { GuestMeeting, Workspace } from './workspace.jsx';
import { Logo } from './ui.jsx';
import './style.css';

const isDesktop = Boolean(window.meetrixDesktop);
const params = new URLSearchParams(location.search);
const approvalPage = location.pathname === '/desktop-sign-in';
const requestId = params.get('request');
const validRequest = /^[A-Za-z0-9_-]{22}$/.test(requestId ?? '');
const joinCode = /^[A-Za-z0-9_-]{16}$/.test(params.get('m') ?? '') ? params.get('m') : null;
const continueTo = approvalPage ? '/desktop-sign-in?request=' + encodeURIComponent(requestId)
  : joinCode ? '/join?m=' + encodeURIComponent(joinCode) : '/';

function Login({ onSignedIn, onGuest }) {
  const [methods, setMethods] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const control = new AbortController();
    fetch('/api/auth/methods', { credentials: 'same-origin', cache: 'no-store', signal: control.signal })
      .then(response => {
        if (!response.ok) throw new Error('Could not reach the InsForge project.');
        return response.json();
      })
      .then(setMethods)
      .catch(failure => { if (!control.signal.aborted) setError(failure.message); });
    return () => control.abort();
  }, [retry]);
  return <main className="login">
    <section className="login-window" aria-label="Meetrix sign-in options">
      <header className="login-header"><Logo />{isDesktop && <span>Windows</span>}</header>
      <div className="login-actions">
        {error ? <section className="sign-in-card"><p className="error" role="alert">{error}</p>
          <button className="button" onClick={() => { setError(''); setRetry(count => count + 1); }}>Try again</button></section>
        : methods ? isDesktop ? <DesktopBrowserSignIn onSignedIn={onSignedIn} providers={methods.providers} />
          : <SignInForm methods={methods} continueTo={continueTo} onSignedIn={onSignedIn} />
        : <p role="status">Loading sign-in methods…</p>}
        {!approvalPage && <button className="button login-guest" onClick={onGuest}><DoorOpen size={17} /> Join as a guest</button>}
      </div>
    </section>
  </main>;
}

function App() {
  const [status, setStatus] = useState({});
  const [user, setUser] = useState(null);
  const [guest, setGuest] = useState(false);
  useEffect(() => {
    const control = new AbortController();
    Promise.all([
      fetch('/api/config', { credentials: 'same-origin', signal: control.signal })
        .then(response => { if (!response.ok) throw new Error(); return response.json(); }),
      desktopRequest('/session', { signal: control.signal }),
    ]).then(([config, session]) => {
      if (!control.signal.aborted) { setUser(session.user); setStatus({ config }); }
    }).catch(() => { if (!control.signal.aborted) setStatus({ error: 'Meetrix could not reach its server.' }); });
    return () => control.abort();
  }, []);
  if (approvalPage && (!validRequest || isDesktop)) return <div className="boot"><Logo /><p>Start sign-in from Meetrix for Windows.</p></div>;
  if (!status.config) {
    return <div className="boot"><Logo /><p role={status.error ? 'alert' : 'status'}>{status.error || 'Opening your workspace…'}</p>
      {status.error && <button className="button" onClick={() => location.reload()}>Try again</button>}</div>;
  }
  if (!user && guest) return <GuestMeeting code={joinCode || ''} onBack={() => setGuest(false)} />;
  if (!user) return <Login onSignedIn={isDesktop ? setUser : () => location.replace(continueTo)} onGuest={() => setGuest(true)} />;
  if (approvalPage) return <ApproveDesktop requestId={requestId} user={user} onSignedOut={setUser} />;
  return <Workspace config={status.config} user={user} accountControl={<DesktopSignOut onSignedOut={setUser} />} />;
}

createRoot(document.getElementById('root')).render(<App />);
