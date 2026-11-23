import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider, SignIn, SignUp, UserButton, useAuth, useUser } from '@clerk/react';
import { ArrowUpRight, CalendarDays, Mic, Video } from 'lucide-react';
import { ApproveDesktop, DesktopBrowserSignIn, DesktopSignOut, desktopRequest } from './desktop-auth.jsx';
import { Workspace } from './workspace.jsx';
import { Logo } from './ui.jsx';
import './style.css';

const isElectron = navigator.userAgent.includes('Electron/');
const params = new URLSearchParams(location.search);
const approvalPage = location.pathname === '/desktop-sign-in';
const requestId = params.get('request');
const validRequest = /^[A-Za-z0-9_-]{22}$/.test(requestId ?? '');

function Login({ browserSignIn }) {
  const joinCode = params.get('m');
  const suffix = joinCode ? '?m=' + encodeURIComponent(joinCode) : '';
  const pairingPath = '/desktop-sign-in?request=' + encodeURIComponent(requestId);
  const next = approvalPage ? pairingPath : joinCode ? '/join' + suffix : '/';
  const signingUp = location.pathname === '/sign-up' || (approvalPage && params.get('mode') === 'signup');
  const appearance = {
    elements: isElectron ? { socialButtons: { display: 'none' }, dividerRow: { display: 'none' } } : undefined,
    variables: { colorPrimary: '#b3f486', colorPrimaryForeground: '#122015', colorBackground: '#192220',
      colorInputBackground: '#111817', colorInputForeground: '#f4f7f2', colorForeground: '#f4f7f2',
      colorMutedForeground: '#abbab0', colorBorder: '#364641', borderRadius: '0.65rem' },
  };
  return <main className="login">
    <section className="login-intro">
      <Logo />
      <div className="login-story">
        <div className="hero-glyph" aria-hidden="true"><Video size={46} strokeWidth={1.2} /></div>
        <h1>{approvalPage ? 'Sign in to Meetrix for Windows.' : joinCode ? 'Join the conversation.' : 'Make room for a good meeting.'}</h1>
        <div className="login-features"><span><Video size={17} /> Video rooms</span><span><CalendarDays size={17} /> Scheduling</span><span><Mic size={17} /> Screen and audio controls</span></div>
      </div>
      <div className="login-caption">{isElectron || approvalPage ? 'Meetrix for Windows' : 'Meetrix'} <ArrowUpRight size={15} /></div>
    </section>
    <section className="login-form" aria-label={signingUp ? 'Create an account' : 'Sign in'}>
      <div className="sign-in-stack">
        {browserSignIn}
        {signingUp
          ? <SignUp routing="hash" signInUrl={approvalPage ? pairingPath : '/sign-in' + suffix} forceRedirectUrl={next} appearance={appearance} />
          : <SignIn routing="hash" signUpUrl={approvalPage ? pairingPath + '&mode=signup' : '/sign-up' + suffix}
            forceRedirectUrl={next} appearance={appearance} />}
      </div>
    </section>
  </main>;
}

function Access({ config }) {
  const auth = useAuth();
  const { user } = useUser();
  const browserSupported = !approvalPage && config.desktopBrowserSignIn && Boolean(window.meetrixDesktop);
  const [desktopUser, setDesktopUser] = useState(null);
  const [checking, setChecking] = useState(browserSupported);
  useEffect(() => {
    if (!browserSupported) return;
    const controller = new AbortController();
    desktopRequest('/session', { signal: controller.signal }).then(session => {
      if (!controller.signal.aborted) setDesktopUser(session.user);
    }).catch(() => {}).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [browserSupported]);

  if (approvalPage && (!validRequest || isElectron)) return <div className="boot"><Logo /><p>Start social sign-in from Meetrix for Windows.</p></div>;
  if (desktopUser) return <Workspace config={config} user={desktopUser} accountControl={<DesktopSignOut onSignedOut={setDesktopUser} />} />;
  if (!auth.isLoaded || checking) return <div className="boot"><Logo /><p>Connecting to Clerk…</p></div>;
  if (!auth.isSignedIn) return <Login browserSignIn={browserSupported && <DesktopBrowserSignIn onSignedIn={setDesktopUser} />} />;
  if (approvalPage) return <ApproveDesktop requestId={requestId} getToken={auth.getToken} user={user} />;
  return <Workspace config={config} getToken={auth.getToken} user={user} accountControl={<UserButton />} />;
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
