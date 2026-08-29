import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';
import { AlertIcon, InfoIcon } from '../icons.js';

export type CalloutTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface CalloutProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: CalloutTone;
  title?: ReactNode;
  /** Replaces the default mark. Pass `null` to drop it. */
  icon?: ReactNode | null;
  children?: ReactNode;
}

const defaultIcon = (tone: CalloutTone): ReactNode => {
  if (tone === 'danger' || tone === 'warning') return <AlertIcon />;
  return <InfoIcon />;
};

/**
 * An aside inside running content: a caution, a note, a result.
 *
 * The tone lives in the 3px left rule and the mark. Body copy stays `--ink-muted`
 * so it clears the contrast floor over the tinted ground.
 */
export const Callout = forwardRef<HTMLDivElement, CalloutProps>(function Callout(
  { tone = 'neutral', title, icon, className, children, ...props },
  ref,
) {
  const mark = icon === null ? null : (icon ?? defaultIcon(tone));
  return (
    <div
      ref={ref}
      className={cx('rq-callout', className)}
      data-tone={tone}
      role={tone === 'danger' ? 'alert' : undefined}
      {...props}
    >
      {mark === null ? <span /> : <span className="rq-callout__icon">{mark}</span>}
      <div style={{ minWidth: 0 }}>
        {title === undefined ? null : <p className="rq-callout__title">{title}</p>}
        <div className="rq-callout__body">{children}</div>
      </div>
    </div>
  );
});
