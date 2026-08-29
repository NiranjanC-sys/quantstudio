import type { Metadata } from 'next';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { CohortList } from '@/components/instructor/CohortList';

export const metadata: Metadata = {
  title: 'Instructor',
  description: 'Cohorts, assignments, the gradebook and a per-concept mastery heatmap.',
};

export default function InstructorPage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section rq-section-tight">
          <h1 className="rq-display rq-display-sm">Teaching.</h1>
          <p className="rq-section-sub">
            Cohorts you own or assist on. Mastery figures here are the learners&apos; own, decayed by
            the same forgetting curve their dashboards use, so the two views cannot disagree.
          </p>
          <CohortList />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
