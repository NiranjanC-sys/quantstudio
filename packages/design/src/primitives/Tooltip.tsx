'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { Tooltip as RadixTooltip } from 'radix-ui';
import { cx } from '../utils.js';

export interface TooltipProps {
  /** The trigger. Must be a single focusable element. */
  children: ReactNode;
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** ms before the tip opens. */
  delayDuration?: number;
  sideOffset?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  /** Renders the arrow. Off by default; the hairline reads cleaner without it. */
  arrow?: boolean;
}

/**
 * Supplementary text only. Anything a reader must have in order to act belongs
 * in the interface, because a tooltip is unavailable on touch and easy to miss.
 *
 * Wrap the app once in `TooltipProvider` so delays are shared.
 */
export const Tooltip = forwardRef<HTMLDivElement, TooltipProps>(function Tooltip(
  {
    children,
    content,
    side = 'top',
    align = 'center',
    delayDuration = 200,
    sideOffset = 6,
    open,
    defaultOpen,
    onOpenChange,
    className,
    arrow = false,
  },
  ref,
) {
  return (
    <RadixTooltip.Root
      delayDuration={delayDuration}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          ref={ref}
          className={cx('rq-tooltip', className)}
          side={side}
          align={align}
          sideOffset={sideOffset}
        >
          {content}
          {arrow ? <RadixTooltip.Arrow className="rq-tooltip__arrow" width={10} height={5} /> : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
});

export interface TooltipProviderProps {
  children: ReactNode;
  delayDuration?: number;
  skipDelayDuration?: number;
}

/** Mount once, near the root. */
export function TooltipProvider({
  children,
  delayDuration = 200,
  skipDelayDuration = 300,
}: TooltipProviderProps): ReactNode {
  return (
    <RadixTooltip.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
    >
      {children}
    </RadixTooltip.Provider>
  );
}
