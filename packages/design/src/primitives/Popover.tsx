'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { Popover as RadixPopover } from 'radix-ui';
import { cx } from '../utils.js';
import { CloseIcon } from '../icons.js';
import { IconButton } from './IconButton.js';

export interface PopoverProps {
  /** The trigger. Must be a single focusable element. */
  trigger: ReactNode;
  children: ReactNode;
  title?: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  /** px. Defaults to 288. */
  width?: number;
  showClose?: boolean;
  closeLabel?: string;
  modal?: boolean;
}

/**
 * Focus moves into the panel on open and returns to the trigger on close.
 * Escape and an outside click both dismiss it.
 */
export const Popover = forwardRef<HTMLDivElement, PopoverProps>(function Popover(
  {
    trigger,
    children,
    title,
    side = 'bottom',
    align = 'start',
    sideOffset = 6,
    open,
    defaultOpen,
    onOpenChange,
    className,
    width,
    showClose = false,
    closeLabel = 'Close',
    modal = false,
  },
  ref,
) {
  return (
    <RadixPopover.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      modal={modal}
    >
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          ref={ref}
          className={cx('rq-popover', 'rq-overlay-anim', className)}
          side={side}
          align={align}
          sideOffset={sideOffset}
          style={width === undefined ? undefined : { width }}
        >
          {title === undefined && !showClose ? null : (
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 12,
                marginBlockEnd: 8,
              }}
            >
              {title === undefined ? <span /> : <span className="rq-panel__eyebrow">{title}</span>}
              {showClose ? (
                <RadixPopover.Close asChild>
                  <IconButton label={closeLabel} icon={<CloseIcon size={14} />} size="sm" />
                </RadixPopover.Close>
              ) : null}
            </div>
          )}
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
});

export const PopoverClose = RadixPopover.Close;
