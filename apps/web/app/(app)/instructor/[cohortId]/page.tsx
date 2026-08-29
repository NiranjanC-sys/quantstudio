import type { Metadata } from 'next';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { CohortWorkspace } from '@/components/instructor/CohortWorkspace';

export const metadata: Metadata = {
  title: 'Cohort',
  description: 'Roster, mastery heatmap, assignments and gradebook for one cohort.',
};

/**
 * The cohort id is a server-side route parameter but every panel under it is
 * client-fetched behind the session cookie, so nothing is prerendered with data
 * in it. Next 15 hands params as a promise.
 */
export default async function CohortPage({
  params,
}: {
  params: Promise<{ cohortId: string }>;
}) {
  const { cohortId } = await params;

  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section rq-section-tight">
          <CohortWorkspace cohortId={cohortId} />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
