import { forwardRef } from 'react';
import type { SVGProps } from 'react';
import { cx } from '../utils.js';

export interface SpinnerProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** px. Defaults to 16. */
  size?: number;
  /**
   * Announced label. Pass `null` when a visible label already says the same
   * thing, so a screen reader does not hear it twice.
   */
  label?: string | null;
}

/**
 * Indeterminate activity. Under `prefers-reduced-motion` the arc stops rotating
 * and pulses opacity instead.
 */
export const Spinner = forwardRef<SVGSVGElement, SpinnerProps>(function Spinner(
  { size = 16, label = 'Loading', className, ...props },
  ref,
) {
  const r = size / 2 - 1.5;
  return (
    <svg
      ref={ref}
      className={cx('rq-spinner', className)}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      role={label === null ? 'presentation' : 'img'}
      aria-label={label === null ? undefined : label}
      aria-hidden={label === null ? true : undefined}
      {...props}
    >
      <circle
        className="rq-spinner__track"
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <path
        className="rq-spinner__head"
        d={`M ${size / 2} ${size / 2 - r} A ${r} ${r} 0 0 1 ${size / 2 + r} ${size / 2}`}
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </svg>
  );
});
