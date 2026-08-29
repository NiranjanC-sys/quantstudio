import Link from 'next/link';
import type { Metadata } from 'next';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { PLANS, FEATURES } from '@/lib/plans';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Free covers the foundations and the core track in full. Pro unlocks every track, the interview bank and 28 qubit simulation.',
};

export default function PricingPage() {
  const groups = [...new Set(FEATURES.map((f) => f.group))];

  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section">
          <h1 className="rq-display rq-display-sm">Pricing.</h1>
          <p className="rq-section-sub">
            The free tier is genuinely useful, because the curriculum is the funnel. Two tracks, 87
            lessons, unlimited contests, and a browser simulator that never charges you.
          </p>
        </section>

        <section className="rq-section rq-plans-section" aria-label="Plans">
          <div className="rq-plans">
            {PLANS.map((p) => (
              <div key={p.id} className={`rq-plan${p.featured ? ' is-featured' : ''}`}>
                <h2 className="rq-plan-name">{p.name}</h2>
                <p className="rq-plan-price">
                  <span className="rq-plan-amount">{p.price}</span>
                  <span className="rq-plan-cadence">{p.cadence}</span>
                </p>
                <p className="rq-plan-pitch">{p.pitch}</p>
                <Link
                  href={p.id === 'campus' ? '/contact' : '/signup'}
                  className={`rq-btn ${p.featured ? 'rq-btn-primary' : 'rq-btn-secondary'}`}
                >
                  {p.cta}
                </Link>
              </div>
            ))}
          </div>
        </section>

        <section className="rq-section" aria-label="Feature comparison">
          <div className="rq-table-scroll">
            <table className="rq-compare">
              <caption className="rq-sr-only">Feature comparison across plans</caption>
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  {PLANS.map((p) => (
                    <th key={p.id} scope="col">{p.name}</th>
                  ))}
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g}>
                  <tr className="rq-compare-group">
                    <th scope="rowgroup" colSpan={5}>{g}</th>
                  </tr>
                  {FEATURES.filter((f) => f.group === g).map((f) => (
                    <tr key={f.label}>
                      <th scope="row">{f.label}</th>
                      {f.values.map((v, i) => (
                        <td key={i} className="rq-numeric">{v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
          <p className="rq-note rq-note-plain">
            A simulation credit is one server side simulation unit, priced as
            ceil(2^(n-16)) times shots over 1024, times a backend multiplier. Anything that runs in
            your browser costs nothing, which is why the browser engine handles up to 14 qubits.
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
