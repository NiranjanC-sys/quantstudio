'use client';

/**
 * Assignments for one cohort: what exists, and the form that adds another.
 *
 * The list comes from `GET /instructor/cohorts/:id`, which returns assignments
 * alongside the cohort and its members, so nothing here fetches a second time.
 * Creation posts to `POST /instructor/cohorts/:id/assignments`, whose body this
 * form matches field for field: title, instructions, lessonIds, points, dueAt,
 * published.
 */

import { useState } from 'react';
import {
  createAssignment,
  formatDate,
  type AssignmentSummary,
  type Failure,
} from '@/lib/instructor';
import { FailureNotice } from './FailureNotice';
import { LessonPicker, type PickedLesson } from './LessonPicker';
import '@/styles/instructor.css';

export function Assignments({
  cohortId,
  assignments,
  onChanged,
}: {
  cohortId: string;
  assignments: AssignmentSummary[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="rq-ins-bar">
        <p className="rq-ins-count rq-numeric">
          {assignments.length} assignment{assignments.length === 1 ? '' : 's'}
        </p>
        <button
          type="button"
          className="rq-btn rq-btn-primary rq-btn-sm"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Close the form' : 'New assignment'}
        </button>
      </div>

      {open ? (
        <AssignmentForm
          cohortId={cohortId}
          onCreated={() => {
            setOpen(false);
            onChanged();
          }}
        />
      ) : null}

      {assignments.length === 0 ? (
        <p className="rq-ins-empty">
          No assignments yet. An assignment that names lessons scores itself from the learner&apos;s
          completed work; one that names none is graded by hand.
        </p>
      ) : (
        <table className="rq-board rq-ins-table">
          <caption className="rq-sr-only">Assignments in this cohort</caption>
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Due</th>
              <th scope="col" className="rq-ins-num">
                Points
              </th>
              <th scope="col" className="rq-ins-num">
                Lessons
              </th>
              <th scope="col">Visibility</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((assignment) => (
              <tr key={assignment.id}>
                <th scope="row">{assignment.title}</th>
                <td>{formatDate(assignment.dueAt)}</td>
                <td className="rq-numeric rq-ins-num">{assignment.points}</td>
                <td className="rq-numeric rq-ins-num">{assignment.lessonIds.length}</td>
                <td>{assignment.published ? 'Published' : 'Draft'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function AssignmentForm({
  cohortId,
  onCreated,
}: {
  cohortId: string;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [points, setPoints] = useState(100);
  const [dueDate, setDueDate] = useState('');
  const [published, setPublished] = useState(false);
  const [lessons, setLessons] = useState<PickedLesson[]>([]);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFailure(null);

    // The gateway coerces `dueAt` with `z.coerce.date()`; a date input gives a
    // calendar day, so it is sent as that day at midnight UTC rather than as a
    // local time that would shift under the reader.
    const dueAt = dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : undefined;

    const res = await createAssignment(cohortId, {
      title: title.trim(),
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      lessonIds: lessons.map((lesson) => lesson.id),
      points,
      ...(dueAt ? { dueAt } : {}),
      published,
    });

    setPending(false);
    if (!res.ok) {
      setFailure(res);
      return;
    }
    onCreated();
  }

  const titleError = failure?.fields.find((error) => error.path === 'title');
  const lessonError = failure?.fields.find((error) => error.path === 'lessonIds');

  return (
    <form className="rq-ins-form" onSubmit={submit} noValidate>
      <h3 className="rq-ins-h3">New assignment</h3>

      <div className="rq-ins-form-grid">
        <p className="rq-ins-field rq-ins-field-wide">
          <label className="rq-field-label" htmlFor="assignment-title">
            Title
          </label>
          <input
            id="assignment-title"
            className="rq-input rq-input-block"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            minLength={2}
            maxLength={200}
            aria-describedby={titleError ? 'assignment-title-error' : undefined}
          />
          {titleError ? (
            <span className="rq-field-error" id="assignment-title-error">
              {titleError.message}
            </span>
          ) : null}
        </p>

        <p className="rq-ins-field">
          <label className="rq-field-label" htmlFor="assignment-points">
            Points
          </label>
          <input
            id="assignment-points"
            className="rq-input rq-input-block rq-numeric"
            type="number"
            min={1}
            max={10000}
            value={points}
            onChange={(event) => setPoints(Number(event.target.value))}
          />
        </p>

        <p className="rq-ins-field">
          <label className="rq-field-label" htmlFor="assignment-due">
            Due date
          </label>
          <input
            id="assignment-due"
            className="rq-input rq-input-block"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            aria-describedby="assignment-due-hint"
          />
          <span className="rq-field-hint" id="assignment-due-hint">
            Optional. Recorded as midnight UTC on that day.
          </span>
        </p>
      </div>

      <p className="rq-ins-field rq-ins-field-wide">
        <label className="rq-field-label" htmlFor="assignment-instructions">
          Instructions
        </label>
        <textarea
          id="assignment-instructions"
          className="rq-input rq-ins-textarea"
          rows={4}
          maxLength={20000}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </p>

      <LessonPicker selected={lessons} onChange={setLessons} />
      {lessonError ? <p className="rq-field-error">{lessonError.message}</p> : null}

      <p className="rq-ins-check">
        <label>
          <input
            type="checkbox"
            checked={published}
            onChange={(event) => setPublished(event.target.checked)}
          />
          Publish to the cohort now
        </label>
      </p>

      {failure && failure.kind !== 'invalid' ? (
        <FailureNotice failure={failure} label="Assignment creation" />
      ) : null}
      {failure && failure.kind === 'invalid' && failure.fields.length === 0 ? (
        <p className="rq-field-error">{failure.detail}</p>
      ) : null}

      <p className="rq-ins-form-actions">
        <button type="submit" className="rq-btn rq-btn-primary rq-btn-sm" disabled={pending}>
          {pending ? 'Creating...' : 'Create assignment'}
        </button>
      </p>
    </form>
  );
}
