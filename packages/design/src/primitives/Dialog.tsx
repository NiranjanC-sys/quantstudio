'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { Dialog as RadixDialog } from 'radix-ui';
import { cx } from '../utils.js';
import { CloseIcon } from '../icons.js';
import { IconButton } from './IconButton.js';

export type DialogSize = 'sm' | 'md' | 'lg';

export interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional. Omit when the dialog is opened imperatively. */
  trigger?: ReactNode;
  title: ReactNode;
  /** Strongly recommended. Announced with the title. */
  description?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  size?: DialogSize;
  className?: string;
  showClose?: boolean;
  closeLabel?: string;
  /** Blocks Escape and outside click. Use only for destructive confirmation. */
  dismissible?: boolean;
}

/**
 * Modal.
 *
 * Radix handles the three things a modal must get right: focus is trapped
 * inside while open and restored to the trigger on close, Escape dismisses, and
 * the body scroll is locked so the page behind cannot move.
 */
export const Dialog = forwardRef<HTMLDivElement, DialogProps>(function Dialog(
  {
    open,
    defaultOpen,
    onOpenChange,
    trigger,
    title,
    description,
    footer,
    children,
    size = 'md',
    className,
    showClose = true,
    closeLabel = 'Close',
    dismissible = true,
  },
  ref,
) {
  return (
    <RadixDialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} modal>
      {trigger === undefined ? null : <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="rq-scrim" />
        <RadixDialog.Content
          ref={ref}
          className={cx('rq-dialog', className)}
          data-size={size}
          onEscapeKeyDown={dismissible ? undefined : (event) => event.preventDefault()}
          onPointerDownOutside={dismissible ? undefined : (event) => event.preventDefault()}
          onInteractOutside={dismissible ? undefined : (event) => event.preventDefault()}
        >
          <div className="rq-dialog__header">
            <div style={{ minWidth: 0 }}>
              <RadixDialog.Title className="rq-dialog__title">{title}</RadixDialog.Title>
              {description === undefined ? null : (
                <RadixDialog.Description className="rq-dialog__description">
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
          {children === undefined ? null : <div className="rq-dialog__body">{children}</div>}
          {footer === undefined ? null : <div className="rq-dialog__footer">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
});

export const DialogClose = RadixDialog.Close;
