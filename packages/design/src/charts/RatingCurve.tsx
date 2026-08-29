'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { ChartFrame, type ChartDataTable } from './chartFrame.js';

export interface RatingPoint {
  /** Contest or session label. */
  label: string;
  rating: number;
  /** Rating deviation. Drawn as a confidence band when present. */
  deviation?: number;
}

export interface RatingCurveProps {
  points: readonly RatingPoint[];
  width?: number;
  height?: number;
  /** Horizontal rule, for example the threshold for the next tier. */
  target?: number;
  targetLabel?: string;
  caption?: ReactNode;
  description?: string;
  className?: string;
}

/**
 * Rating over time, with the deviation band drawn behind the line.
 *
 * The band matters: a rating of 1500 after three contests and 1500 after three
 * hundred are different claims, and hiding the deviation hides that.
 */
export const RatingCurve = forwardRef<HTMLDivElement, RatingCurveProps>(function RatingCurve(
  {
    points,
    width = 640,
    height = 200,
    target,
    targetLabel = 'Target',
    caption,
    description,
    className,
  },
  ref,
) {
  const padding = { top: 12, right: 12, bottom: 28, left: 48 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const lows = points.map((point) => point.rating - (point.deviation ?? 0));
  const highs = points.map((point) => point.rating + (point.deviation ?? 0));
  const rawMin = points.length === 0 ? 0 : Math.min(...lows, target ?? Infinity);
  const rawMax = points.length === 0 ? 1 : Math.max(...highs, target ?? -Infinity);
  const pad = Math.max(20, (rawMax - rawMin) * 0.1);
  const min = rawMin - pad;
  const max = rawMax + pad;
  const span = max - min || 1;

  const x = (index: number): number =>
    points.length <= 1 ? plotW / 2 : (index / (points.length - 1)) * plotW;
  const y = (value: number): number => plotH - ((value - min) / span) * plotH;

  const line =
    points.length === 0
      ? ''
      : `M ${points.map((point, index) => `${x(index).toFixed(2)},${y(point.rating).toFixed(2)}`).join(' L ')}`;

  const hasBand = points.some((point) => point.deviation !== undefined);
  const band = !hasBand
    ? ''
    : `M ${points.map((point, index) => `${x(index).toFixed(2)},${y(point.rating + (point.deviation ?? 0)).toFixed(2)}`).join(' L ')} L ${points
        .map(
          (_point, index) =>
            `${x(points.length - 1 - index).toFixed(2)},${y(
              (points[points.length - 1 - index]?.rating ?? 0) -
                (points[points.length - 1 - index]?.deviation ?? 0),
            ).toFixed(2)}`,
        )
        .join(' L ')} Z`;

  const ticks = 4;
  const table: ChartDataTable = {
    columns: [{ header: 'Contest' }, { header: 'Rating', numeric: true }, { header: 'Deviation', numeric: true }],
    rows: points.map((point) => [
      point.label,
      point.rating.toFixed(0),
      point.deviation === undefined ? '--' : point.deviation.toFixed(0),
    ]),
  };

  const last = points[points.length - 1];
  const first = points[0];
  const summary =
    description ??
    (points.length === 0
      ? 'Rating history, no contests yet'
      : `Rating over ${points.length} contests, from ${(first?.rating ?? 0).toFixed(0)} to ${(last?.rating ?? 0).toFixed(0)}`);

  return (
    <div ref={ref}>
      <ChartFrame
        description={summary}
        caption={caption}
        table={table}
        className={className}
        isEmpty={points.length === 0}
        empty="No rated contests yet"
      >
        <svg
          className="rq-chart__svg"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          focusable="false"
        >
          <g transform={`translate(${padding.left} ${padding.top})`}>
            {Array.from({ length: ticks + 1 }, (_, index) => {
              const value = min + (span * index) / ticks;
              return (
                <g key={index}>
                  <line className="rq-chart__grid" x1={0} y1={y(value)} x2={plotW} y2={y(value)} />
                  <text
                    className="rq-chart__label"
                    x={-8}
                    y={y(value)}
                    textAnchor="end"
                    dominantBaseline="middle"
                  >
                    {value.toFixed(0)}
                  </text>
                </g>
              );
            })}

            {target === undefined ? null : (
              <g>
                <line
                  x1={0}
                  y1={y(target)}
                  x2={plotW}
                  y2={y(target)}
                  stroke="var(--rq-ink-muted)"
                  strokeDasharray="4 3"
                />
                <text className="rq-chart__label" x={plotW} y={y(target) - 6} textAnchor="end">
                  {targetLabel}
                </text>
              </g>
            )}

            {hasBand ? <path className="rq-rating__band" d={band} /> : null}
            <path className="rq-rating__line" d={line} />

            {points.map((point, index) => (
              <circle
                key={`${point.label}-${index}`}
                className="rq-rating__marker"
                cx={x(index)}
                cy={y(point.rating)}
                r={3}
              />
            ))}

            {points.map((point, index) =>
              index === 0 || index === points.length - 1 || points.length <= 6 ? (
                <text
                  key={`label-${point.label}-${index}`}
                  className="rq-chart__label"
                  x={x(index)}
                  y={plotH + 18}
                  textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
                >
                  {point.label}
                </text>
              ) : null,
            )}

            <line className="rq-chart__axis" x1={0} y1={plotH} x2={plotW} y2={plotH} />
          </g>
        </svg>
      </ChartFrame>
    </div>
  );
});
