import Link from 'next/link';
import type { Metadata } from 'next';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { TRACKS, PLANNED_LESSONS } from '@/lib/tracks';
import { listLessons, type Lesson } from '@/lib/content';

export const metadata: Metadata = {
  title: 'Curriculum',
  description:
    'Eight tracks, 64 modules, 306 lessons arranged as a prerequisite graph, benchmarked against 20 university syllabi.',
};

export default async function CurriculumPage() {
  const lessons = await listLessons();

  // Group authored lessons by the module id in their frontmatter, so the page
  // reports what actually exists rather than what was planned.
  const byModule = new Map<string, Lesson[]>();
  for (const l of lessons) {
    const mod = (l.frontmatter as { module?: string }).module;
    if (!mod) continue;
    const list = byModule.get(mod) ?? [];
    list.push(l);
    byModule.set(mod, list);
  }
  const authored = lessons.filter((l) => !l.slug[0]?.startsWith('_')).length;

  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section">
          <h1 className="rq-display rq-display-sm">The curriculum.</h1>
          <p className="rq-section-sub">
            Eight tracks and {TRACKS.reduce((s, t) => s + t.modules.length, 0)} modules, arranged as
            a prerequisite graph rather than a playlist. Every topic traces to at least two of the
            20 syllabi in our benchmark, and every lesson cites its sources.
          </p>
          <p className="rq-progress-line">
            <span className="rq-numeric">{authored}</span> of{' '}
            <span className="rq-numeric">{PLANNED_LESSONS}</span> lessons authored so far.
          </p>
        </section>

        {TRACKS.map((track) => {
          const trackAuthored = track.modules.reduce(
            (s, m) => s + (byModule.get(m.id)?.length ?? 0),
            0,
          );
          const trackPlanned = track.modules.reduce((s, m) => s + m.planned, 0);
          return (
            <section key={track.id} className="rq-section rq-track-section" aria-labelledby={track.id}>
              <header className="rq-track-head">
                <span className="rq-track-id rq-numeric">{track.id.toUpperCase()}</span>
                <div>
                  <h2 id={track.id} className="rq-h2">{track.name}</h2>
                  <p className="rq-section-sub">{track.blurb}</p>
                </div>
                <span className="rq-track-count rq-numeric">
                  {trackAuthored} / {trackPlanned}
                </span>
              </header>

              <ol className="rq-module-list">
                {track.modules.map((mod) => {
                  const found = (byModule.get(mod.id) ?? []).sort((a, b) =>
                    a.slug.join('/').localeCompare(b.slug.join('/')),
                  );
                  return (
                    <li key={mod.id}>
                      <div className="rq-module-head">
                        <span className="rq-module-id rq-numeric">{mod.id}</span>
                        <h3 className="rq-module-name">{mod.name}</h3>
                        <span className="rq-module-count rq-numeric">
                          {found.length} / {mod.planned}
                        </span>
                      </div>
                      {found.length > 0 ? (
                        <ul className="rq-lesson-links">
                          {found.map((l) => (
                            <li key={l.slug.join('/')}>
                              <Link href={`/learn/${l.slug.join('/')}`}>{l.frontmatter.title}</Link>
                              <span className="rq-lesson-type">{l.frontmatter.type}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="rq-module-pending">Not yet authored.</p>
                      )}
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
