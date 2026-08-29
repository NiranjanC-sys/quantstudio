import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { getQuestion, listQuestions } from '@/lib/interview';

export async function generateStaticParams() {
  const qs = await listQuestions();
  return qs.map((q) => ({ id: q.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const q = await getQuestion(id);
  return q ? { title: q.title, description: q.prompt.slice(0, 155) } : { title: 'Question not found' };
}

export default async function QuestionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const q = await getQuestion(id);
  if (!q) notFound();

  const answer = q.modelAnswer ?? q.answer ?? '';

  return (
    <>
      <SiteHeader />
      <main id="main">
        <article className="rq-lesson">
          <header className="rq-lesson-head">
            <p className="rq-eyebrow">
              {q.kind ?? 'question'} · {q.difficulty}
              {q.pattern ? ` · ${q.pattern}` : ''}
            </p>
            <h1 className="rq-lesson-title">{q.title}</h1>
            <p className="rq-iv-meta">
              {(q.companies ?? []).map((c) => (
                <span key={c} className="rq-iv-company">{c}</span>
              ))}
            </p>
          </header>

          <section className="rq-iv-block">
            <h2 className="rq-eyebrow">The question</h2>
            <pre className="rq-iv-prompt">{q.prompt}</pre>
          </section>

          {answer && (
            <section className="rq-iv-block">
              <h2 className="rq-eyebrow">Model answer</h2>
              <pre className="rq-iv-answer">{answer}</pre>
            </section>
          )}

          {q.followups?.length ? (
            <section className="rq-iv-block">
              <h2 className="rq-eyebrow">Likely follow ups</h2>
              <ul className="rq-lesson-ul">{q.followups.map((f) => <li key={f}>{f}</li>)}</ul>
            </section>
          ) : null}

          {q.mistakes?.length ? (
            <section className="rq-iv-block">
              <h2 className="rq-eyebrow">Common wrong turns</h2>
              <ul className="rq-lesson-ul">{q.mistakes.map((m) => <li key={m}>{m}</li>)}</ul>
            </section>
          ) : null}

          {q.references?.length ? (
            <footer className="rq-lesson-sources">
              <h2 className="rq-eyebrow">References</h2>
              <ul>
                {q.references.map((r) => (
                  <li key={r.label}>
                    {r.url ? (
                      <a className="rq-lesson-a" href={r.url} target="_blank" rel="noreferrer noopener">{r.label}</a>
                    ) : r.label}
                  </li>
                ))}
              </ul>
            </footer>
          ) : null}

          <nav className="rq-lesson-nav">
            <Link href="/interview" className="rq-lesson-nav-prev">
              <span className="rq-eyebrow">Back</span>
              All questions
            </Link>
            <span />
          </nav>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
