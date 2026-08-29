'use client';

/**
 * The question browser.
 *
 * Filtering happens on the client over the whole bank because the bank is a
 * few hundred entries: shipping it once and filtering locally is faster than a
 * round trip per keystroke, and it keeps the page usable offline.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { InterviewQuestion } from '@/lib/interview';

interface Facet {
  companies: [string, number][];
  topics: [string, number][];
  difficulty: [string, number][];
  kind: [string, number][];
}

export function QuestionBrowser({ questions, facets }: { questions: InterviewQuestion[]; facets: Facet }) {
  const [query, setQuery] = useState('');
  const [company, setCompany] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return questions.filter((item) => {
      if (company && !(item.companies ?? []).includes(company)) return false;
      if (difficulty && item.difficulty !== difficulty) return false;
      if (kind && item.kind !== kind) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.prompt.toLowerCase().includes(q) ||
        (item.topics ?? []).some((t) => t.toLowerCase().includes(q)) ||
        (item.pattern ?? '').toLowerCase().includes(q)
      );
    });
  }, [questions, query, company, difficulty, kind]);

  const clear = () => {
    setQuery('');
    setCompany(null);
    setDifficulty(null);
    setKind(null);
  };
  const active = Boolean(query || company || difficulty || kind);

  return (
    <div className="rq-iv">
      <aside className="rq-iv-filters" aria-label="Filters">
        <input
          type="search"
          className="rq-input rq-input-block"
          placeholder="Search questions"
          aria-label="Search questions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <FacetGroup label="Kind" values={facets.kind} selected={kind} onSelect={setKind} />
        <FacetGroup label="Difficulty" values={facets.difficulty} selected={difficulty} onSelect={setDifficulty} />
        <FacetGroup label="Company" values={facets.companies} selected={company} onSelect={setCompany} limit={14} />

        {active && (
          <button type="button" className="rq-btn rq-btn-tertiary rq-btn-sm" onClick={clear}>
            Clear filters
          </button>
        )}
      </aside>

      <div className="rq-iv-results">
        <p className="rq-iv-count rq-numeric" aria-live="polite">
          {filtered.length} of {questions.length}
        </p>
        {filtered.length === 0 ? (
          <p className="rq-empty">Nothing matches that. Try clearing a filter.</p>
        ) : (
          <ol className="rq-iv-list">
            {filtered.map((q) => (
              <li key={q.id}>
                <Link href={`/interview/${q.id}`} className="rq-iv-item">
                  <span className="rq-iv-id rq-numeric">{q.id}</span>
                  <span className="rq-iv-title">{q.title}</span>
                  <span className={`rq-iv-diff rq-iv-diff-${q.difficulty}`}>{q.difficulty}</span>
                </Link>
                <p className="rq-iv-meta">
                  {q.pattern ? <span>{q.pattern}</span> : null}
                  {(q.companies ?? []).slice(0, 4).map((c) => (
                    <span key={c} className="rq-iv-company">{c}</span>
                  ))}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function FacetGroup({
  label, values, selected, onSelect, limit = 8,
}: {
  label: string;
  values: [string, number][];
  selected: string | null;
  onSelect: (v: string | null) => void;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (values.length === 0) return null;
  const shown = expanded ? values : values.slice(0, limit);
  return (
    <fieldset className="rq-facet">
      <legend className="rq-eyebrow">{label}</legend>
      <ul>
        {shown.map(([v, n]) => (
          <li key={v}>
            <button
              type="button"
              className={`rq-facet-btn${selected === v ? ' is-on' : ''}`}
              aria-pressed={selected === v}
              onClick={() => onSelect(selected === v ? null : v)}
            >
              <span>{v}</span>
              <span className="rq-numeric rq-facet-n">{n}</span>
            </button>
          </li>
        ))}
      </ul>
      {values.length > limit && (
        <button type="button" className="rq-btn rq-btn-tertiary rq-btn-sm" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show fewer' : `Show all ${values.length}`}
        </button>
      )}
    </fieldset>
  );
}
