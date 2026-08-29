'use client';

import { forwardRef, useCallback } from 'react';
import type { ReactNode } from 'react';
import { Slider as RadixSlider } from 'radix-ui';
import { cx } from '../utils.js';
import { useFieldIds, type FieldParts } from './field.js';

export interface SliderProps extends FieldParts {
  /** One number, or two for a range. */
  value?: number | readonly number[];
  defaultValue?: number | readonly number[];
  /** Fires continuously while dragging and on every key press. */
  onValueChange?: (value: number[]) => void;
  /** Fires once, when the pointer is released or the key is lifted. */
  onValueCommit?: (value: number[]) => void;
  min?: number;
  max?: number;
  /**
   * Granularity. Gate parameters want something fine, for example
   * `Math.PI / 180` for a rotation angle in degrees.
   */
  step?: number;
  orientation?: 'horizontal' | 'vertical';
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
  /** Mono tabular readout beside the label. */
  showValue?: boolean;
  /** Formats the readout and the announced `aria-valuetext`. */
  formatValue?: (value: number) => string;
  /** Per-thumb accessible names. Required for a range. */
  thumbLabels?: readonly string[];
  children?: ReactNode;
}

const toArray = (value: number | readonly number[] | undefined): number[] | undefined =>
  value === undefined ? undefined : typeof value === 'number' ? [value] : [...value];

const defaultFormat = (value: number): string =>
  Number.isInteger(value) ? value.toString() : value.toFixed(3);

/**
 * Continuous control for live gate parameters.
 *
 * Radix supplies the keyboard model: Arrow keys move by `step`, Page keys by
 * ten steps, Home and End jump to the ends. `onValueChange` fires on every one
 * of those, so a statevector can be recomputed as the thumb moves.
 */
export const Slider = forwardRef<HTMLSpanElement, SliderProps>(function Slider(
  {
    value,
    defaultValue,
    onValueChange,
    onValueCommit,
    min = 0,
    max = 1,
    step = 0.01,
    orientation = 'horizontal',
    disabled = false,
    name,
    id,
    className,
    showValue = true,
    formatValue = defaultFormat,
    thumbLabels,
    label,
    hint,
    error,
    required = false,
  },
  ref,
) {
  const ids = useFieldIds({ label, hint, error, required }, id);
  const controlled = toArray(value);
  const uncontrolled = toArray(defaultValue) ?? [min];
  const current = controlled ?? uncontrolled;

  const handleChange = useCallback(
    (next: number[]) => {
      onValueChange?.(next);
    },
    [onValueChange],
  );

  const readout = current.map(formatValue).join(' to ');

  return (
    <div className="rq-slider-field">
      {label === undefined && !showValue ? null : (
        <div className="rq-slider-field__head">
          {label === undefined ? (
            <span />
          ) : (
            <span className="rq-field__label" id={ids.labelId}>
              {label}
              {required ? (
                <span className="rq-field__required" aria-hidden="true">
                  *
                </span>
              ) : null}
            </span>
          )}
          {showValue ? (
            <output className="rq-slider-field__value" htmlFor={ids.controlId}>
              {readout}
            </output>
          ) : null}
        </div>
      )}

      <RadixSlider.Root
        ref={ref}
        id={ids.controlId}
        className={cx('rq-slider', className)}
        value={controlled}
        defaultValue={controlled === undefined ? uncontrolled : undefined}
        onValueChange={handleChange}
        onValueCommit={onValueCommit}
        min={min}
        max={max}
        step={step}
        orientation={orientation}
        disabled={disabled}
        name={name}
        aria-labelledby={ids.labelId}
        aria-describedby={ids.describedBy}
      >
        <RadixSlider.Track className="rq-slider__track">
          <RadixSlider.Range className="rq-slider__range" />
        </RadixSlider.Track>
        {current.map((thumbValue, index) => (
          <RadixSlider.Thumb
            // eslint-disable-next-line react/no-array-index-key -- thumb count is stable
            key={index}
            className={cx('rq-slider__thumb', 'rq-focusable')}
            aria-label={thumbLabels?.[index] ?? (typeof label === 'string' ? label : 'Value')}
            aria-valuetext={formatValue(thumbValue)}
          />
        ))}
      </RadixSlider.Root>

      {ids.invalid ? (
        <span className="rq-field__error" id={ids.errorId} role="alert">
          {error}
        </span>
      ) : hint === undefined ? null : (
        <span className="rq-field__hint" id={ids.hintId}>
          {hint}
        </span>
      )}
    </div>
  );
});
