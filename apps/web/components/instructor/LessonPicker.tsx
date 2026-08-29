'use client';

/**
 * Chooses the lessons an assignment covers.
 *
 * The gateway validates `lessonIds` against `catalog.lessons` and returns the
 * ids it did not recognise, so a form that asked an instructor to type integers
 * would be a machine talking to a human in the machine's units. This walks the
 * same catalogue the learner sees, track to module to lesson, and hands the
 * gateway ids it read from the catalogue itself.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getModule,
  getTrack,
  listTracks,
  type Failure,
  type LessonSummary,
  type ModuleSummary,
  type TrackSummary,
} from '@/lib/instructor';
import { FailureNotice } from './FailureNotice';
import '@/styles/instructor.css';

export interface PickedLesson {
  id: number;
  title: string;
}

export function LessonPicker({
  selected,
  onChange,
}: {
  selected: PickedLesson[];
  onChange: (next: PickedLesson[]) => void;
}) {
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [trackCode, setTrackCode] = useState('');
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [moduleCode, setModuleCode] = useState('');
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await listTracks();
      if (!live) return;
      if (res.ok) setTracks(res.data.items);
      else setFailure(res);
    })();
    return () => {
      live = false;
    };
  }, []);

  const chooseTrack = useCallback(async (code: string) => {
    setTrackCode(code);
    setModuleCode('');
    setModules([]);
    setLessons([]);
    if (!code) return;
    setBusy(true);
    const res = await getTrack(code);
    setBusy(false);
    if (res.ok) setModules(res.data.modules);
    else setFailure(res);
  }, []);

  const chooseModule = useCallback(async (code: string) => {
    setModuleCode(code);
    setLessons([]);
    if (!code) return;
    setBusy(true);
    const res = await getModule(code);
    setBusy(false);
    if (res.ok) setLessons(res.data.lessons);
    else setFailure(res);
  }, []);

  function toggle(lesson: LessonSummary) {
    const already = selected.some((item) => item.id === lesson.id);
    onChange(
      already
        ? selected.filter((item) => item.id !== lesson.id)
        : [...selected, { id: lesson.id, title: lesson.title }],
    );
  }

  return (
    <fieldset className="rq-ins-picker">
      <legend className="rq-field-label">Lessons covered</legend>

      {failure ? <FailureNotice failure={failure} label="The catalogue" /> : null}

      <div className="rq-ins-picker-selects">
        <label className="rq-ins-select-label" htmlFor="pick-track">
          Track
          <select
            id="pick-track"
            className="rq-input rq-ins-select"
            value={trackCode}
            onChange={(event) => void chooseTrack(event.target.value)}
          >
            <option value="">Choose a track</option>
            {tracks.map((track) => (
              <option key={track.code} value={track.code}>
                {track.code}. {track.title}
              </option>
            ))}
          </select>
        </label>

        <label className="rq-ins-select-label" htmlFor="pick-module">
          Module
          <select
            id="pick-module"
            className="rq-input rq-ins-select"
            value={moduleCode}
            onChange={(event) => void chooseModule(event.target.value)}
            disabled={modules.length === 0}
          >
            <option value="">{modules.length === 0 ? 'Choose a track first' : 'Choose a module'}</option>
            {modules.map((module) => (
              <option key={module.code} value={module.code}>
                {module.code}. {module.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div aria-live="polite">
        {busy ? <p className="rq-ins-pending">Loading the catalogue...</p> : null}
        {!busy && moduleCode && lessons.length === 0 ? (
          <p className="rq-ins-empty">That module has no lessons in the catalogue.</p>
        ) : null}
      </div>

      {lessons.length > 0 ? (
        <ul className="rq-ins-lesson-list">
          {lessons.map((lesson) => {
            const checked = selected.some((item) => item.id === lesson.id);
            return (
              <li key={lesson.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(lesson)}
                  />
                  <span className="rq-ins-lesson-title">{lesson.title}</span>
                  <span className="rq-ins-lesson-kind">{lesson.kind}</span>
                  <span className="rq-numeric rq-ins-lesson-min">{lesson.estimatedMinutes} min</span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="rq-ins-picked">
        <p className="rq-eyebrow" id="picked-label">
          Selected
        </p>
        {selected.length === 0 ? (
          <p className="rq-ins-muted">
            None yet. An assignment with no lessons still records a grade, but nothing is scored
            automatically.
          </p>
        ) : (
          <ul aria-labelledby="picked-label" className="rq-ins-chips">
            {selected.map((lesson) => (
              <li key={lesson.id}>
                <span>{lesson.title}</span>
                <button
                  type="button"
                  className="rq-ins-chip-remove"
                  onClick={() => onChange(selected.filter((item) => item.id !== lesson.id))}
                >
                  <span aria-hidden="true">x</span>
                  <span className="rq-sr-only">Remove {lesson.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </fieldset>
  );
}
