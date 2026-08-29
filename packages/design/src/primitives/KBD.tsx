import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { cx } from '../utils.js';

export interface KBDProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /**
   * One key, or a chord. `['Meta', 'K']` renders two caps joined by a plus.
   * Modifier names are rendered as typed, so pass what the platform shows.
   */
  keys: string | readonly string[];
  /** Joins the caps. Defaults to a plus. */
  joiner?: string;
}

/** Keyboard caps in IBM Plex Mono, with a 2px bottom edge for the key feel. */
export const KBD = forwardRef<HTMLElement, KBDProps>(function KBD(
  { keys, joiner = '+', className, ...props },
  ref,
) {
  const list = typeof keys === 'string' ? [keys] : keys;
  if (list.length === 1) {
    return (
      <kbd ref={ref} className={cx('rq-kbd', className)} {...props}>
        {list[0]}
      </kbd>
    );
  }
  return (
    <span ref={ref as React.Ref<HTMLSpanElement>} className={cx('rq-kbd-group', className)} {...props}>
      {list.map((key, index) => (
        <span key={`${key}-${index}`} style={{ display: 'contents' }}>
          {index === 0 ? null : <span aria-hidden="true">{joiner}</span>}
          <kbd className="rq-kbd">{key}</kbd>
        </span>
      ))}
    </span>
  );
});
