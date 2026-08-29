'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { clamp } from '../utils.js';
import { magnitudeColor, magnitudeStops, phaseColor } from '../tokens.js';
import { ChartFrame, type ChartDataTable } from './chartFrame.js';

export interface HeatmapCell {
  /** Real part of the density matrix element. */
  re: number;
  im?: number;
}

export interface DensityHeatmapProps {
  /**
   * Square matrix, row major. Entries may be plain numbers, for a real matrix,
   * or `{ re, im }` for a complex one.
   */
  matrix: ReadonlyArray<ReadonlyArray<number | HeatmapCell>>;
  /** Basis labels. Defaults to binary strings of the right width. */
  labels?: readonly string[];
  /**
   * `magnitude` colours by `|rho_ij|` on the sequential ramp. `phase` colours by
   * `arg(rho_ij)` on the cyclic map, with opacity carrying the magnitude.
   */
  encode?: 'magnitude' | 'phase';
  cellSize?: number;
  showValues?: boolean;
  caption?: ReactNode;
  description?: string;
  className?: string;
  showLegend?: boolean;
}

const toCell = (value: number | HeatmapCell): { re: number; im: number } =>
  typeof value === 'number' ? { re: value, im: 0 } : { re: value.re, im: value.im ?? 0 };

const defaultLabels = (n: number): string[] => {
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(1, n))));
  return Array.from({ length: n }, (_, index) => index.toString(2).padStart(bits, '0'));
};

/**
 * Density matrix as a grid.
 *
 * Diagonal entries are populations, off-diagonal entries are coherences, so the
 * pattern of the grid is the thing a learner should read: a diagonal-only grid
 * is a classical mixture, and bright corners mean interference is available.
 */
export const DensityHeatmap = forwardRef<HTMLDivElement, DensityHeatmapProps>(
  function DensityHeatmap(
    {
      matrix,
      labels,
      encode = 'magnitude',
      cellSize = 26,
      showValues = false,
      caption,
      description,
      className,
      showLegend = true,
    },
    ref,
  ) {
    const n = matrix.length;
    const names = labels ?? defaultLabels(n);
    const gutter = 34;
    const size = gutter + n * cellSize;

    const cells = matrix.map((row) => row.map(toCell));
    const peak = Math.max(
      1e-12,
      ...cells.flatMap((row) => row.map((cell) => Math.hypot(cell.re, cell.im))),
    );

    const table: ChartDataTable = {
      columns: [
        { header: 'Row' },
        { header: 'Column' },
        { header: 'Magnitude', numeric: true },
        { header: 'Phase, radians', numeric: true },
      ],
      rows: cells.flatMap((row, i) =>
        row.map((cell, j) => [
          names[i] ?? String(i),
          names[j] ?? String(j),
          Math.hypot(cell.re, cell.im).toFixed(4),
          Math.atan2(cell.im, cell.re).toFixed(4),
        ]),
      ),
    };

    const trace = cells.reduce((sum, row, i) => sum + (row[i]?.re ?? 0), 0);
    const summary =
      description ??
      `Density matrix, ${n} by ${n}, trace ${trace.toFixed(3)}, largest element magnitude ${peak.toFixed(3)}. Open the data table for every element.`;

    return (
      <div ref={ref}>
        <ChartFrame
          description={summary}
          caption={caption}
          table={table}
          className={className}
          isEmpty={n === 0}
          empty="No density matrix yet"
        >
          <svg
            className="rq-chart__svg"
            viewBox={`0 0 ${size} ${size}`}
            preserveAspectRatio="xMidYMid meet"
            style={{ maxWidth: size }}
            aria-hidden="true"
            focusable="false"
          >
            {names.map((name, index) => (
              <text
                key={`col-${name}-${index}`}
                className="rq-chart__label"
                x={gutter + index * cellSize + cellSize / 2}
                y={gutter - 10}
                textAnchor="middle"
              >
                {name}
              </text>
            ))}
            {names.map((name, index) => (
              <text
                key={`row-${name}-${index}`}
                className="rq-chart__label"
                x={gutter - 8}
                y={gutter + index * cellSize + cellSize / 2}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {name}
              </text>
            ))}

            {cells.map((row, i) =>
              row.map((cell, j) => {
                const magnitude = Math.hypot(cell.re, cell.im);
                const normalised = clamp(magnitude / peak, 0, 1);
                const fill =
                  encode === 'phase'
                    ? phaseColor(Math.atan2(cell.im, cell.re))
                    : magnitudeColor(normalised);
                return (
                  <g key={`${i}-${j}`}>
                    <rect
                      className="rq-heatmap__cell"
                      x={gutter + j * cellSize}
                      y={gutter + i * cellSize}
                      width={cellSize}
                      height={cellSize}
                      fill={fill}
                      fillOpacity={encode === 'phase' ? Math.max(0.08, normalised) : 1}
                      stroke="var(--rq-canvas)"
                      strokeWidth={1}
                    />
                    {showValues ? (
                      <text
                        className="rq-chart__label"
                        x={gutter + j * cellSize + cellSize / 2}
                        y={gutter + i * cellSize + cellSize / 2}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill={normalised > 0.6 ? 'var(--rq-on-accent)' : 'var(--rq-ink-muted)'}
                      >
                        {magnitude.toFixed(2)}
                      </text>
                    ) : null}
                  </g>
                );
              }),
            )}
          </svg>

          {showLegend ? (
            <div className="rq-heatmap__legend">
              <span>0.00</span>
              <span
                className="rq-heatmap__legend-ramp"
                style={{
                  backgroundImage: `linear-gradient(to right, ${magnitudeStops.join(', ')})`,
                }}
              />
              <span>{peak.toFixed(2)}</span>
            </div>
          ) : null}
        </ChartFrame>
      </div>
    );
  },
);
