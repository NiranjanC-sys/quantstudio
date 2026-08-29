import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';

export const metadata: Metadata = {
  title: 'Checkout cancelled',
  description: 'The Stripe checkout was cancelled and nothing was charged.',
};

/** The gateway's default `cancel_url`. Nothing happened, and it says so. */
export default function CheckoutCancelledPage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section rq-section-tight">
          <h1 className="rq-display rq-display-sm">Checkout cancelled.</h1>
          <p className="rq-section-sub">
            Nothing was charged and your plan is unchanged. You can start again whenever you like.
          </p>
          <p className="rq-ins-form-actions">
            <Link className="rq-btn rq-btn-primary rq-btn-sm" href="/billing">
              Back to billing
            </Link>
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
