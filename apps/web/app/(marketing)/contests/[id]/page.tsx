import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { getContest, listContests } from '@/lib/contests';

export async function generateStaticParams() {
  const cs = await listContests();
  return cs.map((c) => ({ id: c.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const c = await getContest(id);
  return c ? { title: c.title, description: c.summary } : { title: 'Contest not found' };
}

export default async function ContestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const contest = await getContest(id);
  if (!contest) notFound();

  const total = contest.problems.reduce((s, p) => s + (p.points ?? 0), 0);

  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section rq-section-tight">
          <p className="rq-eyebrow">
            {contest.date}
            {contest.ratingRange ? ` · rating ${contest.ratingRange}` : ''}
          </p>
          <h1 className="rq-display rq-display-sm">{contest.title}</h1>
          {contest.summary ? <p className="rq-section-sub">{contest.summary}</p> : null}
          <p className="rq-progress-line">
            <span className="rq-numeric">{contest.problems.length}</span> problems ·{' '}
            <span className="rq-numeric">{total}</span> points ·{' '}
            <span className="rq-numeric">{contest.durationMinutes}</span> minutes
          </p>
        </section>

        <section className="rq-section rq-section-tight" aria-label="Problems">
          <ol className="rq-problem-list">
            {contest.problems.map((p, i) => (
              <li key={p.id}>
                <span className="rq-problem-letter rq-numeric">{String.fromCharCode(65 + i)}</span>
                <div>
                  <h2 className="rq-problem-title">{p.title}</h2>
                  {p.summary ? <p className="rq-problem-summary">{p.summary}</p> : null}
                </div>
                {p.difficulty ? (
                  <span className={`rq-iv-diff rq-iv-diff-${p.difficulty}`}>{p.difficulty}</span>
                ) : <span />}
                <span className="rq-numeric rq-problem-points">{p.points} pts</span>
              </li>
            ))}
          </ol>
          <p className="rq-note rq-note-plain">
            Problems open when the contest starts. Scoring is points minus one penalty minute per
            wrong submission, and only your first accepted submission on a problem counts.
          </p>
        </section>

        <section className="rq-section rq-section-tight">
          <Link href="/contests" className="rq-btn rq-btn-secondary">All contests</Link>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
