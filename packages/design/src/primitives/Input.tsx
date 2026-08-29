import { forwardRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';
import { FieldShell, useFieldIds, type FieldParts } from './field.js';

export type InputSize = 'sm' | 'md' | 'lg';

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'>,
    FieldParts {
  inputSize?: InputSize;
  /** Sets IBM Plex Mono with tabular figures. The numeric lock. */
  numeric?: boolean;
  /** Non-interactive adornment inside the field. */
  prefix?: ReactNode;
  suffix?: ReactNode;
}

/**
 * Text field on `--surface-2` with a `--hairline-strong` border, radius 6.
 * Height matches Button so the two line up in a toolbar.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    hint,
    error,
    required = false,
    inputSize = 'md',
    numeric = false,
    prefix,
    suffix,
    id,
    className,
    disabled,
    ...props
  },
  ref,
) {
  const ids = useFieldIds({ label, hint, error, required }, id);
  return (
    <FieldShell ids={ids} label={label} hint={hint} error={error} required={required}>
      <span className="rq-input-wrap">
        {prefix === undefined ? null : (
          <span className="rq-input-wrap__affix" data-side="start">
            {prefix}
          </span>
        )}
        <input
          ref={ref}
          id={ids.controlId}
          className={cx('rq-input', className)}
          data-size={inputSize}
          data-numeric={numeric ? 'true' : undefined}
          data-affix-start={prefix === undefined ? undefined : 'true'}
          data-affix-end={suffix === undefined ? undefined : 'true'}
          aria-invalid={ids.invalid || undefined}
          aria-describedby={ids.describedBy}
          aria-required={required || undefined}
          required={required}
          disabled={disabled}
          {...props}
        />
        {suffix === undefined ? null : (
          <span className="rq-input-wrap__affix" data-side="end">
            {suffix}
          </span>
        )}
      </span>
    </FieldShell>
  );
});
