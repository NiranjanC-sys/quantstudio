'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { Select as RadixSelect } from 'radix-ui';
import { cx } from '../utils.js';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from '../icons.js';
import { FieldShell, useFieldIds, type FieldParts } from './field.js';

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  /** Groups options under an uppercase eyebrow. */
  group?: string;
}

export interface SelectProps extends FieldParts {
  options: readonly SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
  /** Shown in the list when `options` is empty. */
  emptyMessage?: string;
}

/**
 * Radix Select for the listbox behaviour, wearing our tokens. Typeahead, arrow
 * keys, Home and End, Escape and outside click all come from Radix.
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    options,
    value,
    defaultValue,
    onValueChange,
    placeholder = 'Select',
    size = 'md',
    disabled = false,
    name,
    id,
    className,
    label,
    hint,
    error,
    required = false,
    emptyMessage = 'No options',
  },
  ref,
) {
  const ids = useFieldIds({ label, hint, error, required }, id);
  const groups = new Map<string, SelectOption[]>();
  for (const option of options) {
    const key = option.group ?? '';
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [option]);
    else bucket.push(option);
  }

  return (
    <FieldShell
      ids={ids}
      label={label}
      hint={hint}
      error={error}
      required={required}
      labelAs="span"
    >
      <RadixSelect.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        disabled={disabled}
        name={name}
        required={required}
      >
        <RadixSelect.Trigger
          ref={ref}
          id={ids.controlId}
          className={cx('rq-select__trigger', 'rq-focusable', className)}
          data-size={size}
          aria-invalid={ids.invalid || undefined}
          aria-describedby={ids.describedBy}
          aria-labelledby={ids.labelId === undefined ? undefined : `${ids.labelId} ${ids.controlId}`}
        >
          <RadixSelect.Value placeholder={placeholder} />
          <RadixSelect.Icon className="rq-select__icon">
            <ChevronDownIcon />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>

        <RadixSelect.Portal>
          <RadixSelect.Content
            className={cx('rq-select__content', 'rq-overlay-anim')}
            position="popper"
            sideOffset={6}
          >
            <RadixSelect.ScrollUpButton className="rq-select__scroll">
              <ChevronUpIcon />
            </RadixSelect.ScrollUpButton>
            <RadixSelect.Viewport className="rq-select__viewport">
              {options.length === 0 ? (
                <div className="rq-select__label">{emptyMessage}</div>
              ) : (
                [...groups.entries()].map(([group, items]) => {
                  const body = items.map((option) => (
                    <RadixSelect.Item
                      key={option.value}
                      value={option.value}
                      disabled={option.disabled}
                      className="rq-select__item"
                    >
                      <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                      <RadixSelect.ItemIndicator className="rq-select__indicator">
                        <CheckIcon size={14} />
                      </RadixSelect.ItemIndicator>
                    </RadixSelect.Item>
                  ));
                  if (group === '') return body;
                  return (
                    <RadixSelect.Group key={group}>
                      <RadixSelect.Label className="rq-select__label">{group}</RadixSelect.Label>
                      {body}
                    </RadixSelect.Group>
                  );
                })
              )}
            </RadixSelect.Viewport>
            <RadixSelect.ScrollDownButton className="rq-select__scroll">
              <ChevronDownIcon />
            </RadixSelect.ScrollDownButton>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </FieldShell>
  );
});
