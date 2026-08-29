import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { clamp, cx } from '../utils.js';

export type MeterTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface MeterProps {
  value: number;
  min?: number;
  max?: number;
  label?: ReactNode;
  showValue?: boolean;
  formatValue?: (value: number) => string;
  tone?: MeterTone;
  /**
   * A reference line drawn across the track: a target rating, a fidelity
   * threshold, a previous best.
   */
  marker?: number;
  markerLabel?: string;
  className?: string;
  id?: string;
}

/**
 * A measurement inside a known range, not a task in progress. Use Progress for
 * work that finishes and Meter for a quantity that simply is what it is.
 */
export const Meter = forwardRef<HTMLDivElement, MeterProps>(function Meter(
  {
    value,
    min = 0,
    max = 1,
    label,
    showValue = true,
    formatValue = (v) => v.toFixed(3),
    tone = 'neutral',
    marker,
    markerLabel,
    className,
    id,
  },
  ref,
) {
  const span = max - min;
  const safe = clamp(value, min, max);
  const pct = span === 0 ? 0 : ((safe - min) / span) * 100;
  const markerPct =
    marker === undefined || span === 0 ? undefined : ((clamp(marker, min, max) - min) / span) * 100;

  return (
    <div ref={ref} className={cx('rq-meter', className)} data-tone={tone}>
      {label === undefined && !showValue ? null : (
        <div className="rq-meter__head">
          <span>{label}</span>
          {showValue ? <span className="rq-meter__value">{formatValue(safe)}</span> : null}
        </div>
      )}
      <div
        id={id}
        className="rq-meter__track"
        role="meter"
        aria-valuenow={safe}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={formatValue(safe)}
        aria-label={typeof label === 'string' ? label : undefined}
      >
        <div className="rq-meter__fill" style={{ width: `${pct}%` }} />
        {markerPct === undefined ? null : (
          <div
            className="rq-meter__marker"
            style={{ insetInlineStart: `${markerPct}%` }}
            title={markerLabel}
          />
        )}
      </div>
    </div>
  );
});
