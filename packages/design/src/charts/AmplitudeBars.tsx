'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { clamp, cx } from '../utils.js';
import { magnitudeColor, phaseColor, layout } from '../tokens.js';
import { ChartFrame, type ChartDataTable } from './chartFrame.js';

export interface Amplitude {
  /** Basis state label without the ket brackets, for example `01`. */
  basis: string;
  /** Real part, or omit and pass `magnitude` and `phase` directly. */
  re?: number;
  im?: number;
  /** `|amplitude|`. Derived from `re` and `im` when absent. */
  magnitude?: number;
  /** `arg(amplitude)` in radians. Derived from `re` and `im` when absent. */
  phase?: number;
}

export interface AmplitudeBarsProps {
  amplitudes: readonly Amplitude[];
  /** Hide rows whose probability falls below this. Defaults to 0, showing all. */
  threshold?: number;
  /** Basis labels to mark with the accent wash. */
  selected?: readonly string[];
  caption?: ReactNode;
  description?: string;
  className?: string;
  /** Drop the probability column, for a narrow rail. */
  showProbability?: boolean;
  maxRows?: number;
}

interface Resolved {
  basis: string;
  magnitude: number;
  phase: number;
  probability: number;
}

const TAU = Math.PI * 2;

function resolve(amplitude: Amplitude): Resolved {
  const re = amplitude.re ?? 0;
  const im = amplitude.im ?? 0;
  const magnitude = amplitude.magnitude ?? Math.hypot(re, im);
  const phase = amplitude.phase ?? Math.atan2(im, re);
  return {
    basis: amplitude.basis,
    magnitude,
    phase: ((phase % TAU) + TAU) % TAU,
    probability: magnitude * magnitude,
  };
}

const fmt = (value: number, digits = 4): string => value.toFixed(digits);

/**
 * One row per basis state.
 *
 * Bar length is the probability; the bar fill comes from the sequential
 * magnitude ramp. Phase is a 10px disc filled from the cyclic phase colormap,
 * carrying a 1px hairline and a radial tick at the angle, so a reader can
 * recover the phase from the tick even if the hue is hard to judge.
 */
export const AmplitudeBars = forwardRef<HTMLDivElement, AmplitudeBarsProps>(function AmplitudeBars(
  {
    amplitudes,
    threshold = 0,
    selected,
    caption,
    description,
    className,
    showProbability = true,
    maxRows,
  },
  ref,
) {
  const resolved = amplitudes.map(resolve).filter((row) => row.probability >= threshold);
  const rows = maxRows === undefined ? resolved : resolved.slice(0, maxRows);
  const selectedSet = new Set(selected ?? []);
  const disc = layout.phaseDisc;
  const r = disc / 2;

  const table: ChartDataTable = {
    columns: [
      { header: 'Basis state' },
      { header: 'Probability', numeric: true },
      { header: 'Magnitude', numeric: true },
      { header: 'Phase, radians', numeric: true },
    ],
    rows: rows.map((row) => [
      `|${row.basis}>`,
      fmt(row.probability),
      fmt(row.magnitude),
      fmt(row.phase),
    ]),
  };

  const summary =
    description ??
    `Amplitudes for ${rows.length} basis states. ` +
      rows
        .slice(0, 8)
        .map(
          (row) =>
            `state ${row.basis}, probability ${fmt(row.probability, 3)}, phase ${fmt(row.phase, 2)} radians`,
        )
        .join('. ');

  return (
    <div ref={ref}>
      <ChartFrame
        description={summary}
        caption={caption}
        table={table}
        className={className}
        isEmpty={rows.length === 0}
        empty="No amplitudes above the threshold"
      >
        <div className="rq-amplitude">
          {rows.map((row) => {
            const pct = clamp(row.probability, 0, 1) * 100;
            const tickX = r + r * 0.72 * Math.cos(-row.phase);
            const tickY = r + r * 0.72 * Math.sin(-row.phase);
            return (
              <div
                key={row.basis}
                className="rq-amplitude__row"
                data-selected={selectedSet.has(row.basis) ? 'true' : undefined}
              >
                <span className="rq-amplitude__ket" data-rq-numeric="">
                  {`|${row.basis}>`}
                </span>
                <span className="rq-amplitude__bar-track">
                  <span
                    className="rq-amplitude__bar"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: magnitudeColor(clamp(row.probability, 0, 1)),
                    }}
                  />
                </span>
                {showProbability ? (
                  <span className="rq-amplitude__prob">{fmt(row.probability)}</span>
                ) : null}
                <svg
                  className="rq-amplitude__disc"
                  width={disc}
                  height={disc}
                  viewBox={`0 0 ${disc} ${disc}`}
                  aria-hidden="true"
                  focusable="false"
                >
                  <circle cx={r} cy={r} r={r - 0.5} fill={phaseColor(row.phase)} />
                  <circle className="rq-amplitude__disc-edge" cx={r} cy={r} r={r - 0.5} />
                  <line
                    className="rq-amplitude__disc-tick"
                    x1={r}
                    y1={r}
                    x2={tickX}
                    y2={tickY}
                  />
                </svg>
              </div>
            );
          })}
        </div>
      </ChartFrame>
    </div>
  );
});

export interface PhaseLegendProps {
  /** Number of swatches around the circle. */
  steps?: number;
  size?: number;
  className?: string;
}

/** Key for the cyclic phase colormap, from 0 to 2 pi. */
export function PhaseLegend({ steps = 24, size = 48, className }: PhaseLegendProps): ReactNode {
  const r = size / 2;
  const inner = r * 0.58;
  return (
    <svg
      className={cx('rq-chart__svg', className)}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Phase colour key, zero to two pi anticlockwise from the right"
      style={{ width: size, height: size }}
    >
      {Array.from({ length: steps }, (_, index) => {
        const a0 = (index / steps) * TAU;
        const a1 = ((index + 1) / steps) * TAU;
        const p = (angle: number, radius: number): string =>
          `${(r + radius * Math.cos(-angle)).toFixed(3)} ${(r + radius * Math.sin(-angle)).toFixed(3)}`;
        return (
          <path
            key={index}
            d={`M ${p(a0, inner)} L ${p(a0, r)} A ${r} ${r} 0 0 0 ${p(a1, r)} L ${p(a1, inner)} A ${inner} ${inner} 0 0 1 ${p(a0, inner)} Z`}
            fill={phaseColor((a0 + a1) / 2)}
          />
        );
      })}
    </svg>
  );
}
