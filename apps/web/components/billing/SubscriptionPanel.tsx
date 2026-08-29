'use client';

/**
 * What the account is paying for, and the door to Stripe's customer portal.
 *
 * `GET /billing/subscription` returns three things and they are not the same
 * thing: the Stripe-backed `subscription` row, which is null for anyone who has
 * never checked out; `plan`, the effective plan; and `entitlements`, the cached
 * snapshot the product actually enforces. An account can have a plan and no
 * subscription row, which is exactly what a seeded or contract-billed account
 * looks like, so this panel says which of the three it is showing.
 */

import { useState } from 'react';
import {
  STATUS_LABEL,
  STATUS_NOTE,
  formatDay,
  openPortal,
  type Entitlements,
  type Failure,
  type Invoice,
  type Subscription,
} from '@/lib/billing';
import { FailureNotice } from '@/components/instructor/FailureNotice';
import '@/styles/instructor.css';

export function SubscriptionPanel({
  subscription,
  plan,
  entitlements,
  invoices,
}: {
  subscription: Subscription | null;
  plan: string;
  entitlements: Entitlements;
  invoices: Invoice[] | null;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function portal() {
    setPending(true);
    setFailure(null);
    const res = await openPortal();
    setPending(false);
    if (!res.ok) {
      setFailure(res);
      return;
    }
    window.location.href = res.data.url;
  }

  return (
    <>
      <dl className="rq-stat-grid">
        <div className="rq-stat-card">
          <dt>Effective plan</dt>
          <dd className="rq-ins-stat-text">{plan}</dd>
          <span className="rq-stat-sub">what the product enforces today</span>
        </div>
        <div className="rq-stat-card">
          <dt>Status</dt>
          <dd className="rq-ins-stat-text">
            {subscription ? STATUS_LABEL[subscription.status] : 'No subscription'}
          </dd>
          <span className="rq-stat-sub">
            {subscription ? `${subscription.seats} seat${subscription.seats === 1 ? '' : 's'}` : 'nothing billed'}
          </span>
        </div>
        <div className="rq-stat-card">
          <dt>Period ends</dt>
          <dd className="rq-ins-stat-text">
            {subscription ? formatDay(subscription.currentPeriodEnd) : 'Not applicable'}
          </dd>
          <span className="rq-stat-sub">
            {subscription?.cancelAtPeriodEnd ? 'cancels at period end' : 'renews unless cancelled'}
          </span>
        </div>
        <div className="rq-stat-card">
          <dt>Max qubits</dt>
          <dd>{entitlements.maxQubits}</dd>
          <span className="rq-stat-sub">
            {entitlements.noisyMaxQubits === null
              ? 'no noisy simulation'
              : `${entitlements.noisyMaxQubits} with noise`}
          </span>
        </div>
      </dl>

      {subscription ? (
        <p className="rq-ins-prose">{STATUS_NOTE[subscription.status]}</p>
      ) : (
        <p className="rq-ins-prose">
          There is no Stripe subscription on this account. Your plan comes from the entitlement
          table, which is how a contract-billed or seeded account works and why the product keeps
          working when Stripe does not.
        </p>
      )}

      <p className="rq-ins-form-actions">
        <button
          type="button"
          className="rq-btn rq-btn-secondary rq-btn-sm"
          onClick={() => void portal()}
          disabled={pending}
        >
          {pending ? 'Opening the portal...' : 'Manage billing in Stripe'}
        </button>
      </p>

      {failure ? (
        <FailureNotice failure={failure} onRetry={() => void portal()} label="The customer portal" />
      ) : null}

      <Invoices invoices={invoices} />
    </>
  );
}

function Invoices({ invoices }: { invoices: Invoice[] | null }) {
  if (invoices === null) {
    return (
      <p className="rq-ins-empty">
        Invoices could not be read. Nothing else on this page depends on them.
      </p>
    );
  }
  if (invoices.length === 0) {
    return <p className="rq-ins-empty">No invoices yet. Stripe writes one after the first charge.</p>;
  }

  return (
    <table className="rq-board rq-ins-table">
      <caption className="rq-sr-only">Invoices on this account</caption>
      <thead>
        <tr>
          <th scope="col">Issued</th>
          <th scope="col">Status</th>
          <th scope="col" className="rq-ins-num">
            Due
          </th>
          <th scope="col" className="rq-ins-num">
            Paid
          </th>
          <th scope="col">Receipt</th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((invoice) => (
          <tr key={invoice.id}>
            <th scope="row">{formatDay(invoice.createdAt)}</th>
            <td>{invoice.status}</td>
            <td className="rq-numeric rq-ins-num">
              {(invoice.amountDue / 100).toFixed(2)} {invoice.currency.toUpperCase()}
            </td>
            <td className="rq-numeric rq-ins-num">
              {(invoice.amountPaid / 100).toFixed(2)} {invoice.currency.toUpperCase()}
            </td>
            <td>
              {invoice.hostedInvoiceUrl ? (
                <a className="rq-ins-a" href={invoice.hostedInvoiceUrl} rel="noreferrer noopener">
                  View on Stripe
                </a>
              ) : (
                <span className="rq-ins-muted">Not hosted</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
