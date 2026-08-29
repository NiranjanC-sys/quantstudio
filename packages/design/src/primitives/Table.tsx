import { forwardRef } from 'react';
import type { ReactNode, TableHTMLAttributes } from 'react';
import { cx } from '../utils.js';

export type SortDirection = 'ascending' | 'descending';

export interface TableColumn<Row> {
  id: string;
  header: ReactNode;
  /** Cell content for one row. */
  cell: (row: Row, index: number) => ReactNode;
  align?: 'start' | 'center' | 'end';
  /** Sets IBM Plex Mono with tabular figures and end alignment. */
  numeric?: boolean;
  width?: number | string;
  sortable?: boolean;
}

export interface TableProps<Row> extends Omit<TableHTMLAttributes<HTMLTableElement>, 'children'> {
  columns: ReadonlyArray<TableColumn<Row>>;
  rows: readonly Row[];
  /** Stable key per row. Falls back to the index. */
  rowKey?: (row: Row, index: number) => string;
  caption?: ReactNode;
  /** Row hover affordance. Pair with `onRowClick`. */
  interactive?: boolean;
  onRowClick?: (row: Row, index: number) => void;
  isRowSelected?: (row: Row, index: number) => boolean;
  /** Shown in place of the body when `rows` is empty. */
  empty?: ReactNode;
  sort?: { columnId: string; direction: SortDirection };
  onSortChange?: (columnId: string, direction: SortDirection) => void;
}

/**
 * Long tables get exactly one rule between rows.
 *
 * DESIGN.md bans `border-t` and `border-b` on every row. The stylesheet puts a
 * single `border-top` on every row after the first, which draws n-1 rules for n
 * rows and never doubles at a boundary.
 */
function TableInner<Row>(
  {
    columns,
    rows,
    rowKey,
    caption,
    interactive = false,
    onRowClick,
    isRowSelected,
    empty = 'No rows',
    sort,
    onSortChange,
    className,
    ...props
  }: TableProps<Row>,
  ref: React.Ref<HTMLTableElement>,
): ReactNode {
  return (
    <div className="rq-table-wrap">
      <table
        ref={ref}
        className={cx('rq-table', className)}
        data-interactive={interactive ? 'true' : undefined}
        {...props}
      >
        {caption === undefined ? null : <caption>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => {
              const isSorted = sort?.columnId === column.id;
              const ariaSort = column.sortable !== true ? undefined : isSorted ? sort.direction : 'none';
              return (
                <th
                  key={column.id}
                  scope="col"
                  style={column.width === undefined ? undefined : { width: column.width }}
                  data-align={column.numeric === true ? 'end' : column.align}
                  aria-sort={ariaSort}
                  onClick={
                    column.sortable === true && onSortChange !== undefined
                      ? () =>
                          onSortChange(
                            column.id,
                            isSorted && sort.direction === 'ascending' ? 'descending' : 'ascending',
                          )
                      : undefined
                  }
                >
                  {column.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="rq-table__empty" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={rowKey?.(row, index) ?? String(index)}
                data-selected={isRowSelected?.(row, index) === true ? 'true' : undefined}
                onClick={onRowClick === undefined ? undefined : () => onRowClick(row, index)}
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    data-align={column.align}
                    data-numeric={column.numeric === true ? 'true' : undefined}
                  >
                    {column.cell(row, index)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export const Table = forwardRef(TableInner) as <Row>(
  props: TableProps<Row> & { ref?: React.Ref<HTMLTableElement> },
) => ReactNode;
