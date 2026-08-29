import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { QuestionBrowser } from '@/components/interview/QuestionBrowser';
import { listQuestions, listCompanies, facets } from '@/lib/interview';

export const metadata: Metadata = {
  title: 'Interview bank',
  description:
    'The recurring coding and system-design questions in quantum hiring, with model answers and employer briefings.',
};

export default async function InterviewPage() {
  const [questions, companies] = await Promise.all([listQuestions(), listCompanies()]);
  const f = facets(questions);

  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section rq-section-tight">
          <h1 className="rq-display rq-display-sm">Interview bank.</h1>
          <p className="rq-section-sub">
            Quantum interviews converge on a small number of shapes: build a circuit to a spec,
            reason about a coupling map, defend a shot budget, architect a job queue. Every question
            here carries a real answer, not a hint.
          </p>
          <p className="rq-progress-line">
            <span className="rq-numeric">{questions.length}</span> questions ·{' '}
            <Link href="/interview/companies" className="rq-lesson-a">
              {companies.length} employer briefings
            </Link>
          </p>
        </section>

        <section className="rq-section rq-section-tight" aria-label="Questions">
          {questions.length === 0 ? (
            <p className="rq-empty">The bank is still being authored. Check back shortly.</p>
          ) : (
            <QuestionBrowser questions={questions} facets={f} />
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
