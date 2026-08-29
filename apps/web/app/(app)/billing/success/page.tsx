import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';

export const metadata: Metadata = {
  title: 'Checkout complete',
  description: 'Stripe has finished checkout and the gateway is applying the plan.',
};

/**
 * Where Stripe sends the browser after a completed checkout. The gateway builds
 * this URL itself, appending `?session=<id>`, so the route has to exist under
 * this exact path or the last step of a real payment is a 404.
 *
 * It claims nothing about the plan. A checkout session completing is not the
 * same event as the entitlement being granted: the webhook does that, on the
 * server, and it may land a second after the redirect. Saying "you are on Pro"
 * here would be a guess.
 */
export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const { session } = await searchParams;

  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section rq-section-tight">
          <h1 className="rq-display rq-display-sm">Checkout complete.</h1>
          <p className="rq-section-sub">
            Stripe has your payment. Your plan is granted by the webhook rather than by this page,
            which usually lands within a few seconds. Open billing to see the plan the gateway is
            enforcing.
          </p>
          {session ? (
            <p className="rq-ins-prose">
              Stripe session <span className="rq-mono">{session}</span>.
            </p>
          ) : null}
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
