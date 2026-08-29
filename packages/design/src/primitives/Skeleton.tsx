import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { cx } from '../utils.js';

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  shape?: 'text' | 'block' | 'circle' | 'panel';
  width?: number | string;
  height?: number | string;
  /** Repeats the shape. Each line after the first is slightly shorter. */
  lines?: number;
}

/**
 * Loading placeholder. It is `aria-hidden`, so pair it with a live region or a
 * `Spinner` label if the wait needs announcing.
 */
export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(function Skeleton(
  { shape = 'block', width, height, lines = 1, className, style, ...props },
  ref,
) {
  if (lines > 1) {
    return (
      <div ref={ref} aria-hidden="true" style={{ display: 'grid', gap: 8, ...style }} {...props}>
        {Array.from({ length: lines }, (_, index) => (
          <div
            key={index}
            className={cx('rq-skeleton', className)}
            data-shape={shape}
            style={{
              width: index === lines - 1 ? '62%' : (width ?? '100%'),
              height,
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cx('rq-skeleton', className)}
      data-shape={shape}
      style={{ width, height, ...style }}
      {...props}
    />
  );
});
