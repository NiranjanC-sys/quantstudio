import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';
import { AlertIcon, CheckIcon, MinusIcon } from '../icons.js';
import { Spinner } from './Spinner.js';

export type VerdictStatus = 'pass' | 'fail' | 'running' | 'skipped';

export interface VerdictStripProps extends HTMLAttributes<HTMLDivElement> {
  status: VerdictStatus;
  /** Test name, set in mono. */
  name: string;
  /** Milliseconds. Right-aligned in `--ink-subtle`, tabular. */
  durationMs?: number;
  /** Short middle slot: an assertion summary, a shot count. */
  detail?: ReactNode;
  /** Trailing controls, for example a rerun button. */
  actions?: ReactNode;
}

const MARKS: Record<VerdictStatus, ReactNode> = {
  pass: <CheckIcon size={14} />,
  fail: <AlertIcon size={14} />,
  running: <Spinner size={14} label={null} />,
  skipped: <MinusIcon size={14} />,
};

const STATUS_TEXT: Record<VerdictStatus, string> = {
  pass: 'Passed',
  fail: 'Failed',
  running: 'Running',
  skipped: 'Skipped',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * The lab result bar: full width, 44px, a 3px status rule down the left edge,
 * the test name in mono, and the timing right-aligned and tabular.
 */
export const VerdictStrip = forwardRef<HTMLDivElement, VerdictStripProps>(function VerdictStrip(
  { status, name, durationMs, detail, actions, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx('rq-verdict', className)}
      data-status={status}
      role="status"
      aria-live={status === 'running' ? 'polite' : 'off'}
      {...props}
    >
      <span className="rq-verdict__mark" aria-hidden="true">
        {MARKS[status]}
      </span>
      <span className="rq-sr-only">{STATUS_TEXT[status]}</span>
      <span className="rq-verdict__name">{name}</span>
      {detail === undefined ? null : <span className="rq-verdict__detail">{detail}</span>}
      {durationMs === undefined ? null : (
        <span className="rq-verdict__timing" data-rq-numeric="">
          {formatDuration(durationMs)}
        </span>
      )}
      {actions}
    </div>
  );
});
