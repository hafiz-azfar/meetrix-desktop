import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider, SignIn, SignUp, useAuth } from '@clerk/react';
import { ArrowUpRight, CalendarDays, Mic, Video } from 'lucide-react';
import { Workspace } from './workspace.jsx';
import { Logo } from './ui.jsx';
import './style.css';

function Login({ config }) {
  const desktop = navigator.userAgent.includes('Electron/');
  const joinCode = new URLSearchParams(location.search).get('m');
  const suffix = joinCode ? '?m=' + encodeURIComponent(joinCode) : '';
  const next = joinCode ? '/join' + suffix : '/';
  const signingUp = location.pathname === '/sign-up';
  const appearance = {
    elements: desktop ? { socialButtons: { display: 'none' }, dividerRow: { display: 'none' } } : undefined,
    variables: { colorPrimary: '#b3f486', colorPrimaryForeground: '#122015', colorBackground: '#192220',
      colorInputBackground: '#111817', colorInputForeground: '#f4f7f2', colorForeground: '#f4f7f2',
      colorMutedForeground: '#abbab0', colorBorder: '#364641', borderRadius: '0.65rem' },
  };
  return <main className="login">
    <section className="login-intro">
      <Logo />
      <div className="login-story">
        <div className="hero-glyph" aria-hidden="true"><Video size={46} strokeWidth={1.2} /></div>
        <h1>{joinCode ? 'Join the conversation.' : 'Make room for a good meeting.'}</h1>
        <div className="login-features"><span><Video size={17} /> Video rooms</span><span><CalendarDays size={17} /> Scheduling</span><span><Mic size={17} /> Screen and audio controls</span></div>
      </div>
      <div className="login-caption">{desktop ? 'Meetrix for Windows' : 'Meetrix'} <ArrowUpRight size={15} /></div>
    </section>
    <section className="login-form" aria-label={signingUp ? 'Create an account' : 'Sign in'}>
      {signingUp
        ? <SignUp routing="hash" signInUrl={'/sign-in' + suffix} forceRedirectUrl={next} appearance={appearance} />
        : <SignIn routing="hash" signUpUrl={'/sign-up' + suffix} forceRedirectUrl={next} appearance={appearance} />}
    </section>
  </main>;
}

function Access({ config }) {
  const auth = useAuth();
  if (!auth.isLoaded) return <div className="boot"><Logo /><p>Connecting to Clerk…</p></div>;
  if (!auth.isSignedIn) return <Login config={config} />;
  return <Workspace config={config} getToken={auth.getToken} />;
}

function App() {
  const [status, setStatus] = useState({});
  useEffect(() => {
    fetch('/api/config', { credentials: 'omit' })
      .then(response => { if (!response.ok) throw new Error('Network error'); return response.json(); })
      .then(config => setStatus({ config }))
      .catch(() => setStatus({ error: 'Meetrix could not reach its server.' }));
  }, []);
  if (!status.config) {
    return <div className="boot"><Logo /><p role={status.error ? 'alert' : 'status'}>{status.error || 'Opening your workspace…'}</p>
      {status.error && <button className="button" onClick={() => location.reload()}>Try again</button>}</div>;
  }
  return <ClerkProvider publishableKey={status.config.clerkPublishableKey} afterSignOutUrl="/">
    <Access config={status.config} />
  </ClerkProvider>;
}

createRoot(document.getElementById('root')).render(<App />);
