'use client';

import { forwardRef, useId } from 'react';
import type { ReactNode } from 'react';
import { Checkbox as RadixCheckbox } from 'radix-ui';
import { cx } from '../utils.js';
import { CheckIcon, MinusIcon } from '../icons.js';

export type CheckedState = boolean | 'indeterminate';

export interface CheckboxProps {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  onCheckedChange?: (checked: CheckedState) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  value?: string;
  id?: string;
  className?: string;
  /** Announced as an error and marks the control invalid. */
  error?: ReactNode;
}

/** Square 18px control, radius 4. `indeterminate` renders a dash, not a tick. */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  {
    checked,
    defaultChecked,
    onCheckedChange,
    label,
    hint,
    disabled = false,
    required = false,
    name,
    value,
    id,
    className,
    error,
  },
  ref,
) {
  const generated = useId();
  const controlId = id ?? `rq-${generated}`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const invalid = error !== undefined && error !== null && error !== false;

  return (
    <div className="rq-choice" data-disabled={disabled ? 'true' : undefined}>
      <RadixCheckbox.Root
        ref={ref}
        id={controlId}
        className={cx('rq-checkbox', 'rq-focusable', className)}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        required={required}
        name={name}
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : hint === undefined ? undefined : hintId}
      >
        <RadixCheckbox.Indicator className="rq-checkbox__indicator">
          {checked === 'indeterminate' ? <MinusIcon size={12} /> : <CheckIcon size={12} />}
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      {label === undefined && hint === undefined && !invalid ? null : (
        <span className="rq-choice__text">
          {label === undefined ? null : (
            <label className="rq-choice__label" htmlFor={controlId}>
              {label}
            </label>
          )}
          {invalid ? (
            <span className="rq-field__error" id={errorId} role="alert">
              {error}
            </span>
          ) : hint === undefined ? null : (
            <span className="rq-choice__hint" id={hintId}>
              {hint}
            </span>
          )}
        </span>
      )}
    </div>
  );
});
