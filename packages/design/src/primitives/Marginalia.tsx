import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';

export interface MarginaliaProps extends HTMLAttributes<HTMLElement> {
  /** The word being defined. Rendered above the note in `--ink`. */
  term?: ReactNode;
  /** Source citation, rendered last and faintest. */
  cite?: ReactNode;
  /**
   * Place in the 200px right rail on viewports at or above 1180px. Below that
   * it collapses inline as a bordered aside. The containing element must be
   * `position: relative`, which `.rq-monograph` already is.
   */
  rail?: boolean;
  children?: ReactNode;
}

/**
 * Definitions, notation reminders and citations beside the prose column.
 *
 * 13px Instrument Sans in `--ink-subtle`, with a 2px `--accent-wash` left rule.
 * It never carries anything the reader must have in order to follow the text.
 */
export const Marginalia = forwardRef<HTMLElement, MarginaliaProps>(function Marginalia(
  { term, cite, rail = true, className, children, ...props },
  ref,
) {
  return (
    <aside
      ref={ref}
      className={cx('rq-marginalia', className)}
      data-rail={rail ? 'true' : undefined}
      {...props}
    >
      {term === undefined ? null : <strong className="rq-marginalia__term">{term}</strong>}
      {children}
      {cite === undefined ? null : <cite className="rq-marginalia__cite">{cite}</cite>}
    </aside>
  );
});
