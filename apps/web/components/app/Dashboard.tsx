'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type NextLesson, type ProgressOverview } from '@/lib/api';
import { Loading, Unavailable } from './RemoteState';


export function Dashboard() {
  const [overview, setOverview] = useState<
    { kind: 'loading' } | { kind: 'error'; detail: string } | { kind: 'ready'; data: ProgressOverview }
  >({ kind: 'loading' });
  const [next, setNext] = useState<NextLesson[] | null>(null);

  const load = useCallback(async () => {
    setOverview({ kind: 'loading' });
    const [o, n] = await Promise.all([
      api<ProgressOverview>('/progress/overview'),
      api<{ items: NextLesson[] }>('/progress/next?limit=5'),
    ]);
    setOverview(o.ok ? { kind: 'ready', data: o.data } : { kind: 'error', detail: o.detail });
    setNext(n.ok ? n.data.items : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (overview.kind === 'loading') return <Loading label="your progress" />;
  if (overview.kind === 'error') return <Unavailable detail={overview.detail} onRetry={() => void load()} />;

  const { xp, streak, mastery, reviewsDue } = overview.data;

  return (
    <>
      <dl className="rq-stat-grid">
        <div className="rq-stat-card">
          <dt>Experience</dt>
          <dd>{xp.total.toLocaleString('en')}</dd>
        </div>
        <div className="rq-stat-card">
          <dt>Streak</dt>
          <dd>{streak?.current ?? 0}</dd>
          <span className="rq-stat-sub">longest {streak?.longest ?? 0} days</span>
        </div>
        <div className="rq-stat-card">
          <dt>Due for review</dt>
          <dd>{reviewsDue}</dd>
          <span className="rq-stat-sub">cards scheduled today</span>
        </div>
        <div className="rq-stat-card">
          <dt>Average mastery</dt>
          <dd>{mastery ? `${Math.round(mastery.overall * 100)}%` : '0%'}</dd>
          <span className="rq-stat-sub">{mastery?.unlockedCount ?? 0} lessons unlocked</span>
        </div>
      </dl>

      <section aria-labelledby="next-up">
        <h2 id="next-up" className="rq-h2">What to do next.</h2>
        <p className="rq-section-sub">
          Chosen by the lowest mastery among lessons whose prerequisites you have already cleared,
          not by where you stopped reading.
        </p>
        {next === null ? (
          <p className="rq-remote rq-remote-empty">Recommendations are unavailable right now.</p>
        ) : next.length === 0 ? (
          <p className="rq-remote rq-remote-empty">
            Nothing queued. <Link href="/curriculum" className="rq-lesson-a">Pick a track</Link> to begin.
          </p>
        ) : (
          <ol className="rq-next-list">
            {next.map((l) => (
              <li key={l.id}>
                <span className="rq-numeric rq-next-id">{l.trackCode}.{l.moduleCode.split('.')[1]}</span>
                <div>
                  <Link href={`/curriculum#${l.trackCode.toLowerCase()}`}>{l.title}</Link>
                </div>
                <span className="rq-lesson-type">{l.kind}</span>
                <span className="rq-numeric rq-next-min">{l.estimatedMinutes} min</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
