import React, { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';

export function SignInForm({ methods, continueTo, onSignedIn }) {
  const [codeSent, setCodeSent] = useState(false);
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState('');
  const [usePassword, setUsePassword] = useState(!methods.emailOtp);
  const [error, setError] = useState(new URLSearchParams(location.search).has('auth_error')
    ? 'Sign-in could not be completed. Try again.' : '');

  async function request(path, body) {
    const response = await fetch('/api/auth' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      cache: 'no-store', credentials: 'same-origin', body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not sign in.');
    return result;
  }

  async function social(provider) {
    setPending(provider);
    setError('');
    try {
      const { url } = await request('/oauth', { provider, next: continueTo });
      location.assign(url);
    } catch (failure) { setError(failure.message); setPending(''); }
  }

  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending('email');
    setError('');
    try {
      if (usePassword) {
        await request('/email/password', { email, password: form.get('password') });
        onSignedIn();
      } else if (codeSent) {
        await request('/email/verify', { email, otp: form.get('otp') });
        onSignedIn();
      } else {
        await request('/email/send', { email });
        setCodeSent(true);
      }
    } catch (failure) { setError(failure.message); }
    finally { setPending(''); }
  }

  return <section className="sign-in-card" aria-label="Sign in">
    <h2>Sign in to Meetrix</h2>
    {methods.providers.length > 0 && <div className="provider-actions">
      {methods.providers.map(({ key, name }) => <button className="button" type="button" key={key}
        disabled={!!pending} onClick={() => social(key)}>Continue with {name} <ArrowUpRight size={16} /></button>)}
    </div>}
    {(methods.emailOtp || methods.emailPassword) && <form className="form email-sign-in" onSubmit={submit}>
      <label htmlFor="email">Email address</label>
      <input id="email" type="email" name="email" maxLength={254} autoComplete="email" required readOnly={codeSent}
        value={email} onChange={event => setEmail(event.target.value)} />
      {usePassword && <>
        <label htmlFor="password">Password</label>
        <input id="password" type="password" name="password" autoComplete="current-password" maxLength={256} required />
      </>}
      {!usePassword && codeSent && <>
        <p role="status">Enter the six-digit code from your email.</p>
        <label htmlFor="email-code">Email code</label>
        <input id="email-code" type="text" name="otp" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoFocus />
      </>}
      <button className="button primary" type="submit" disabled={!!pending}>
        {pending === 'email' ? 'Please wait…' : usePassword || codeSent ? 'Sign in' : 'Send a code'}
      </button>
      {codeSent && <button className="button subtle" type="button" onClick={() => { setCodeSent(false); setError(''); }}>Use a different email</button>}
      {methods.emailOtp && methods.emailPassword && <button className="button subtle" type="button" disabled={!!pending} onClick={() => {
        setUsePassword(value => !value); setCodeSent(false); setError('');
      }}>{usePassword ? 'Sign in with an email code' : 'Sign in with a password'}</button>}
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    {!methods.providers.length && !methods.emailOtp && !methods.emailPassword && <p>Enable a sign-in method in the InsForge project.</p>}
  </section>;
}
