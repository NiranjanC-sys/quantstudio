import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MDXRemote } from 'next-mdx-remote/rsc';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import 'katex/dist/katex.min.css';

import { getLesson, listLessons, readingMinutes } from '@/lib/content';
import { KATEX_MACROS } from '@/lib/katex-macros';
import { mdxComponents } from '@/components/lesson/mdx-components';
import { SiteHeader } from '@/components/layout/SiteHeader';

export async function generateStaticParams() {
  const lessons = await listLessons();
  return lessons.map((l) => ({ slug: l.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const lesson = await getLesson(slug);
  if (!lesson) return { title: 'Lesson not found' };
  return {
    title: lesson.frontmatter.title,
    description: lesson.frontmatter.summary ?? lesson.frontmatter.objectives?.[0],
  };
}

export default async function LessonPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const lesson = await getLesson(slug);
  if (!lesson) notFound();

  const { frontmatter: fm, body } = lesson;
  const all = await listLessons();
  const index = all.findIndex((l) => l.slug.join('/') === slug.join('/'));
  const prev = index > 0 ? all[index - 1] : null;
  const next = index >= 0 && index < all.length - 1 ? all[index + 1] : null;

  return (
    <>
      <SiteHeader />
      <div className="rq-lesson-shell">
        <article className="rq-lesson">
          <header className="rq-lesson-head">
            <p className="rq-eyebrow">
              {fm.type}
              {fm.level ? ` · ${fm.level}` : ''} · {fm.minutes ?? readingMinutes(body)} min
            </p>
            <h1 className="rq-lesson-title">{fm.title}</h1>
            {fm.objectives?.length ? (
              <section className="rq-objectives" aria-label="What you will be able to do">
                <h2 className="rq-eyebrow">By the end you can</h2>
                <ul>
                  {fm.objectives.map((o) => <li key={o}>{o}</li>)}
                </ul>
              </section>
            ) : null}
          </header>

          <div className="rq-lesson-body">
            <MDXRemote
              source={body}
              components={mdxComponents}
              options={{
                mdxOptions: {
                  remarkPlugins: [remarkMath, remarkGfm],
                  rehypePlugins: [[rehypeKatex, { macros: KATEX_MACROS, throwOnError: false, strict: false }], rehypeSlug],
                },
              }}
            />
          </div>

          {fm.sources?.length ? (
            <footer className="rq-lesson-sources">
              <h2 className="rq-eyebrow">Where this comes from</h2>
              <ul>
                {fm.sources.map((s) => (
                  <li key={s.label}>
                    {s.url ? (
                      <a className="rq-lesson-a" href={s.url} target="_blank" rel="noreferrer noopener">
                        {s.label}
                      </a>
                    ) : (
                      s.label
                    )}
                  </li>
                ))}
              </ul>
            </footer>
          ) : null}

          <nav className="rq-lesson-nav" aria-label="Lesson navigation">
            {prev ? (
              <Link href={`/learn/${prev.slug.join('/')}`} className="rq-lesson-nav-prev">
                <span className="rq-eyebrow">Previous</span>
                {prev.frontmatter.title}
              </Link>
            ) : <span />}
            {next ? (
              <Link href={`/learn/${next.slug.join('/')}`} className="rq-lesson-nav-next">
                <span className="rq-eyebrow">Next</span>
                {next.frontmatter.title}
              </Link>
            ) : <span />}
          </nav>
        </article>
      </div>
    </>
  );
}
