import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';

export type NumericTone =
  | 'default'
  | 'muted'
  | 'subtle'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger';

export type NumericFormat = 'decimal' | 'integer' | 'percent' | 'scientific';

export interface NumericValueProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** `null` and `undefined` render the placeholder. */
  value: number | null | undefined;
  /** Decimal places. Ignored by `integer`. */
  precision?: number;
  format?: NumericFormat;
  /** Rendered small and subtle after the figure. */
  unit?: ReactNode;
  tone?: NumericTone;
  /** Always show a leading sign, so a column of changes lines up. */
  signed?: boolean;
  /**
   * A change to show beside the figure. Tone follows direction unless `tone` is
   * set explicitly.
   */
  delta?: number;
  deltaPrecision?: number;
  /** Shown when the value is missing. A hyphen pair, never a dash glyph. */
  placeholder?: string;
  /** Inherit the surrounding size instead of the 13px numeric role. */
  inheritSize?: boolean;
  /** Overrides the announced text. */
  ariaLabel?: string;
}

function formatNumber(value: number, format: NumericFormat, precision: number): string {
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  switch (format) {
    case 'integer':
      return Math.round(value).toString();
    case 'percent':
      return `${(value * 100).toFixed(precision)}%`;
    case 'scientific':
      return value.toExponential(precision);
    default:
      return value.toFixed(precision);
  }
}

/**
 * The numeric lock.
 *
 * Every number a learner might compare against another number goes through
 * here: amplitudes, probabilities, gate counts, depths, ratings, timers. It is
 * IBM Plex Mono with `tabular-nums`, so digits stack in a column.
 */
export const NumericValue = forwardRef<HTMLSpanElement, NumericValueProps>(function NumericValue(
  {
    value,
    precision = 3,
    format = 'decimal',
    unit,
    tone = 'default',
    signed = false,
    delta,
    deltaPrecision = 2,
    placeholder = '--',
    inheritSize = false,
    ariaLabel,
    className,
    ...props
  },
  ref,
) {
  const missing = value === null || value === undefined || Number.isNaN(value);
  const body = missing ? placeholder : formatNumber(value, format, precision);
  const sign = !missing && signed && value > 0 ? '+' : '';

  const deltaTone: NumericTone | undefined =
    delta === undefined || delta === 0 ? undefined : delta > 0 ? 'success' : 'danger';

  return (
    <span
      ref={ref}
      className={cx('rq-numeric', className)}
      data-rq-numeric=""
      data-tone={tone === 'default' ? undefined : tone}
      data-size={inheritSize ? 'inherit' : undefined}
      aria-label={ariaLabel}
      {...props}
    >
      {sign}
      {body}
      {unit === undefined ? null : <span className="rq-numeric__unit">{unit}</span>}
      {delta === undefined || missing ? null : (
        <span className="rq-numeric__delta" data-tone={deltaTone}>
          {delta > 0 ? '+' : ''}
          {delta.toFixed(deltaPrecision)}
        </span>
      )}
    </span>
  );
});
