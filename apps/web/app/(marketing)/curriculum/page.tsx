import Link from 'next/link';
import type { Metadata } from 'next';
import { TRACKS, MODULES, LESSONS, CATALOG_COUNTS } from '@redquant/content';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { listLessons, type Lesson } from '@/lib/content';

export const metadata: Metadata = {
  title: 'Curriculum',
  description:
    'Eight tracks, 74 modules, 331 lessons arranged as a prerequisite graph, benchmarked against 20 university syllabi.',
};

export default async function CurriculumPage() {
  const authored = await listLessons();

  // Match authored MDX onto catalogue modules by the `module` frontmatter, so
  // the page reports what exists rather than what was planned.
  const byModule = new Map<string, Lesson[]>();
  for (const l of authored) {
    const mod = (l.frontmatter as { module?: string }).module;
    if (!mod) continue;
    (byModule.get(mod) ?? byModule.set(mod, []).get(mod)!).push(l);
  }
  const authoredCount = authored.filter((l) => !l.slug[0]?.startsWith('_')).length;

  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section rq-section-tight">
          <h1 className="rq-display rq-display-sm">The curriculum.</h1>
          <p className="rq-section-sub">
            Eight tracks and {CATALOG_COUNTS.modules} modules, arranged as a prerequisite graph
            rather than a playlist. Every topic traces to at least two of the 20 syllabi in our
            benchmark, and every lesson cites its sources.
          </p>
          <p className="rq-progress-line">
            <span className="rq-numeric">{authoredCount}</span> of{' '}
            <span className="rq-numeric">{CATALOG_COUNTS.lessons}</span> lessons authored so far.
          </p>
        </section>

        {TRACKS.map((track) => {
          const modules = MODULES.filter((m) => m.track === track.id).sort((a, b) => a.order - b.order);
          const planned = LESSONS.filter((l) => l.track === track.id).length;
          const done = modules.reduce((s, m) => s + (byModule.get(m.id)?.length ?? 0), 0);

          return (
            <section key={track.id} className="rq-section rq-track-section" aria-labelledby={track.id}>
              <header className="rq-track-head">
                <span className="rq-track-id rq-numeric">{track.code}</span>
                <div>
                  <h2 id={track.id} className="rq-h2">{track.title}</h2>
                  <p className="rq-section-sub">{track.summary}</p>
                </div>
                <span className="rq-track-count rq-numeric">{done} / {planned}</span>
              </header>

              <ol className="rq-module-list">
                {modules.map((mod) => {
                  const plannedHere = LESSONS.filter((l) => l.module === mod.id);
                  const found = (byModule.get(mod.id) ?? []).sort((a, b) =>
                    a.slug.join('/').localeCompare(b.slug.join('/')),
                  );
                  return (
                    <li key={mod.id}>
                      <div className="rq-module-head">
                        <span className="rq-module-id rq-numeric">{mod.id}</span>
                        <h3 className="rq-module-name">{mod.title}</h3>
                        <span className="rq-module-count rq-numeric">
                          {found.length} / {plannedHere.length}
                        </span>
                      </div>
                      <ul className="rq-lesson-links">
                        {plannedHere.map((planned2) => {
                          const match = found.find(
                            (f) => (f.frontmatter as { id?: string }).id === planned2.id,
                          );
                          return (
                            <li key={planned2.id}>
                              {match ? (
                                <Link href={`/learn/${match.slug.join('/')}`}>{planned2.title}</Link>
                              ) : (
                                <span className="rq-lesson-pending">{planned2.title}</span>
                              )}
                              <span className="rq-lesson-type">{planned2.type}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </main>
      <SiteFooter />
    </>
  );
}
