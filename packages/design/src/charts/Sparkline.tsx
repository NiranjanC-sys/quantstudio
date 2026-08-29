'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { ChartFrame, type ChartDataTable } from './chartFrame.js';

export interface SparklineProps {
  values: readonly number[];
  /** Optional labels, one per value, used in the data table. */
  labels?: readonly string[];
  width?: number;
  height?: number;
  /** Shade under the line with the accent wash. */
  area?: boolean;
  /** Mark the final point. */
  showLast?: boolean;
  /** Draw a dashed rule at this value, for example a target rating. */
  baseline?: number;
  caption?: ReactNode;
  description?: string;
  className?: string;
  label?: string;
}

/**
 * A trend at a glance, no axes.
 *
 * It is not a substitute for a real chart: it carries shape, not magnitude, so
 * always pair it with the current value set as a `NumericValue`.
 */
export const Sparkline = forwardRef<HTMLDivElement, SparklineProps>(function Sparkline(
  {
    values,
    labels,
    width = 160,
    height = 36,
    area = false,
    showLast = true,
    baseline,
    caption,
    description,
    className,
    label = 'Trend',
  },
  ref,
) {
  const pad = 3;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;

  const finite = values.filter((value) => Number.isFinite(value));
  const min = finite.length === 0 ? 0 : Math.min(...finite, baseline ?? Infinity);
  const max = finite.length === 0 ? 1 : Math.max(...finite, baseline ?? -Infinity);
  const span = max - min || 1;

  const x = (index: number): number =>
    values.length <= 1 ? pad : pad + (index / (values.length - 1)) * plotW;
  const y = (value: number): number => pad + (1 - (value - min) / span) * plotH;

  const points = values.map((value, index) => `${x(index).toFixed(2)},${y(value).toFixed(2)}`);
  const path = points.length === 0 ? '' : `M ${points.join(' L ')}`;
  const areaPath =
    points.length === 0
      ? ''
      : `${path} L ${x(values.length - 1).toFixed(2)},${(pad + plotH).toFixed(2)} L ${x(0).toFixed(2)},${(pad + plotH).toFixed(2)} Z`;

  const last = values.length === 0 ? undefined : values[values.length - 1];
  const first = values[0];

  const table: ChartDataTable = {
    columns: [{ header: 'Point' }, { header: 'Value', numeric: true }],
    rows: values.map((value, index) => [
      labels?.[index] ?? String(index + 1),
      value.toFixed(4),
    ]),
  };

  const summary =
    description ??
    (values.length === 0
      ? `${label}, no data`
      : `${label} over ${values.length} points, from ${(first ?? 0).toFixed(3)} to ${(last ?? 0).toFixed(3)}, low ${min.toFixed(3)}, high ${max.toFixed(3)}`);

  return (
    <div ref={ref}>
      <ChartFrame
        description={summary}
        caption={caption}
        table={table}
        className={className}
        isEmpty={values.length === 0}
        empty="No history yet"
      >
        <svg
          className="rq-chart__svg"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          style={{ width, height }}
          aria-hidden="true"
          focusable="false"
        >
          {baseline === undefined ? null : (
            <line
              className="rq-sparkline__baseline"
              x1={pad}
              y1={y(baseline)}
              x2={pad + plotW}
              y2={y(baseline)}
            />
          )}
          {area ? <path className="rq-sparkline__area" d={areaPath} /> : null}
          <path className="rq-sparkline__line" d={path} />
          {showLast && last !== undefined ? (
            <circle
              className="rq-sparkline__point"
              cx={x(values.length - 1)}
              cy={y(last)}
              r={2}
            />
          ) : null}
        </svg>
      </ChartFrame>
    </div>
  );
});
