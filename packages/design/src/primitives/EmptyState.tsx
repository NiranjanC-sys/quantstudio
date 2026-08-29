import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons. Keep it to one primary and at most one secondary. */
  actions?: ReactNode;
  children?: ReactNode;
}

/**
 * Nothing here yet, and what to do about it.
 *
 * Left-aligned on purpose: DESIGN.md forbids centring body copy, and a centred
 * empty state is the most common place that rule gets broken.
 */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { title, description, actions, className, children, ...props },
  ref,
) {
  return (
    <div ref={ref} className={cx('rq-empty-state', className)} {...props}>
      <h3 className="rq-empty-state__title">{title}</h3>
      {description === undefined ? null : (
        <p className="rq-empty-state__description">{description}</p>
      )}
      {children}
      {actions === undefined ? null : <div className="rq-empty-state__actions">{actions}</div>}
    </div>
  );
});
