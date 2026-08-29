import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';
import { CloseIcon } from '../icons.js';

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  /** Adds hover and pointer affordance. Provide an `onClick` or wrap in a link. */
  interactive?: boolean;
  selected?: boolean;
  /** Renders a remove control. The tag becomes a group of two controls. */
  onRemove?: () => void;
  removeLabel?: string;
  icon?: ReactNode;
  children?: ReactNode;
}

/**
 * The only pill in the system. Radius is fully rounded here and nowhere else,
 * which is what makes a Tag legible at a glance as a piece of taxonomy.
 */
export const Tag = forwardRef<HTMLSpanElement, TagProps>(function Tag(
  {
    interactive = false,
    selected = false,
    onRemove,
    removeLabel = 'Remove',
    icon,
    className,
    children,
    ...props
  },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cx('rq-tag', interactive ? 'rq-focusable' : undefined, className)}
      data-interactive={interactive ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      {...props}
    >
      {icon}
      {children}
      {onRemove === undefined ? null : (
        <button
          type="button"
          className={cx('rq-tag__remove', 'rq-focusable')}
          aria-label={`${removeLabel} ${typeof children === 'string' ? children : ''}`.trim()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <CloseIcon size={10} />
        </button>
      )}
    </span>
  );
});
