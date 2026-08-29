'use client';

/**
 * Every way a gateway call can fail, rendered as a sentence and a next step.
 *
 * The rule this component exists to enforce: a reader is never shown a spinner
 * that will not resolve, and never shown a number the API did not send. If the
 * gateway is down we say so; if the session is missing we link to sign-in; if
 * the plan is wrong we link to the plans. Nothing here invents a zero.
 *
 * Billing renders the same component. The gateway's problem-document contract
 * is modelled once, in the instructor module, because that is where the full
 * set of codes appears; billing speaks the same protocol and reuses it rather
 * than keeping a second copy that could drift.
 */

import Link from 'next/link';
import type { Failure } from '@/lib/instructor';
import '@/styles/instructor.css';

interface Advice {
  headline: string;
  body: string;
  action?: { href: string; label: string };
}

function advise(failure: Failure): Advice {
  switch (failure.kind) {
    case 'unreachable':
      return {
        headline: 'The gateway is not answering.',
        body: 'This page reads live data and will not guess at it. The API runs as a separate process; start it and try again.',
      };
    case 'unauthenticated':
      return {
        headline: 'You are signed out.',
        body: 'Cohorts, grades and billing are tied to your account, so there is nothing to show until you sign in.',
        action: { href: '/login', label: 'Sign in' },
      };
    case 'mfa-required':
      return {
        headline: 'Your second factor is not satisfied.',
        body: 'Instructor and organisation admin accounts must complete multi-factor authentication before this data is released. Sign in again and enter the code from your authenticator app.',
        action: { href: '/login', label: 'Sign in again' },
      };
    case 'forbidden':
      return {
        headline: 'Your account does not teach here.',
        body: `${failure.detail} An organisation admin can grant the instructor role, or add you to the cohort as an assistant.`,
        action: { href: '/dashboard', label: 'Back to your dashboard' },
      };
    case 'entitlement':
      return {
        headline: 'Your plan does not include the instructor dashboard.',
        body: `${failure.detail} Teams and Campus include cohorts, the mastery heatmap and the gradebook.`,
        action: { href: '/pricing', label: 'Compare plans' },
      };
    case 'not-found':
      return {
        headline: 'Not found.',
        body: `${failure.detail} It may have been archived, or it belongs to another organisation.`,
        action: { href: '/instructor', label: 'Back to cohorts' },
      };
    case 'rate-limited':
      return {
        headline: 'Too many requests.',
        body: `${failure.detail} Wait a few seconds before retrying.`,
      };
    case 'unconfigured':
      return {
        headline: 'That service is not configured here.',
        body: `${failure.detail} This is a deployment setting, not something you can fix from the browser.`,
      };
    case 'invalid':
      return { headline: 'The gateway rejected that request.', body: failure.detail };
    default:
      return {
        headline: 'The gateway returned an error.',
        body: `${failure.detail} Nothing was changed.`,
      };
  }
}

export function FailureNotice({
  failure,
  onRetry,
  label,
}: {
  failure: Failure;
  onRetry?: () => void;
  /** What the reader was trying to see, used in the accessible name. */
  label?: string;
}) {
  const advice = advise(failure);
  const retryable =
    failure.kind === 'unreachable' ||
    failure.kind === 'rate-limited' ||
    failure.kind === 'server' ||
    failure.kind === 'unconfigured';

  return (
    <div
      className="rq-ins-notice"
      role="status"
      aria-label={label ? `${label} unavailable` : undefined}
    >
      <p className="rq-ins-notice-head">{advice.headline}</p>
      <p className="rq-ins-notice-body">{advice.body}</p>

      {failure.fields.length > 0 ? (
        <ul className="rq-ins-notice-fields">
          {failure.fields.map((field) => (
            <li key={`${field.path}:${field.message}`}>
              <span className="rq-mono">{field.path}</span> {field.message}
            </li>
          ))}
        </ul>
      ) : null}

      {failure.kind === 'unreachable' ? (
        <p className="rq-ins-notice-hint">
          Start it with <code className="rq-lesson-code">pnpm --filter @redquant/api dev</code>.
        </p>
      ) : null}

      <p className="rq-ins-notice-actions">
        {advice.action ? (
          <Link className="rq-btn rq-btn-secondary rq-btn-sm" href={advice.action.href}>
            {advice.action.label}
          </Link>
        ) : null}
        {retryable && onRetry ? (
          <button type="button" className="rq-btn rq-btn-secondary rq-btn-sm" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </p>
    </div>
  );
}

/** The loading state, worded so it names what is being fetched. */
export function Pending({ label }: { label: string }) {
  return (
    <p className="rq-ins-pending" role="status" aria-live="polite">
      Loading {label}...
    </p>
  );
}
