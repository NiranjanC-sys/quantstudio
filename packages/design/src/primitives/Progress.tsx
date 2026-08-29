'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { Progress as RadixProgress } from 'radix-ui';
import { clamp, cx } from '../utils.js';

export interface ProgressProps {
  /** 0 to `max`. Omit for an indeterminate bar. */
  value?: number;
  max?: number;
  label?: ReactNode;
  /** Mono tabular readout on the right of the label row. */
  showValue?: boolean;
  formatValue?: (value: number, max: number) => string;
  className?: string;
  id?: string;
}

const defaultFormat = (value: number, max: number): string =>
  `${Math.round((value / max) * 100)}%`;

/**
 * Determinate task progress. Pass no `value` for work of unknown length; the
 * bar then sweeps, and under `prefers-reduced-motion` it pulses instead.
 */
export const Progress = forwardRef<HTMLDivElement, ProgressProps>(function Progress(
  { value, max = 100, label, showValue = true, formatValue = defaultFormat, className, id },
  ref,
) {
  const indeterminate = value === undefined || Number.isNaN(value);
  const safe = indeterminate ? 0 : clamp(value, 0, max);
  const pct = max === 0 ? 0 : (safe / max) * 100;

  return (
    <div
      className={cx('rq-progress', className)}
      data-indeterminate={indeterminate ? 'true' : undefined}
    >
      {label === undefined && !showValue ? null : (
        <div className="rq-progress__head">
          <span>{label}</span>
          {showValue ? (
            <span className="rq-progress__value">
              {indeterminate ? 'Working' : formatValue(safe, max)}
            </span>
          ) : null}
        </div>
      )}
      <RadixProgress.Root
        ref={ref}
        id={id}
        className="rq-progress__track"
        value={indeterminate ? null : safe}
        max={max}
      >
        <RadixProgress.Indicator
          className="rq-progress__indicator"
          style={{ width: indeterminate ? undefined : `${pct}%` }}
        />
      </RadixProgress.Root>
    </div>
  );
});
