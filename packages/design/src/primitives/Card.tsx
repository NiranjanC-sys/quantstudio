import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  /** Top-right slot: a Badge, a Tag, a timestamp. */
  aside?: ReactNode;
  footer?: ReactNode;
  /** Hover and pointer affordance. Pair with an `onClick` or a nested link. */
  interactive?: boolean;
  selected?: boolean;
  children?: ReactNode;
}

/**
 * A quieter Panel with no header rule.
 *
 * DESIGN.md bans three-equal-card feature rows. Lay Cards out asymmetrically,
 * or in a list, and never as three identical columns.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    title,
    description,
    aside,
    footer,
    interactive = false,
    selected = false,
    className,
    children,
    ...props
  },
  ref,
) {
  const hasHead = title !== undefined || description !== undefined || aside !== undefined;
  return (
    <div
      ref={ref}
      className={cx('rq-card', interactive ? 'rq-focusable' : undefined, className)}
      data-interactive={interactive ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      {...props}
    >
      {hasHead ? (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {title === undefined ? null : <h3 className="rq-card__title">{title}</h3>}
            {description === undefined ? null : (
              <p className="rq-card__description">{description}</p>
            )}
          </div>
          {aside === undefined ? null : <div style={{ flex: 'none' }}>{aside}</div>}
        </div>
      ) : null}
      {children === undefined ? null : (
        <div style={hasHead ? { marginBlockStart: 12 } : undefined}>{children}</div>
      )}
      {footer === undefined ? null : <div style={{ marginBlockStart: 16 }}>{footer}</div>}
    </div>
  );
});
