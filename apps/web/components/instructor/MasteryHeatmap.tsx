'use client';

/**
 * Per-concept mastery across a cohort.
 *
 * The grid is a real `<table>`, not a div lattice with a table hidden beside it
 * for screen readers. One artefact means the two can never disagree, and it
 * means the "accessible fallback" is the thing everybody is looking at.
 *
 * Three rules the rendering obeys:
 *
 *  - Colour never carries meaning alone. Every cell prints its own percentage
 *    in tabular figures; the background is a second, redundant channel. The
 *    five band colours were chosen so the theme's body ink clears 4.5:1 on each
 *    of them, in both palettes.
 *  - A missing observation is not a zero. The gateway only emits a cell where
 *    `progress.concept_mastery` has a row, so anything absent is printed "n/a"
 *    and excluded from every average shown here.
 *  - The numbers are the gateway's. Mastery arrives already decayed to now by
 *    the learner's own forgetting curve, so nothing is recomputed in the
 *    browser and an instructor cannot be shown a figure the learner would
 *    dispute.
 */

import { useMemo, useState } from 'react';
import {
  MASTERY_BANDS,
  formatPercent,
  indexHeatmap,
  masteryBand,
  type Heatmap,
} from '@/lib/instructor';
import '@/styles/instructor.css';

type Order = 'curriculum' | 'weakest';

export function MasteryHeatmap({ heatmap }: { heatmap: Heatmap }) {
  const [order, setOrder] = useState<Order>('curriculum');

  const cells = useMemo(() => indexHeatmap(heatmap.cells), [heatmap.cells]);
  const summary = heatmap.summary ?? [];

  const concepts = useMemo(() => {
    if (order === 'curriculum' || summary.length === 0) return heatmap.concepts;
    // `summary` arrives sorted weakest first, and carries the same concepts.
    return summary.map((row) => ({ id: row.id, slug: row.slug, title: row.title }));
  }, [order, summary, heatmap.concepts]);

  const meanById = useMemo(
    () => new Map(summary.map((row) => [row.id, row])),
    [summary],
  );

  if (heatmap.students.length === 0) {
    return (
      <p className="rq-ins-empty">
        This cohort has no active members yet. Share the join code and the heatmap fills in as
        people work.
      </p>
    );
  }

  if (heatmap.concepts.length === 0) {
    return (
      <p className="rq-ins-empty">
        Nobody in this cohort has a graded interaction yet, so there is no mastery to show. This is
        an empty record, not a score of zero.
      </p>
    );
  }

  const observed = heatmap.cells.length;
  const possible = heatmap.students.length * heatmap.concepts.length;

  return (
    <>
      <div className="rq-ins-heat-controls">
        <p className="rq-ins-heat-count rq-numeric">
          {observed} of {possible} cells observed
        </p>
        <label className="rq-ins-select-label" htmlFor="heat-order">
          Order concepts
          <select
            id="heat-order"
            className="rq-input rq-ins-select"
            value={order}
            onChange={(event) => setOrder(event.target.value as Order)}
          >
            <option value="curriculum">Curriculum order</option>
            <option value="weakest">Weakest first</option>
          </select>
        </label>
      </div>

      <Legend />

      <div
        className="rq-ins-scroll"
        role="region"
        aria-label="Mastery heatmap, scrollable"
        tabIndex={0}
      >
        <table className="rq-heat">
          <caption className="rq-sr-only">
            Concept mastery for {heatmap.students.length} students across {concepts.length}{' '}
            concepts. Each cell gives that student&apos;s mastery as a percentage, decayed to now.
            Cells reading n/a have no recorded observation.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="rq-heat-corner">
                Student
              </th>
              {concepts.map((concept) => {
                const row = meanById.get(concept.id);
                return (
                  <th scope="col" key={concept.id} className="rq-heat-col">
                    <span className="rq-heat-col-title">{concept.title}</span>
                    {row ? (
                      <span className="rq-numeric rq-heat-col-mean">
                        mean {formatPercent(row.mean)}
                      </span>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {heatmap.students.map((student) => (
              <tr key={student.userId}>
                <th scope="row" className="rq-heat-row">
                  {student.displayName}
                </th>
                {concepts.map((concept) => {
                  const cell = cells.get(`${student.userId}:${concept.id}`);
                  if (!cell) {
                    return (
                      <td key={concept.id} className="rq-heat-cell is-absent">
                        <span className="rq-numeric">n/a</span>
                      </td>
                    );
                  }
                  return (
                    <td
                      key={concept.id}
                      className="rq-heat-cell"
                      data-band={masteryBand(cell.mastery)}
                      title={`${student.displayName}, ${concept.title}: ${formatPercent(
                        cell.mastery,
                      )} from ${cell.observations} observation${cell.observations === 1 ? '' : 's'}`}
                    >
                      <span className="rq-numeric">{formatPercent(cell.mastery)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Weakest heatmap={heatmap} />
    </>
  );
}

function Legend() {
  return (
    <div className="rq-heat-legend">
      <p className="rq-eyebrow" id="heat-legend-label">
        Mastery scale
      </p>
      <ul aria-labelledby="heat-legend-label">
        {MASTERY_BANDS.map((band, index) => (
          <li key={band.label}>
            <span className="rq-heat-swatch" data-band={index} aria-hidden="true" />
            <span className="rq-numeric">{band.label}</span>
          </li>
        ))}
        <li>
          <span className="rq-heat-swatch is-absent" aria-hidden="true" />
          <span className="rq-numeric">n/a, no observation</span>
        </li>
      </ul>
    </div>
  );
}

/**
 * What an instructor actually acts on. `coverage` is printed beside the mean
 * because a mean over one student out of thirty is not a class-wide finding,
 * and the API is honest enough to hand us the denominator.
 */
function Weakest({ heatmap }: { heatmap: Heatmap }) {
  const weakest = heatmap.weakest ?? [];
  if (weakest.length === 0) return null;

  return (
    <section className="rq-ins-subsection" aria-labelledby="weakest-heading">
      <h3 id="weakest-heading" className="rq-ins-h3">
        Where the cohort is weakest
      </h3>
      <p className="rq-ins-prose">
        Ranked by mean mastery among the students who have a record. Coverage says how much of the
        cohort that mean is drawn from.
      </p>
      <table className="rq-board rq-ins-table">
        <thead>
          <tr>
            <th scope="col">Concept</th>
            <th scope="col" className="rq-ins-num">
              Mean mastery
            </th>
            <th scope="col" className="rq-ins-num">
              Coverage
            </th>
            <th scope="col" className="rq-ins-num">
              Below 70%
            </th>
          </tr>
        </thead>
        <tbody>
          {weakest.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.title}</th>
              <td className="rq-numeric rq-ins-num">{formatPercent(row.mean)}</td>
              <td className="rq-numeric rq-ins-num">
                {Math.round(row.coverage * heatmap.students.length)} of {heatmap.students.length}
              </td>
              <td className="rq-numeric rq-ins-num">{row.strugglingCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
