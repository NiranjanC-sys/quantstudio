'use client';

import { createContext, forwardRef, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Toast as RadixToast } from 'radix-ui';
import { cx } from '../utils.js';
import { CloseIcon } from '../icons.js';
import { IconButton } from './IconButton.js';

export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** ms. `Infinity` keeps it until dismissed. */
  duration?: number;
  action?: { label: string; onClick: () => void; altText: string };
}

export interface ToastRecord extends ToastOptions {
  id: string;
}

export interface ToastProps extends ToastOptions {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  closeLabel?: string;
}

/**
 * One notification. A status tone is carried by a 3px left rule, never by a
 * tinted background, so the text keeps its contrast.
 */
export const Toast = forwardRef<HTMLLIElement, ToastProps>(function Toast(
  {
    title,
    description,
    tone = 'neutral',
    duration = 5000,
    action,
    open,
    onOpenChange,
    className,
    closeLabel = 'Dismiss',
  },
  ref,
) {
  return (
    <RadixToast.Root
      ref={ref}
      className={cx('rq-toast', className)}
      data-tone={tone}
      open={open}
      onOpenChange={onOpenChange}
      duration={Number.isFinite(duration) ? duration : Number.MAX_SAFE_INTEGER}
    >
      <div style={{ minWidth: 0 }}>
        <RadixToast.Title className="rq-toast__title">{title}</RadixToast.Title>
        {description === undefined ? null : (
          <RadixToast.Description className="rq-toast__description">
            {description}
          </RadixToast.Description>
        )}
      </div>
      <div className="rq-toast__side">
        {action === undefined ? null : (
          <RadixToast.Action asChild altText={action.altText}>
            <button
              type="button"
              className={cx('rq-button', 'rq-focusable')}
              data-variant="tertiary"
              data-size="sm"
              onClick={action.onClick}
            >
              <span className="rq-button__label">{action.label}</span>
            </button>
          </RadixToast.Action>
        )}
        <RadixToast.Close asChild>
          <IconButton label={closeLabel} icon={<CloseIcon size={14} />} size="sm" />
        </RadixToast.Close>
      </div>
    </RadixToast.Root>
  );
});

export interface ToastContextValue {
  /** Queue a toast. Returns its id. */
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
  /** Everything currently queued. */
  toasts: readonly ToastRecord[];
}

const ToastContext = createContext<ToastContextValue | null>(null);

export interface ToastProviderProps {
  children: ReactNode;
  /** ms. Per-toast `duration` wins. */
  duration?: number;
  /** Keyboard shortcut that jumps to the viewport. */
  hotkey?: string[];
  label?: string;
}

/** Mount once, near the root, inside `ThemeProvider`. */
export function ToastProvider({
  children,
  duration = 5000,
  hotkey = ['F8'],
  label = 'Notifications',
}: ToastProviderProps): ReactNode {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const id = `rq-toast-${Math.random().toString(36).slice(2, 10)}`;
    setToasts((current) => [...current, { ...options, id }]);
    return id;
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ toast, dismiss, toasts }),
    [toast, dismiss, toasts],
  );

  return (
    <ToastContext.Provider value={value}>
      <RadixToast.Provider duration={duration} swipeDirection="right" label={label}>
        {children}
        {toasts.map((record) => (
          <Toast
            key={record.id}
            {...record}
            open
            onOpenChange={(next) => {
              if (!next) dismiss(record.id);
            }}
          />
        ))}
        <RadixToast.Viewport className="rq-toast-viewport" hotkey={hotkey} />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error('useToast must be used inside a ToastProvider');
  }
  return context;
}
