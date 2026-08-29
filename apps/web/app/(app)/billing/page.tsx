import type { Metadata } from 'next';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { BillingWorkspace } from '@/components/billing/BillingWorkspace';

export const metadata: Metadata = {
  title: 'Billing',
  description: 'Your plan, your simulation credits and the ledger behind them.',
};

export default function BillingPage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section rq-section-tight">
          <h1 className="rq-display rq-display-sm">Billing.</h1>
          <p className="rq-section-sub">
            Payment is handled by Stripe. This page reads what the gateway records and opens
            checkout or the customer portal; no card detail is ever entered here.
          </p>
          <BillingWorkspace />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
