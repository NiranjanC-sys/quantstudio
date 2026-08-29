'use client';

/**
 * Sign in and sign up share one component because they share one flow: pick a
 * provider, or use email. The only differences are the copy and which endpoint
 * the credentials path posts to.
 */

import { useState } from 'react';
import Link from 'next/link';

const PROVIDERS = [
  { id: 'google', label: 'Continue with Google' },
  { id: 'github', label: 'Continue with GitHub' },
  { id: 'microsoft', label: 'Continue with Microsoft' },
  { id: 'orcid', label: 'Continue with ORCID' },
];

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSignup = mode === 'signup';

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!email.includes('@')) {
      setError('That does not look like an email address.');
      return;
    }
    if (isSignup && password.length < 12) {
      setError('Use at least 12 characters. Length beats symbols.');
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`${API}/v1/auth/${isSignup ? 'register' : 'login'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { detail?: string } | null;
        setError(body?.detail ?? `Sign ${isSignup ? 'up' : 'in'} failed.`);
        return;
      }
      window.location.href = '/dashboard';
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rq-auth">
      <h1 className="rq-auth-title">{isSignup ? 'Start learning quantum computing.' : 'Welcome back.'}</h1>
      <p className="rq-auth-sub">
        {isSignup
          ? 'The foundations and the core track are free, forever. No card needed.'
          : 'Pick up where you left off.'}
      </p>

      <div className="rq-auth-providers">
        {PROVIDERS.map((p) => (
          <a key={p.id} href={`${API}/v1/auth/oauth/${p.id}`} className="rq-btn rq-btn-secondary rq-btn-block">
            {p.label}
          </a>
        ))}
      </div>

      <div className="rq-auth-divider"><span>or use email</span></div>

      <form onSubmit={onSubmit} className="rq-auth-form" noValidate>
        <label htmlFor="email" className="rq-field-label">Email</label>
        <input
          id="email" name="email" type="email" autoComplete="email" required
          className="rq-input rq-input-block" value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="password" className="rq-field-label">Password</label>
        <input
          id="password" name="password" type="password" required
          autoComplete={isSignup ? 'new-password' : 'current-password'}
          className="rq-input rq-input-block" value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby={isSignup ? 'pw-hint' : undefined}
        />
        {isSignup && <p id="pw-hint" className="rq-field-hint">At least 12 characters.</p>}

        {error && <p className="rq-field-error" role="alert">{error}</p>}

        <button type="submit" className="rq-btn rq-btn-primary rq-btn-block" disabled={pending}>
          {pending ? 'Working...' : isSignup ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <p className="rq-auth-switch">
        {isSignup ? (
          <>Already have an account? <Link href="/login">Sign in</Link></>
        ) : (
          <>New here? <Link href="/signup">Create an account</Link></>
        )}
      </p>
    </div>
  );
}
