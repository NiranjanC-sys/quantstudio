import type { Metadata } from 'next';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { listCompanies } from '@/lib/interview';

export const metadata: Metadata = {
  title: 'Employer briefings',
  description: 'Who is hiring in quantum, what modality they build on, and what they actually ask.',
};

export default async function CompaniesPage() {
  const companies = await listCompanies();

  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section rq-section-tight">
          <h1 className="rq-display rq-display-sm">Employer briefings.</h1>
          <p className="rq-section-sub">
            Modality, primary SDK, and the questions each employer actually asks. Where a detail
            could not be confirmed from published sources, the entry describes the shape of the work
            rather than inventing specifics.
          </p>
        </section>

        {companies.length === 0 ? (
          <section className="rq-section"><p className="rq-empty">Briefings are still being written.</p></section>
        ) : (
          companies.map((c) => (
            <section key={c.id} className="rq-section rq-company" aria-labelledby={c.id}>
              <div className="rq-split">
                <div className="rq-split-narrow">
                  <h2 id={c.id} className="rq-h2">{c.name}</h2>
                  <dl className="rq-company-facts">
                    <div><dt>Modality</dt><dd>{c.modality}</dd></div>
                    <div><dt>Primary SDK</dt><dd>{c.primarySdk}</dd></div>
                  </dl>
                  <ul className="rq-company-links">
                    {(c.links ?? []).map((l) => (
                      <li key={l.url}>
                        <a className="rq-lesson-a" href={l.url} target="_blank" rel="noreferrer noopener">{l.label}</a>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rq-split-wide">
                  {c.notes ? <p className="rq-prose-p">{c.notes}</p> : null}
                  <h3 className="rq-eyebrow">What they ask</h3>
                  <ul className="rq-lesson-ul rq-company-asks">
                    {(c.asks ?? []).map((a) => <li key={a}>{a}</li>)}
                  </ul>
                  <h3 className="rq-eyebrow">Typical roles</h3>
                  <ul className="rq-source-list">
                    {(c.roles ?? []).map((r) => <li key={r} className="rq-tag">{r}</li>)}
                  </ul>
                </div>
              </div>
            </section>
          ))
        )}
      </main>
      <SiteFooter />
    </>
  );
}
