'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { Dialog as RadixDialog } from 'radix-ui';
import { cx } from '../utils.js';
import { CloseIcon } from '../icons.js';
import { IconButton } from './IconButton.js';

export type SheetSide = 'left' | 'right' | 'top' | 'bottom';

export interface SheetProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  side?: SheetSide;
  className?: string;
  showClose?: boolean;
  closeLabel?: string;
  /** px. Overrides the default edge width or height. */
  size?: number;
}

/**
 * Edge-anchored modal for long secondary content: an inspector, a filter set, a
 * run log. Same focus trap, Escape and scroll lock as Dialog.
 */
export const Sheet = forwardRef<HTMLDivElement, SheetProps>(function Sheet(
  {
    open,
    defaultOpen,
    onOpenChange,
    trigger,
    title,
    description,
    footer,
    children,
    side = 'right',
    className,
    showClose = true,
    closeLabel = 'Close',
    size,
  },
  ref,
) {
  const sized =
    size === undefined
      ? undefined
      : side === 'left' || side === 'right'
        ? { width: size }
        : { height: size };

  return (
    <RadixDialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} modal>
      {trigger === undefined ? null : <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="rq-scrim" />
        <RadixDialog.Content
          ref={ref}
          className={cx('rq-sheet', className)}
          data-side={side}
          style={sized}
        >
          <div className="rq-sheet__header">
            <div style={{ minWidth: 0 }}>
              <RadixDialog.Title className="rq-sheet__title">{title}</RadixDialog.Title>
              {description === undefined ? null : (
                <RadixDialog.Description className="rq-sheet__description">
                  {description}
                </RadixDialog.Description>
              )}
            </div>
            {showClose ? (
              <RadixDialog.Close asChild>
                <IconButton label={closeLabel} icon={<CloseIcon />} size="sm" />
              </RadixDialog.Close>
            ) : null}
          </div>
          {children === undefined ? null : <div className="rq-sheet__body">{children}</div>}
          {footer === undefined ? null : <div className="rq-sheet__footer">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
});

export const SheetClose = RadixDialog.Close;
