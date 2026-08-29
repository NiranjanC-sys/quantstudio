import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Mono with tabular figures, for counts. */
  numeric?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
}

/**
 * Small status marker with a radius-4 corner. Badges are square-ish on purpose:
 * the pill shape is reserved for Tag.
 */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'neutral', numeric = false, icon, className, children, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cx('rq-badge', className)}
      data-tone={tone}
      data-numeric={numeric ? 'true' : undefined}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
});
