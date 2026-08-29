'use client';

/**
 * The plan matrix, marked up with which plan the account is actually on.
 *
 * It reads `lib/plans.ts`, the same data the pricing page renders, so the two
 * pages cannot quote different numbers. The prices beside the plan names come
 * from `GET /billing/plans` when that call succeeds, because the priced
 * catalogue is the gateway's, and fall back to the matrix's own strings when it
 * does not; either way the reader is told which they are looking at.
 *
 * Nothing here touches a card. "Upgrade" asks the gateway for a Stripe Checkout
 * session and follows the URL it returns.
 */

import { useState } from 'react';
import Link from 'next/link';
import { FEATURES, PLANS } from '@/lib/plans';
import {
  formatMoney,
  startCheckout,
  type Failure,
  type PlanCode,
  type PlanRow,
} from '@/lib/billing';
import { FailureNotice } from '@/components/instructor/FailureNotice';
import '@/styles/instructor.css';

export function PlanComparison({
  currentPlan,
  priced,
}: {
  currentPlan: PlanCode | null;
  /** From GET /billing/plans; empty when that call failed or is still running. */
  priced: PlanRow[];
}) {
  const [seats, setSeats] = useState(1);
  const [pendingPlan, setPendingPlan] = useState<PlanCode | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const groups = [...new Set(FEATURES.map((feature) => feature.group))];
  const pricedByCode = new Map(priced.map((row) => [row.code, row]));

  async function upgrade(plan: Exclude<PlanCode, 'free'>, seatBased: boolean) {
    setPendingPlan(plan);
    setFailure(null);
    const res = await startCheckout(plan, seatBased ? seats : 1);
    setPendingPlan(null);

    if (!res.ok) {
      setFailure(res);
      return;
    }
    if (!res.data.url) {
      setFailure({
        ok: false,
        kind: 'server',
        status: 502,
        code: 'no-checkout-url',
        detail: 'Stripe created a session without a URL, so there is nowhere to send you.',
        fields: [],
      });
      return;
    }
    window.location.href = res.data.url;
  }

  return (
    <>
      <div className="rq-plans">
        {PLANS.map((plan) => {
          const row = pricedByCode.get(plan.id);
          const isCurrent = currentPlan === plan.id;
          const seatBased = row?.seatBased ?? (plan.id === 'teams' || plan.id === 'campus');

          return (
            <div
              key={plan.id}
              className={`rq-plan${plan.featured ? ' is-featured' : ''}${isCurrent ? ' is-current' : ''}`}
            >
              <h3 className="rq-plan-name">
                {plan.name}
                {isCurrent ? <span className="rq-bill-current-flag">Your plan</span> : null}
              </h3>
              <p className="rq-plan-price">
                <span className="rq-plan-amount rq-numeric">
                  {row && row.priceCents > 0 ? formatMoney(row.priceCents, row.currency) : plan.price}
                </span>
                <span className="rq-plan-cadence">{plan.cadence}</span>
              </p>
              <p className="rq-plan-pitch">{plan.pitch}</p>

              {plan.id === 'free' ? (
                <p className="rq-bill-plan-note">
                  {isCurrent ? 'You are on the free tier.' : 'Downgrade from the customer portal.'}
                </p>
              ) : plan.id === 'campus' ? (
                <Link className="rq-btn rq-btn-secondary" href="/contact">
                  {plan.cta}
                </Link>
              ) : isCurrent ? (
                <p className="rq-bill-plan-note">
                  Change seats or cancel from the customer portal below.
                </p>
              ) : (
                <button
                  type="button"
                  className={`rq-btn ${plan.featured ? 'rq-btn-primary' : 'rq-btn-secondary'}`}
                  disabled={pendingPlan !== null}
                  onClick={() => void upgrade(plan.id as Exclude<PlanCode, 'free'>, seatBased)}
                >
                  {pendingPlan === plan.id ? 'Opening Stripe...' : plan.cta}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="rq-bill-seats">
        <label className="rq-field-label" htmlFor="billing-seats">
          Seats, for the seat-priced plans
        </label>
        <input
          id="billing-seats"
          className="rq-input rq-numeric rq-input-narrow"
          type="number"
          min={1}
          max={10000}
          value={seats}
          onChange={(event) => setSeats(Math.max(1, Number(event.target.value) || 1))}
          aria-describedby="billing-seats-hint"
        />
        <span className="rq-field-hint" id="billing-seats-hint">
          Teams bills per seat. Pro is a single seat whatever this says.
        </span>
      </p>

      {failure ? <FailureNotice failure={failure} label="Checkout" /> : null}

      <div className="rq-table-scroll" role="region" aria-label="Feature comparison, scrollable" tabIndex={0}>
        <table className="rq-compare">
          <caption className="rq-sr-only">
            Feature comparison across the four plans. Your current plan is named in its column
            header.
          </caption>
          <thead>
            <tr>
              <th scope="col">Feature</th>
              {PLANS.map((plan) => (
                <th key={plan.id} scope="col">
                  {plan.name}
                  {currentPlan === plan.id ? (
                    <span className="rq-bill-col-flag"> (yours)</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group}>
              <tr className="rq-compare-group">
                <th scope="rowgroup" colSpan={5}>
                  {group}
                </th>
              </tr>
              {FEATURES.filter((feature) => feature.group === group).map((feature) => (
                <tr key={feature.label}>
                  <th scope="row">{feature.label}</th>
                  {feature.values.map((value, index) => (
                    <td key={PLANS[index]?.id ?? index} className="rq-numeric">
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </>
  );
}
