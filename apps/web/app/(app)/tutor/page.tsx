import type { Metadata } from 'next';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { TutorPanel } from '@/components/tutor/TutorPanel';

export const metadata: Metadata = {
  title: 'Tutor',
  description:
    'Ask about a concept, take a Socratic hint, or send your circuit and its simulated output for a debug or a critique.',
};

export default function TutorPage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section rq-section-tight rq-tutor-page-shell">
          <h1 className="rq-display rq-display-sm">Ask about your circuit.</h1>
          <p className="rq-section-sub">
            Every mode below sends what you have actually built, not a paraphrase of it: the circuit
            IR, the gate counts and the amplitudes the simulator produced. Answers are grounded in the
            curriculum and cited where the retrieval finds a lesson.
          </p>
          <TutorPanel variant="page" />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
