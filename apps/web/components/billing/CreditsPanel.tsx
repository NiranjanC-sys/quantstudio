'use client';

/**
 * Simulation credits: the balance now, the monthly grant, and every movement.
 *
 * The ledger is the source of truth and the balance is derived from it, so both
 * are shown together and `balanceAfter` is printed on each row. If a reader ever
 * wants to know why the balance is what it is, the arithmetic is on the page.
 *
 * `monthlyGrant` is null on a plan whose grant is negotiated rather than fixed.
 * That is not a grant of zero and is not printed as one.
 */

import { useCallback, useState } from 'react';
import {
  CREDIT_REASON_LABEL,
  formatCredits,
  formatDay,
  getCredits,
  type CreditsResponse,
  type Failure,
} from '@/lib/billing';
import { FailureNotice } from '@/components/instructor/FailureNotice';
import '@/styles/instructor.css';

const PAGE = 25;

export function CreditsPanel({ initial }: { initial: CreditsResponse }) {
  const [credits, setCredits] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const loadMore = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    const res = await getCredits(PAGE, credits.items.length);
    setBusy(false);
    if (!res.ok) {
      setFailure(res);
      return;
    }
    setCredits((current) => ({
      ...res.data,
      items: [...current.items, ...res.data.items],
    }));
  }, [credits.items.length]);

  const spent = credits.items
    .filter((entry) => entry.delta < 0)
    .reduce((sum, entry) => sum + entry.delta, 0);

  return (
    <>
      <dl className="rq-stat-grid">
        <div className="rq-stat-card">
          <dt>Balance</dt>
          <dd>{formatCredits(credits.balance)}</dd>
          <span className="rq-stat-sub">credits available now</span>
        </div>
        <div className="rq-stat-card">
          <dt>Monthly grant</dt>
          <dd className={credits.monthlyGrant === null ? 'rq-ins-stat-text' : undefined}>
            {credits.monthlyGrant === null ? 'Negotiated' : formatCredits(credits.monthlyGrant)}
          </dd>
          <span className="rq-stat-sub">
            {credits.monthlyGrant === null ? 'set by contract, not by plan' : 'granted each period'}
          </span>
        </div>
        <div className="rq-stat-card">
          <dt>Spent, shown here</dt>
          <dd>{formatCredits(Math.abs(spent))}</dd>
          <span className="rq-stat-sub">
            over the {credits.items.length} of {credits.total} entries loaded
          </span>
        </div>
      </dl>

      {credits.items.length === 0 ? (
        <p className="rq-ins-empty">
          The ledger is empty. It fills as the server simulates for you; work that runs in your
          browser never costs a credit.
        </p>
      ) : (
        <>
          <div className="rq-ins-scroll" role="region" aria-label="Credit ledger, scrollable" tabIndex={0}>
            <table className="rq-board rq-ins-table">
              <caption className="rq-sr-only">
                Credit ledger, newest first. Each row gives the change and the balance it left
                behind.
              </caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Reference</th>
                  <th scope="col" className="rq-ins-num">
                    Change
                  </th>
                  <th scope="col" className="rq-ins-num">
                    Balance after
                  </th>
                </tr>
              </thead>
              <tbody>
                {credits.items.map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row">{formatDay(entry.createdAt)}</th>
                    <td>{CREDIT_REASON_LABEL[entry.reason] ?? entry.reason}</td>
                    <td className="rq-ins-muted rq-mono">{entry.refType ?? 'None'}</td>
                    <td
                      className={`rq-numeric rq-ins-num${entry.delta < 0 ? ' rq-bill-debit' : ' rq-bill-credit'}`}
                    >
                      {entry.delta > 0 ? `+${formatCredits(entry.delta)}` : formatCredits(entry.delta)}
                    </td>
                    <td className="rq-numeric rq-ins-num">{formatCredits(entry.balanceAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {credits.items.length < credits.total ? (
            <p className="rq-ins-form-actions">
              <button
                type="button"
                className="rq-btn rq-btn-secondary rq-btn-sm"
                onClick={() => void loadMore()}
                disabled={busy}
              >
                {busy ? 'Loading...' : `Load ${Math.min(PAGE, credits.total - credits.items.length)} more`}
              </button>
            </p>
          ) : null}
        </>
      )}

      {failure ? <FailureNotice failure={failure} onRetry={() => void loadMore()} label="The ledger" /> : null}
    </>
  );
}
