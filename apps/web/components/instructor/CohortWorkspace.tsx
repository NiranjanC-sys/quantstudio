'use client';

/**
 * One cohort: its roster, its mastery heatmap, its assignments and its
 * gradebook.
 *
 * The panels load independently. A cohort whose heatmap is slow still shows its
 * roster, and a failure in one panel never blanks the others, because each one
 * owns its own state and renders its own reason for being empty.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  formatDate,
  getCohort,
  getHeatmap,
  type CohortDetail,
  type Failure,
  type Heatmap,
} from '@/lib/instructor';
import { Assignments } from './Assignments';
import { FailureNotice, Pending } from './FailureNotice';
import { Gradebook } from './Gradebook';
import { MasteryHeatmap } from './MasteryHeatmap';
import '@/styles/instructor.css';

const TABS = [
  { id: 'roster', label: 'Roster' },
  { id: 'mastery', label: 'Mastery' },
  { id: 'assignments', label: 'Assignments' },
  { id: 'gradebook', label: 'Gradebook' },
] as const;

type TabId = (typeof TABS)[number]['id'];

type DetailState =
  | { kind: 'loading' }
  | { kind: 'failed'; failure: Failure }
  | { kind: 'ready'; detail: CohortDetail };

export function CohortWorkspace({ cohortId }: { cohortId: string }) {
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [tab, setTab] = useState<TabId>('roster');

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const res = await getCohort(cohortId);
    setState(res.ok ? { kind: 'ready', detail: res.data } : { kind: 'failed', failure: res });
  }, [cohortId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') return <Pending label="this cohort" />;
  if (state.kind === 'failed') {
    return <FailureNotice failure={state.failure} onRetry={() => void load()} label="This cohort" />;
  }

  const { cohort, members, assignments } = state.detail;
  const students = members.filter((member) => member.role === 'student');
  const assistants = members.filter((member) => member.role === 'assistant');

  return (
    <>
      <p className="rq-ins-crumb">
        <Link className="rq-ins-a" href="/instructor">
          Cohorts
        </Link>
      </p>

      <h1 className="rq-display rq-display-sm">{cohort.name}</h1>

      <dl className="rq-stat-grid">
        <div className="rq-stat-card">
          <dt>Students</dt>
          <dd>{students.length}</dd>
          <span className="rq-stat-sub">
            {assistants.length} assistant{assistants.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="rq-stat-card">
          <dt>Assignments</dt>
          <dd>{assignments.length}</dd>
          <span className="rq-stat-sub">
            {assignments.filter((assignment) => assignment.published).length} published
          </span>
        </div>
        <div className="rq-stat-card">
          <dt>Join code</dt>
          <dd>{cohort.joinCode}</dd>
          <span className="rq-stat-sub">learners enter this to join</span>
        </div>
        <div className="rq-stat-card">
          <dt>Term</dt>
          <dd className="rq-ins-stat-text">{cohort.term ?? 'None'}</dd>
          <span className="rq-stat-sub">created {formatDate(cohort.createdAt)}</span>
        </div>
      </dl>

      <div className="rq-tabs rq-tabs-lg" role="tablist" aria-label="Cohort views">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`panel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            className={`rq-tab${tab === entry.id ? ' is-active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {TABS.map((entry) => (
        <section
          key={entry.id}
          role="tabpanel"
          id={`panel-${entry.id}`}
          aria-labelledby={`tab-${entry.id}`}
          hidden={tab !== entry.id}
          tabIndex={0}
          className="rq-ins-panel"
        >
          {tab !== entry.id ? null : entry.id === 'roster' ? (
            <Roster detail={state.detail} />
          ) : entry.id === 'mastery' ? (
            <MasteryPanel cohortId={cohortId} />
          ) : entry.id === 'assignments' ? (
            <Assignments
              cohortId={cohortId}
              assignments={assignments}
              onChanged={() => void load()}
            />
          ) : (
            <Gradebook cohortId={cohortId} cohortSlug={cohort.slug} />
          )}
        </section>
      ))}
    </>
  );
}

function Roster({ detail }: { detail: CohortDetail }) {
  if (detail.members.length === 0) {
    return (
      <p className="rq-ins-empty">
        Nobody has joined yet. Learners join with the code{' '}
        <span className="rq-numeric">{detail.cohort.joinCode}</span>.
      </p>
    );
  }

  return (
    <table className="rq-board rq-ins-table">
      <caption className="rq-sr-only">Active members of this cohort</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Handle</th>
          <th scope="col">Email</th>
          <th scope="col">Role</th>
          <th scope="col">Joined</th>
        </tr>
      </thead>
      <tbody>
        {detail.members.map((member) => (
          <tr key={member.userId}>
            <th scope="row">{member.displayName}</th>
            <td className="rq-mono">{member.handle}</td>
            <td className="rq-ins-muted">{member.email}</td>
            <td>{member.role === 'assistant' ? 'Assistant' : 'Student'}</td>
            <td>{formatDate(member.joinedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MasteryPanel({ cohortId }: { cohortId: string }) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'failed'; failure: Failure } | { kind: 'ready'; heatmap: Heatmap }
  >({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const res = await getHeatmap(cohortId);
    setState(res.ok ? { kind: 'ready', heatmap: res.data } : { kind: 'failed', failure: res });
  }, [cohortId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') return <Pending label="the mastery heatmap" />;
  if (state.kind === 'failed') {
    return <FailureNotice failure={state.failure} onRetry={() => void load()} label="The heatmap" />;
  }

  return (
    <>
      <p className="rq-ins-prose">
        Mastery is the learner&apos;s own figure, decayed to now by the same forgetting curve their
        dashboard uses. This view joins onto it; it does not keep a second copy that could disagree.
      </p>
      <MasteryHeatmap heatmap={state.heatmap} />
    </>
  );
}
