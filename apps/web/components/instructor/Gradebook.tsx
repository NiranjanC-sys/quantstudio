'use client';

/**
 * The gradebook, and the CSV the gateway builds from exactly the same figures.
 *
 * Each cell carries two numbers from the API: `autoScore`, what the learner's
 * completed lessons imply, and `score`, what an instructor recorded by hand.
 * `effectiveScore` is the second if it exists and the first otherwise. Showing
 * only the effective score would hide the interesting case, so a cell whose
 * manual score disagrees with the automatic one is marked, and the marker is
 * explained in a legend rather than left as a mystery glyph.
 *
 * The export is not a link. `GET /instructor/cohorts/:id/export.csv` needs the
 * session cookie, so it is fetched with credentials and saved as a blob under
 * the filename the gateway chose.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  GRADE_STATUS_LABEL,
  downloadGradebookCsv,
  formatDate,
  formatPercent,
  getGradebook,
  type Failure,
  type Gradebook as GradebookData,
  type GradebookCell,
} from '@/lib/instructor';
import { FailureNotice, Pending } from './FailureNotice';
import '@/styles/instructor.css';

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; failure: Failure }
  | { kind: 'ready'; data: GradebookData };

/** True when a human wrote a score the platform would not have computed. */
function isOverride(cell: GradebookCell): boolean {
  if (cell.score === null || cell.autoScore === null) return false;
  return Math.abs(cell.score - cell.autoScore) > 0.005;
}

export function Gradebook({ cohortId, cohortSlug }: { cohortId: string; cohortSlug: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [exporting, setExporting] = useState(false);
  const [exportFailure, setExportFailure] = useState<Failure | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const res = await getGradebook(cohortId);
    setState(res.ok ? { kind: 'ready', data: res.data } : { kind: 'failed', failure: res });
  }, [cohortId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function exportCsv() {
    setExporting(true);
    setExportFailure(null);
    setExported(null);
    const res = await downloadGradebookCsv(cohortId, `${cohortSlug}-gradebook.csv`);
    setExporting(false);
    if (res.ok) setExported(res.data.filename);
    else setExportFailure(res);
  }

  if (state.kind === 'loading') return <Pending label="the gradebook" />;
  if (state.kind === 'failed') {
    return <FailureNotice failure={state.failure} onRetry={() => void load()} label="The gradebook" />;
  }

  const { assignments, rows } = state.data;

  return (
    <>
      <div className="rq-ins-bar">
        <p className="rq-ins-count rq-numeric">
          {rows.length} student{rows.length === 1 ? '' : 's'}, {assignments.length} assignment
          {assignments.length === 1 ? '' : 's'}
        </p>
        <button
          type="button"
          className="rq-btn rq-btn-secondary rq-btn-sm"
          onClick={() => void exportCsv()}
          disabled={exporting || rows.length === 0}
        >
          {exporting ? 'Building the CSV...' : 'Export CSV'}
        </button>
      </div>

      <div aria-live="polite">
        {exported ? (
          <p className="rq-ins-created">Saved {exported}.</p>
        ) : null}
      </div>
      {exportFailure ? (
        <FailureNotice failure={exportFailure} onRetry={() => void exportCsv()} label="The export" />
      ) : null}

      {rows.length === 0 ? (
        <p className="rq-ins-empty">Nobody has joined this cohort, so there is nothing to grade.</p>
      ) : assignments.length === 0 ? (
        <p className="rq-ins-empty">
          This cohort has no assignments. Add one and every member appears here with a score.
        </p>
      ) : (
        <>
          <div
            className="rq-ins-scroll"
            role="region"
            aria-label="Gradebook, scrollable"
            tabIndex={0}
          >
            <table className="rq-heat rq-grade">
              <caption className="rq-sr-only">
                Scores for {rows.length} students across {assignments.length} assignments. Each cell
                is the effective score as a percentage of the assignment&apos;s points. Cells marked
                &quot;set by hand&quot; carry an instructor score that differs from the score the
                platform computed.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="rq-heat-corner">
                    Student
                  </th>
                  {assignments.map((assignment) => (
                    <th scope="col" key={assignment.id} className="rq-heat-col">
                      <span className="rq-heat-col-title">{assignment.title}</span>
                      <span className="rq-numeric rq-heat-col-mean">
                        {assignment.points} pts, due {formatDate(assignment.dueAt)}
                      </span>
                    </th>
                  ))}
                  <th scope="col" className="rq-heat-col rq-grade-overall-head">
                    Overall
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.userId}>
                    <th scope="row" className="rq-heat-row">
                      {row.displayName}
                      <span className="rq-ins-handle rq-mono">{row.handle}</span>
                    </th>
                    {row.cells.map((cell) => (
                      <td key={cell.assignmentId} className="rq-grade-cell">
                        <span className="rq-numeric">
                          {cell.effectiveScore === null ? 'n/a' : formatPercent(cell.effectiveScore)}
                        </span>
                        <span className="rq-grade-status">
                          {GRADE_STATUS_LABEL[cell.status]}
                          {isOverride(cell) ? ', set by hand' : ''}
                        </span>
                      </td>
                    ))}
                    <td className="rq-grade-cell rq-grade-overall">
                      <span className="rq-numeric">
                        {row.overall === null ? 'n/a' : formatPercent(row.overall)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="rq-ins-prose">
            A score of n/a means the assignment names no lesson and nobody has graded it yet, which
            is not the same as a zero. Overall is the points-weighted mean of the cells that have a
            score.
          </p>
        </>
      )}
    </>
  );
}
