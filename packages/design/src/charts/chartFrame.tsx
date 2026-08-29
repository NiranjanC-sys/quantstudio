import type { ReactNode } from 'react';
import { cx } from '../utils.js';

export interface ChartDataColumn {
  header: string;
  /** Right-aligned mono. Use for anything comparable. */
  numeric?: boolean;
}

export interface ChartDataTable {
  columns: readonly ChartDataColumn[];
  rows: ReadonlyArray<readonly ReactNode[]>;
}

export interface ChartFrameProps {
  /**
   * Sentence describing what the chart shows, announced in place of the
   * graphic. Required: DESIGN.md's charts are data, and data has to be readable
   * without sight of it.
   */
  description: string;
  /** Visible caption under the graphic. */
  caption?: ReactNode;
  /** Fallback table, disclosed on demand. */
  table?: ChartDataTable;
  tableLabel?: string;
  className?: string;
  children: ReactNode;
  /** Shown instead of the graphic when there is nothing to draw. */
  empty?: ReactNode;
  isEmpty?: boolean;
}

/**
 * Shared shell for every chart: a figure, a text alternative, and a data table
 * fallback anyone can open.
 */
export function ChartFrame({
  description,
  caption,
  table,
  tableLabel = 'Data table',
  className,
  children,
  empty = 'No data yet',
  isEmpty = false,
}: ChartFrameProps): ReactNode {
  return (
    <div className={cx('rq-chart', className)}>
      <figure className="rq-chart__figure">
        {isEmpty ? (
          <p className="rq-chart__caption">{empty}</p>
        ) : (
          <div role="img" aria-label={description}>
            {children}
          </div>
        )}
        {caption === undefined ? null : (
          <figcaption className="rq-chart__caption">{caption}</figcaption>
        )}
      </figure>

      {table === undefined || isEmpty ? null : (
        <details className="rq-chart__disclosure">
          <summary className="rq-focusable">{tableLabel}</summary>
          <div className="rq-table-wrap">
            <table className="rq-table">
              <caption className="rq-sr-only">{description}</caption>
              <thead>
                <tr>
                  {table.columns.map((column) => (
                    <th key={column.header} scope="col" data-align={column.numeric === true ? 'end' : undefined}>
                      {column.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        data-numeric={
                          table.columns[cellIndex]?.numeric === true ? 'true' : undefined
                        }
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
