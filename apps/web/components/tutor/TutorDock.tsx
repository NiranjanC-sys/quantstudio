'use client';

/**
 * The tutor, docked.
 *
 * The lab is the point of the product and the tutor is a companion to it, so
 * this is deliberately a corner panel and not a takeover: collapsed it is a
 * single button, expanded it is a fixed column that leaves the canvas, the
 * palette and the inspector where they were. Escape collapses it and returns
 * focus to the button that opened it, which is the behaviour a keyboard user
 * expects from anything that floats.
 *
 * The open state is remembered per browser, so a learner who works with the
 * tutor open does not reopen it on every lesson.
 *
 * Not yet mounted anywhere: `components/lab/LabWorkspace.tsx` belongs to
 * another agent in this build. Wiring it is one line inside `.rq-lab`:
 *   <TutorDock lessonId={lessonId} />
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { TutorPanel } from './TutorPanel';
import '@/styles/tutor.css';

const STORAGE_KEY = 'rq-tutor-dock';

export interface TutorDockProps {
  lessonId?: number;
  contestProblemId?: string;
  /** Which edge the panel hangs off. */
  side?: 'right' | 'bottom';
  /** Open on first render, before any stored preference is read. */
  defaultOpen?: boolean;
}

export function TutorDock({ lessonId, contestProblemId, side = 'right', defaultOpen = false }: TutorDockProps) {
  const panelId = `${useId()}-dock`;
  const [open, setOpen] = useState(defaultOpen);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Read after mount rather than during render: the server has no localStorage
  // and a differing first paint is a hydration error, not a preference.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'open') setOpen(true);
      else if (stored === 'closed') setOpen(false);
    } catch {
      // A browser with storage disabled just gets the default.
    }
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    try {
      window.localStorage.setItem(STORAGE_KEY, 'closed');
    } catch {
      /* ignore */
    }
    launcherRef.current?.focus();
  }, []);

  const openDock = useCallback(() => {
    setOpen(true);
    try {
      window.localStorage.setItem(STORAGE_KEY, 'open');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const node = panelRef.current;
    node?.addEventListener('keydown', onKey);
    return () => node?.removeEventListener('keydown', onKey);
  }, [open, close]);

  return (
    <div className="rq-tutor-dock-root" data-side={side} data-open={open ? 'true' : 'false'}>
      <button
        ref={launcherRef}
        type="button"
        className="rq-btn rq-btn-secondary rq-btn-sm rq-tutor-dock-launch"
        aria-expanded={open}
        {...(open ? { 'aria-controls': panelId } : {})}
        onClick={() => (open ? close() : openDock())}
      >
        {open ? 'Hide tutor' : 'Ask the tutor'}
      </button>

      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          className="rq-tutor-dock"
          data-register="instrument"
          role="complementary"
          aria-label="AI tutor dock"
        >
          <TutorPanel
            variant="dock"
            {...(lessonId !== undefined ? { lessonId } : {})}
            {...(contestProblemId !== undefined ? { contestProblemId } : {})}
            headerExtra={
              <>
                <Link className="rq-btn rq-btn-tertiary rq-btn-sm" href="/tutor">Full page</Link>
                <button type="button" className="rq-btn rq-btn-secondary rq-btn-sm" onClick={close}>
                  Close
                </button>
              </>
            }
          />
        </div>
      ) : null}
    </div>
  );
}
