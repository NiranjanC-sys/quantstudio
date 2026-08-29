'use client';

import { forwardRef, useId } from 'react';
import type { ReactNode } from 'react';
import { Switch as RadixSwitch } from 'radix-ui';
import { cx } from '../utils.js';

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  value?: string;
  id?: string;
  className?: string;
  /** Puts the label before the control. */
  labelPosition?: 'start' | 'end';
}

/**
 * On or off, applied immediately. If the change needs confirming, use a
 * Checkbox in a form instead.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
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
    labelPosition = 'end',
  },
  ref,
) {
  const generated = useId();
  const controlId = id ?? `rq-${generated}`;
  const hintId = `${controlId}-hint`;

  const control = (
    <RadixSwitch.Root
      ref={ref}
      id={controlId}
      className={cx('rq-switch', 'rq-focusable', className)}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      required={required}
      name={name}
      value={value}
      aria-describedby={hint === undefined ? undefined : hintId}
    >
      <RadixSwitch.Thumb className="rq-switch__thumb" />
    </RadixSwitch.Root>
  );

  if (label === undefined && hint === undefined) return control;

  const text = (
    <span className="rq-choice__text">
      {label === undefined ? null : (
        <label className="rq-choice__label" htmlFor={controlId}>
          {label}
        </label>
      )}
      {hint === undefined ? null : (
        <span className="rq-choice__hint" id={hintId}>
          {hint}
        </span>
      )}
    </span>
  );

  return (
    <div
      className="rq-choice"
      data-disabled={disabled ? 'true' : undefined}
      style={{ alignItems: 'center' }}
    >
      {labelPosition === 'start' ? (
        <>
          {text}
          {control}
        </>
      ) : (
        <>
          {control}
          {text}
        </>
      )}
    </div>
  );
});
