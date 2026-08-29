'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { clamp } from '../utils.js';
import { magnitudeColor } from '../tokens.js';
import { ChartFrame, type ChartDataTable } from './chartFrame.js';

export interface HistogramBin {
  /** Basis state or outcome label. */
  label: string;
  /** Measured counts for this outcome. */
  count: number;
  /** Ideal probability, drawn as a reference tick when present. */
  expected?: number;
}

export interface ProbabilityHistogramProps {
  bins: readonly HistogramBin[];
  /** Total shots. Defaults to the sum of counts. */
  shots?: number;
  /**
   * Standard errors to draw. Shot noise on a binomial estimate is
   * `sqrt(p (1 - p) / n)`, and the bar shows `sigmas` of it.
   */
  sigmas?: number;
  showErrorBars?: boolean;
  height?: number;
  caption?: ReactNode;
  description?: string;
  className?: string;
}

const fmt = (value: number, digits = 4): string => value.toFixed(digits);

/**
 * Measured outcome frequencies with shot-noise error bars.
 *
 * The error bar is the binomial standard error of the estimate,
 * `sqrt(p (1 - p) / shots)`, which is the honest way to show that 100 shots and
 * 100000 shots are not the same measurement.
 */
export const ProbabilityHistogram = forwardRef<HTMLDivElement, ProbabilityHistogramProps>(
  function ProbabilityHistogram(
    {
      bins,
      shots,
      sigmas = 1,
      showErrorBars = true,
      height = 180,
      caption,
      description,
      className,
    },
    ref,
  ) {
    const total = shots ?? bins.reduce((sum, bin) => sum + bin.count, 0);
    const width = 640;
    const padding = { top: 12, right: 8, bottom: 28, left: 44 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    const rows = bins.map((bin) => {
      const p = total === 0 ? 0 : bin.count / total;
      const stderr = total === 0 ? 0 : Math.sqrt(Math.max(0, p * (1 - p)) / total);
      return { ...bin, p, stderr };
    });

    const ceiling = Math.max(
      0.05,
      ...rows.map((row) => row.p + (showErrorBars ? sigmas * row.stderr : 0)),
      ...rows.map((row) => row.expected ?? 0),
    );
    const yScale = (value: number): number => plotH - clamp(value / ceiling, 0, 1) * plotH;
    const slot = rows.length === 0 ? plotW : plotW / rows.length;
    const barW = Math.max(2, Math.min(48, slot * 0.62));

    const table: ChartDataTable = {
      columns: [
        { header: 'Outcome' },
        { header: 'Count', numeric: true },
        { header: 'Probability', numeric: true },
        { header: 'Standard error', numeric: true },
      ],
      rows: rows.map((row) => [row.label, String(row.count), fmt(row.p), fmt(row.stderr)]),
    };

    const summary =
      description ??
      `Measured outcome frequencies over ${total} shots. ` +
        rows
          .slice(0, 8)
          .map(
            (row) =>
              `${row.label}, ${fmt(row.p, 3)} plus or minus ${fmt(sigmas * row.stderr, 3)}`,
          )
          .join('. ');

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * ceiling);

    return (
      <div ref={ref}>
        <ChartFrame
          description={summary}
          caption={caption}
          table={table}
          className={className}
          isEmpty={rows.length === 0}
          empty="No shots recorded yet"
        >
          <svg
            className="rq-chart__svg"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
            focusable="false"
          >
            <g transform={`translate(${padding.left} ${padding.top})`}>
              {ticks.map((tick) => (
                <g key={tick}>
                  <line
                    className="rq-chart__grid"
                    x1={0}
                    y1={yScale(tick)}
                    x2={plotW}
                    y2={yScale(tick)}
                  />
                  <text
                    className="rq-chart__label"
                    x={-8}
                    y={yScale(tick)}
                    textAnchor="end"
                    dominantBaseline="middle"
                  >
                    {tick.toFixed(2)}
                  </text>
                </g>
              ))}

              {rows.map((row, index) => {
                const cx = index * slot + slot / 2;
                const top = yScale(row.p);
                const err = sigmas * row.stderr;
                return (
                  <g key={row.label}>
                    <rect
                      className="rq-histogram__bar"
                      x={cx - barW / 2}
                      y={top}
                      width={barW}
                      height={Math.max(0, plotH - top)}
                      rx={2}
                      fill={magnitudeColor(clamp(row.p, 0, 1))}
                    />
                    {row.expected === undefined ? null : (
                      <line
                        className="rq-chart__axis"
                        x1={cx - barW / 2}
                        y1={yScale(row.expected)}
                        x2={cx + barW / 2}
                        y2={yScale(row.expected)}
                        stroke="var(--rq-ink-muted)"
                        strokeDasharray="3 2"
                      />
                    )}
                    {showErrorBars && err > 0 ? (
                      <g className="rq-histogram__error">
                        <line x1={cx} y1={yScale(row.p - err)} x2={cx} y2={yScale(row.p + err)} />
                        <line
                          x1={cx - 4}
                          y1={yScale(row.p + err)}
                          x2={cx + 4}
                          y2={yScale(row.p + err)}
                        />
                        <line
                          x1={cx - 4}
                          y1={yScale(row.p - err)}
                          x2={cx + 4}
                          y2={yScale(row.p - err)}
                        />
                      </g>
                    ) : null}
                    <text
                      className="rq-chart__label"
                      x={cx}
                      y={plotH + 16}
                      textAnchor="middle"
                    >
                      {row.label}
                    </text>
                  </g>
                );
              })}

              <line className="rq-chart__axis" x1={0} y1={plotH} x2={plotW} y2={plotH} />
            </g>
          </svg>
        </ChartFrame>
      </div>
    );
  },
);
