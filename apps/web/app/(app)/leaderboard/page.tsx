import type { Metadata } from 'next';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { Leaderboard } from '@/components/app/Leaderboard';

export const metadata: Metadata = {
  title: 'Leaderboard',
  description: 'Global standings by experience and by contest rating.',
};

export default function LeaderboardPage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section rq-section-tight">
          <h1 className="rq-display rq-display-sm">Leaderboard.</h1>
          <p className="rq-section-sub">
            Experience comes from lessons, labs and drills. Contest rating is Glicko-2, computed
            after each weekly contest from your performance against the field rather than from your
            raw score.
          </p>
        </section>
        <section className="rq-section rq-section-tight" aria-label="Standings">
          <Leaderboard />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
