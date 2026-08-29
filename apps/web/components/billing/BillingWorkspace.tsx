'use client';

/**
 * The billing page.
 *
 * It is deliberately not all-or-nothing. `GET /billing/plans` is public, so a
 * signed-out visitor still gets the plan matrix and a sign-in prompt where
 * their subscription would be, rather than a single wall. The account-specific
 * calls each fail on their own terms: an unreachable gateway, a missing
 * session, and a Stripe that was never configured on this deployment are three
 * different sentences with three different next steps.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getCredits,
  getInvoices,
  getPlans,
  getSubscription,
  type CreditsResponse,
  type Failure,
  type Invoice,
  type PlanRow,
  type SubscriptionResponse,
} from '@/lib/billing';
import { FailureNotice, Pending } from '@/components/instructor/FailureNotice';
import { CreditsPanel } from './CreditsPanel';
import { PlanComparison } from './PlanComparison';
import { SubscriptionPanel } from './SubscriptionPanel';
import '@/styles/instructor.css';

interface Loaded {
  plans: PlanRow[];
  subscription: SubscriptionResponse | null;
  subscriptionFailure: Failure | null;
  credits: CreditsResponse | null;
  creditsFailure: Failure | null;
  invoices: Invoice[] | null;
}

export function BillingWorkspace() {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ready'; loaded: Loaded }>({
    kind: 'loading',
  });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const [plans, subscription, credits, invoices] = await Promise.all([
      getPlans(),
      getSubscription(),
      getCredits(),
      getInvoices(),
    ]);

    setState({
      kind: 'ready',
      loaded: {
        plans: plans.ok ? plans.data.items : [],
        subscription: subscription.ok ? subscription.data : null,
        subscriptionFailure: subscription.ok ? null : subscription,
        credits: credits.ok ? credits.data : null,
        creditsFailure: credits.ok ? null : credits,
        invoices: invoices.ok ? invoices.data.items : null,
      },
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') return <Pending label="your billing" />;

  const { loaded } = state;

  return (
    <>
      <section className="rq-ins-section" aria-labelledby="subscription-heading">
        <h2 id="subscription-heading" className="rq-h2">
          Your subscription.
        </h2>
        {loaded.subscription ? (
          <SubscriptionPanel
            subscription={loaded.subscription.subscription}
            plan={loaded.subscription.plan}
            entitlements={loaded.subscription.entitlements}
            invoices={loaded.invoices}
          />
        ) : loaded.subscriptionFailure ? (
          <FailureNotice
            failure={loaded.subscriptionFailure}
            onRetry={() => void load()}
            label="Your subscription"
          />
        ) : null}
      </section>

      <section className="rq-ins-section" aria-labelledby="credits-heading">
        <h2 id="credits-heading" className="rq-h2">
          Simulation credits.
        </h2>
        <p className="rq-ins-prose">
          Server-side simulation is metered; the browser engine is not. A credit is one simulation
          unit, so a small circuit run in the lab costs nothing at all.
        </p>
        {loaded.credits ? (
          <CreditsPanel initial={loaded.credits} />
        ) : loaded.creditsFailure ? (
          <FailureNotice
            failure={loaded.creditsFailure}
            onRetry={() => void load()}
            label="Your credits"
          />
        ) : null}
      </section>

      <section className="rq-ins-section" aria-labelledby="plans-heading">
        <h2 id="plans-heading" className="rq-h2">
          Plans.
        </h2>
        <p className="rq-ins-prose">
          The same matrix the pricing page quotes, with your plan marked. Checkout and cancellation
          both run on Stripe; this page only asks the gateway to open the right door.
        </p>
        <PlanComparison
          currentPlan={loaded.subscription?.plan ?? null}
          priced={loaded.plans}
        />
      </section>
    </>
  );
}
