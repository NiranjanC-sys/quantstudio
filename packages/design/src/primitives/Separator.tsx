import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { Separator as RadixSeparator } from 'radix-ui';
import { cx } from '../utils.js';

export interface SeparatorProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  orientation?: 'horizontal' | 'vertical';
  /** `--hairline` by default, `--hairline-strong` for emphasis. */
  emphasis?: 'default' | 'strong';
  /** A short label centred in the rule. Horizontal only. */
  label?: ReactNode;
  /** Purely visual. Removes it from the accessibility tree. */
  decorative?: boolean;
}

/** One hairline. Never doubled up, and never used as a section ornament. */
export const Separator = forwardRef<HTMLDivElement, SeparatorProps>(function Separator(
  {
    orientation = 'horizontal',
    emphasis = 'default',
    label,
    decorative = true,
    className,
    ...props
  },
  ref,
) {
  if (label !== undefined && orientation === 'horizontal') {
    return (
      <div
        ref={ref}
        className={cx('rq-separator__label', className)}
        role={decorative ? 'presentation' : 'separator'}
        {...props}
      >
        {label}
      </div>
    );
  }
  return (
    <RadixSeparator.Root
      ref={ref}
      className={cx('rq-separator', className)}
      orientation={orientation}
      decorative={decorative}
      data-emphasis={emphasis}
      {...props}
    />
  );
});
