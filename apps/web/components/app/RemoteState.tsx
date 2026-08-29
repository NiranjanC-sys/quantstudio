'use client';

/**
 * The three states every remote panel has, rendered consistently.
 *
 * An unreachable API says so and offers a retry. It does not spin forever, and
 * it does not pretend the learner has zero XP.
 */

export function Loading({ label }: { label: string }) {
  return (
    <p className="rq-remote rq-remote-loading" role="status" aria-live="polite">
      Loading {label}...
    </p>
  );
}

export function Unavailable({ detail, onRetry }: { detail: string; onRetry?: () => void }) {
  return (
    <div className="rq-remote rq-remote-error" role="status">
      <p>{detail}</p>
      <p className="rq-remote-hint">
        The gateway runs separately from this site. Start it with{' '}
        <code className="rq-lesson-code">pnpm --filter @redquant/api dev</code>.
      </p>
      {onRetry ? (
        <button type="button" className="rq-btn rq-btn-secondary rq-btn-sm" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rq-remote rq-remote-empty">{children}</p>;
}
