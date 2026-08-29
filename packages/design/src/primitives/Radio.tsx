'use client';

import { forwardRef, useId } from 'react';
import type { ReactNode } from 'react';
import { RadioGroup as RadixRadioGroup } from 'radix-ui';
import { cx } from '../utils.js';
import { FieldShell, useFieldIds, type FieldParts } from './field.js';

export interface RadioOption {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps extends FieldParts {
  options: readonly RadioOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: 'vertical' | 'horizontal';
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
}

/**
 * Radix RadioGroup gives the roving tabindex: one tab stop for the group, arrow
 * keys to move and select inside it.
 */
export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroup(
  {
    options,
    value,
    defaultValue,
    onValueChange,
    orientation = 'vertical',
    disabled = false,
    name,
    id,
    className,
    label,
    hint,
    error,
    required = false,
  },
  ref,
) {
  const ids = useFieldIds({ label, hint, error, required }, id);
  return (
    <FieldShell
      ids={ids}
      label={label}
      hint={hint}
      error={error}
      required={required}
      labelAs="span"
    >
      <RadixRadioGroup.Root
        ref={ref}
        id={ids.controlId}
        className={cx('rq-radio-group', className)}
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        orientation={orientation}
        disabled={disabled}
        name={name}
        required={required}
        aria-labelledby={ids.labelId}
        aria-describedby={ids.describedBy}
        aria-invalid={ids.invalid || undefined}
      >
        {options.map((option) => (
          <Radio key={option.value} {...option} />
        ))}
      </RadixRadioGroup.Root>
    </FieldShell>
  );
});

export interface RadioProps extends RadioOption {
  className?: string;
}

/** A single radio. Must live inside a `RadioGroup`. */
export const Radio = forwardRef<HTMLButtonElement, RadioProps>(function Radio(
  { value, label, hint, disabled = false, className },
  ref,
) {
  const generated = useId();
  const controlId = `rq-${generated}`;
  const hintId = `${controlId}-hint`;
  return (
    <div className="rq-choice" data-disabled={disabled ? 'true' : undefined}>
      <RadixRadioGroup.Item
        ref={ref}
        id={controlId}
        value={value}
        disabled={disabled}
        className={cx('rq-radio', 'rq-focusable', className)}
        aria-describedby={hint === undefined ? undefined : hintId}
      >
        <RadixRadioGroup.Indicator className="rq-radio__indicator" />
      </RadixRadioGroup.Item>
      <span className="rq-choice__text">
        <label className="rq-choice__label" htmlFor={controlId}>
          {label}
        </label>
        {hint === undefined ? null : (
          <span className="rq-choice__hint" id={hintId}>
            {hint}
          </span>
        )}
      </span>
    </div>
  );
});
