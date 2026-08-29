import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  /**
   * Eyebrow label in the 40px header row. DESIGN.md bans section-numbering
   * eyebrows, so name the thing: `Statevector`, not `02 / STATEVECTOR`.
   */
  eyebrow?: ReactNode;
  /** Header row, right side. Buttons and toggles. */
  controls?: ReactNode;
  footer?: ReactNode;
  /** Drop the body padding, for a table or a canvas that runs to the hairline. */
  flush?: boolean;
  /** Use the inset ground: wells, code, circuit grid. */
  inset?: boolean;
  children?: ReactNode;
}

/**
 * `--surface-1`, 1px `--hairline`, radius 10, no shadow in dark.
 *
 * The header is a fixed 40px row with the eyebrow left and controls right,
 * separated from the body by a hairline. It is omitted entirely when there is
 * neither an eyebrow nor a control, rather than collapsing to an empty bar.
 */
export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(
  { eyebrow, controls, footer, flush = false, inset = false, className, children, ...props },
  ref,
) {
  const hasHeader = eyebrow !== undefined || controls !== undefined;
  return (
    <section
      ref={ref}
      className={cx('rq-panel', className)}
      data-inset={inset ? 'true' : undefined}
      {...props}
    >
      {hasHeader ? (
        <header className="rq-panel__header">
          <span className="rq-panel__eyebrow">{eyebrow}</span>
          {controls === undefined ? null : <span className="rq-panel__controls">{controls}</span>}
        </header>
      ) : null}
      <div className="rq-panel__body" data-flush={flush ? 'true' : undefined}>
        {children}
      </div>
      {footer === undefined ? null : <footer className="rq-panel__footer">{footer}</footer>}
    </section>
  );
});
