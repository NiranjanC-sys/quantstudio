import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';
import { Spinner } from './Spinner.js';

export type IconButtonVariant = 'ghost' | 'primary' | 'secondary' | 'danger';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** Required. The button has no visible text. */
  label: string;
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  loading?: boolean;
  /** Renders the pressed state and sets `aria-pressed`. */
  pressed?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

/** Square control. The accessible name comes from `label`, never from a title. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    variant = 'ghost',
    size = 'md',
    loading = false,
    pressed,
    type = 'button',
    disabled,
    className,
    onClick,
    ...props
  },
  ref,
) {
  const isDisabled = disabled === true || loading;
  return (
    <button
      ref={ref}
      type={type}
      className={cx('rq-icon-button', 'rq-focusable', className)}
      data-variant={variant}
      data-size={size}
      data-pressed={pressed === true ? 'true' : undefined}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      disabled={isDisabled}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...props}
    >
      {loading ? <Spinner size={size === 'sm' ? 14 : 16} label={null} /> : icon}
    </button>
  );
});
