import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';
import { Spinner } from './Spinner.js';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Blocks activation, shows a spinner and sets `aria-busy`. */
  loading?: boolean;
  /** Announced while loading. */
  loadingLabel?: string;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

/**
 * Height 36, 32 at sm and 44 at lg. Radius 6. Focus is a 2px accent ring at 2px
 * offset, the same ring every focusable thing in the system gets.
 *
 * The label keeps its box while loading, so the button never resizes under the
 * pointer.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    loadingLabel = 'Working',
    leadingIcon,
    trailingIcon,
    fullWidth = false,
    type = 'button',
    disabled,
    className,
    style,
    children,
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
      className={cx('rq-button', 'rq-focusable', className)}
      data-variant={variant}
      data-size={size}
      data-loading={loading ? 'true' : undefined}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      style={fullWidth ? { width: '100%', ...style } : style}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...props}
    >
      <span className="rq-button__label">
        {leadingIcon}
        {children}
        {trailingIcon}
      </span>
      {loading ? (
        <span className="rq-button__loader">
          <Spinner size={size === 'lg' ? 18 : 16} label={loadingLabel} />
        </span>
      ) : null}
    </button>
  );
});
