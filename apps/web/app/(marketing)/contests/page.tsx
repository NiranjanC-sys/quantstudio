import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { listContests } from '@/lib/contests';

export const metadata: Metadata = {
  title: 'Contests',
  description: 'Weekly rated quantum programming contests. Four problems, ninety minutes, Glicko-2 ratings.',
};

export default async function ContestsPage() {
  const contests = await listContests();

  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section rq-section-tight">
          <h1 className="rq-display rq-display-sm">Weekly contests.</h1>
          <p className="rq-section-sub">
            Four problems, ninety minutes, rated. Build a circuit to a spec, minimise two-qubit gate
            count under a coupling map, implement an oracle, decode a syndrome. Scoring is points
            minus a time penalty, and only your first accepted submission on a problem counts.
          </p>
        </section>

        <section className="rq-section rq-section-tight">
          <div className="rq-split">
            <div className="rq-split-narrow">
              <h2 className="rq-h2">How the rating works.</h2>
            </div>
            <div className="rq-split-wide">
              <ul className="rq-feature-rows">
                <li>
                  <span className="rq-feature-k">Glicko-2</span>
                  <span className="rq-feature-v">You start at 1500 with a deviation of 350, so early contests move you fast and later ones move you slowly. Volatility is capped per contest.</span>
                </li>
                <li>
                  <span className="rq-feature-k">Frozen board</span>
                  <span className="rq-feature-v">The public standings freeze sixty minutes before the end. Submissions keep scoring, you just cannot watch.</span>
                </li>
                <li>
                  <span className="rq-feature-k">Verified before publish</span>
                  <span className="rq-feature-v">The top hundred are rerun against an extended hidden test set before ratings are published.</span>
                </li>
                <li>
                  <span className="rq-feature-k">Virtual participation</span>
                  <span className="rq-feature-v">Run any past contest against the clock. It does not affect your rating.</span>
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section className="rq-section rq-section-tight" aria-label="Contest list">
          <h2 className="rq-h2">Past and upcoming.</h2>
          {contests.length === 0 ? (
            <p className="rq-empty">The first contest set is still being written.</p>
          ) : (
            <ol className="rq-contest-list">
              {contests.map((c) => (
                <li key={c.id}>
                  <div className="rq-contest-head">
                    <span className="rq-contest-date rq-numeric">{c.date || 'TBC'}</span>
                    <h3 className="rq-contest-title">
                      <Link href={`/contests/${c.id}`}>{c.title}</Link>
                    </h3>
                    <span className="rq-numeric rq-contest-meta">{c.durationMinutes} min</span>
                    <span className="rq-numeric rq-contest-meta">{c.problems.length} problems</span>
                  </div>
                  {c.summary ? <p className="rq-contest-summary">{c.summary}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
