import { forwardRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { cx } from '../utils.js';
import { FieldShell, useFieldIds, type FieldParts } from './field.js';

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement>,
    FieldParts {
  /** Renders a live count against `maxLength`. */
  showCount?: boolean;
}

/** Multi-line field. Resizes vertically only, so a layout cannot be broken sideways. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    label,
    hint,
    error,
    required = false,
    showCount = false,
    id,
    className,
    maxLength,
    value,
    defaultValue,
    ...props
  },
  ref,
) {
  const ids = useFieldIds({ label, hint, error, required }, id);
  const current = typeof value === 'string' ? value.length : undefined;
  const counted =
    showCount && maxLength !== undefined && current !== undefined
      ? `${current} of ${maxLength}`
      : undefined;

  return (
    <FieldShell
      ids={ids}
      label={label}
      hint={counted === undefined ? hint : (hint ?? counted)}
      error={error}
      required={required}
    >
      <textarea
        ref={ref}
        id={ids.controlId}
        className={cx('rq-textarea', className)}
        aria-invalid={ids.invalid || undefined}
        aria-describedby={ids.describedBy}
        aria-required={required || undefined}
        required={required}
        maxLength={maxLength}
        value={value}
        defaultValue={defaultValue}
        {...props}
      />
      {counted === undefined ? null : (
        <span className="rq-field__hint" style={{ textAlign: 'end' }} aria-live="polite">
          {counted}
        </span>
      )}
    </FieldShell>
  );
});
