'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { Avatar as RadixAvatar } from 'radix-ui';
import { cx } from '../utils.js';

export interface AvatarProps {
  /** Absent or failed images fall back to initials. */
  src?: string;
  /** Used as the image alt and to derive initials. */
  name: string;
  size?: 'sm' | 'md' | 'lg';
  /** Overrides the derived initials. */
  initials?: string;
  className?: string;
  /** ms to wait before showing the fallback, to avoid a flash. */
  delayMs?: number;
  children?: ReactNode;
}

function deriveInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0] as string;
  if (words.length === 1) return first.slice(0, 2);
  const last = words[words.length - 1] as string;
  return `${first[0] ?? ''}${last[0] ?? ''}`;
}

/**
 * Square with a soft radius, not a circle: a circle reads as decoration in a
 * dense table, and the radii here are locked to the 4 / 6 / 10 set.
 */
export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { src, name, size = 'md', initials, className, delayMs = 120, children },
  ref,
) {
  return (
    <RadixAvatar.Root ref={ref} className={cx('rq-avatar', className)} data-size={size}>
      {src === undefined ? null : (
        <RadixAvatar.Image className="rq-avatar__image" src={src} alt={name} />
      )}
      <RadixAvatar.Fallback className="rq-avatar__fallback" delayMs={src === undefined ? 0 : delayMs}>
        {children ?? initials ?? deriveInitials(name)}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  );
});
