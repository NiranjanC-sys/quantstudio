'use client';

/**
 * The cohorts this account teaches, and the form that makes another one.
 *
 * `GET /instructor/cohorts` is gated three ways on the server: a session, the
 * instructor role with MFA satisfied, and the `instructor.dashboard`
 * entitlement. Each of those failures reaches the reader as a different
 * sentence with a different next step, which is the whole reason this client
 * keeps the problem `code` rather than only the status.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  createCohort,
  listCohorts,
  type CohortSummary,
  type Failure,
  type FieldError,
} from '@/lib/instructor';
import { FailureNotice, Pending } from './FailureNotice';
import '@/styles/instructor.css';

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; failure: Failure }
  | { kind: 'ready'; cohorts: CohortSummary[] };

export function CohortList() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const res = await listCohorts();
    setState(res.ok ? { kind: 'ready', cohorts: res.data.items } : { kind: 'failed', failure: res });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') return <Pending label="your cohorts" />;
  if (state.kind === 'failed') {
    return <FailureNotice failure={state.failure} onRetry={() => void load()} label="Cohorts" />;
  }

  return (
    <>
      <div className="rq-ins-bar">
        <p className="rq-ins-count rq-numeric">
          {state.cohorts.length} cohort{state.cohorts.length === 1 ? '' : 's'}
        </p>
        <button
          type="button"
          className="rq-btn rq-btn-primary rq-btn-sm"
          aria-expanded={creating}
          onClick={() => setCreating((open) => !open)}
        >
          {creating ? 'Close the form' : 'New cohort'}
        </button>
      </div>

      {creating ? (
        <CohortForm
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      ) : null}

      {state.cohorts.length === 0 ? (
        <p className="rq-ins-empty">
          You do not teach a cohort yet. Create one and share its join code with your class.
        </p>
      ) : (
        <table className="rq-board rq-ins-table">
          <caption className="rq-sr-only">Cohorts you teach, with member counts and join codes</caption>
          <thead>
            <tr>
              <th scope="col">Cohort</th>
              <th scope="col">Term</th>
              <th scope="col">Organisation</th>
              <th scope="col" className="rq-ins-num">
                Members
              </th>
              <th scope="col">Join code</th>
            </tr>
          </thead>
          <tbody>
            {state.cohorts.map((cohort) => (
              <tr key={cohort.id}>
                <th scope="row">
                  <Link className="rq-ins-a" href={`/instructor/${cohort.id}`}>
                    {cohort.name}
                  </Link>
                  {cohort.archived ? <span className="rq-ins-flag">Archived</span> : null}
                </th>
                <td>{cohort.term ?? 'No term set'}</td>
                <td className="rq-ins-muted">{cohort.orgName}</td>
                <td className="rq-numeric rq-ins-num">{cohort.memberCount}</td>
                <td className="rq-numeric">{cohort.joinCode}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

const TRACK_CODES = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/**
 * The gateway's own validation is the only validation that counts, so this form
 * mirrors its rules rather than inventing softer ones: a slug of lowercase,
 * digits and hyphens starting with an alphanumeric, a name of at least two
 * characters, and an optional track code of the form T0 to T9.
 */
function CohortForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [term, setTerm] = useState('');
  const [trackCode, setTrackCode] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [created, setCreated] = useState<{ joinCode: string } | null>(null);

  function fieldError(path: string): FieldError | undefined {
    return failure?.fields.find((error) => error.path === path);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFailure(null);
    const res = await createCohort({
      name: name.trim(),
      slug: slug.trim(),
      ...(term.trim() ? { term: term.trim() } : {}),
      ...(trackCode ? { trackCode } : {}),
    });
    setPending(false);
    if (!res.ok) {
      setFailure(res);
      return;
    }
    setCreated({ joinCode: res.data.joinCode });
    onCreated();
  }

  if (created) {
    return (
      <p className="rq-ins-created" role="status">
        Cohort created. Its join code is <span className="rq-numeric">{created.joinCode}</span>.
      </p>
    );
  }

  return (
    <form className="rq-ins-form" onSubmit={submit} noValidate>
      <h2 className="rq-ins-h3">New cohort</h2>

      <div className="rq-ins-form-grid">
        <p className="rq-ins-field">
          <label className="rq-field-label" htmlFor="cohort-name">
            Name
          </label>
          <input
            id="cohort-name"
            className="rq-input rq-input-block"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            minLength={2}
            maxLength={120}
            aria-describedby={fieldError('name') ? 'cohort-name-error' : undefined}
          />
          {fieldError('name') ? (
            <span className="rq-field-error" id="cohort-name-error">
              {fieldError('name')?.message}
            </span>
          ) : null}
        </p>

        <p className="rq-ins-field">
          <label className="rq-field-label" htmlFor="cohort-slug">
            Slug
          </label>
          <input
            id="cohort-slug"
            className="rq-input rq-input-block rq-mono"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            required
            pattern="[a-z0-9][a-z0-9-]{1,62}"
            aria-describedby={`cohort-slug-hint${fieldError('slug') ? ' cohort-slug-error' : ''}`}
          />
          <span className="rq-field-hint" id="cohort-slug-hint">
            Lowercase letters, digits and hyphens. Unique within your organisation.
          </span>
          {fieldError('slug') ? (
            <span className="rq-field-error" id="cohort-slug-error">
              {fieldError('slug')?.message}
            </span>
          ) : null}
        </p>

        <p className="rq-ins-field">
          <label className="rq-field-label" htmlFor="cohort-term">
            Term
          </label>
          <input
            id="cohort-term"
            className="rq-input rq-input-block"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            maxLength={64}
            placeholder="Autumn 2026"
          />
        </p>

        <p className="rq-ins-field">
          <label className="rq-field-label" htmlFor="cohort-track">
            Track
          </label>
          <select
            id="cohort-track"
            className="rq-input rq-input-block"
            value={trackCode}
            onChange={(event) => setTrackCode(event.target.value)}
          >
            <option value="">No track</option>
            {TRACK_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </p>
      </div>

      {failure && failure.kind !== 'invalid' ? (
        <FailureNotice failure={failure} label="Cohort creation" />
      ) : null}
      {failure && failure.kind === 'invalid' && failure.fields.length === 0 ? (
        <p className="rq-field-error">{failure.detail}</p>
      ) : null}

      <p className="rq-ins-form-actions">
        <button type="submit" className="rq-btn rq-btn-primary rq-btn-sm" disabled={pending}>
          {pending ? 'Creating...' : 'Create cohort'}
        </button>
      </p>
    </form>
  );
}
