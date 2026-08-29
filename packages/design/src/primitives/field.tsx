import { useId } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../utils.js';

export interface FieldParts {
  label?: ReactNode;
  /** Helper text under the control. Hidden while `error` is set. */
  hint?: ReactNode;
  /** Turns the control red and is announced. Replaces `hint`. */
  error?: ReactNode;
  required?: boolean;
}

export interface FieldIds {
  controlId: string;
  labelId: string | undefined;
  describedBy: string | undefined;
  hintId: string;
  errorId: string;
  invalid: boolean;
}

/** Wires label, hint and error to one control without the caller doing it. */
export function useFieldIds(parts: FieldParts, providedId?: string): FieldIds {
  const generated = useId();
  const controlId = providedId ?? `rq-${generated}`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const invalid = parts.error !== undefined && parts.error !== null && parts.error !== false;
  const described: string[] = [];
  if (invalid) described.push(errorId);
  else if (parts.hint !== undefined) described.push(hintId);
  return {
    controlId,
    labelId: parts.label === undefined ? undefined : `${controlId}-label`,
    describedBy: described.length === 0 ? undefined : described.join(' '),
    hintId,
    errorId,
    invalid,
  };
}

export interface FieldShellProps extends FieldParts {
  ids: FieldIds;
  /** `label` for a native control, `span` when the control is not labelable. */
  labelAs?: 'label' | 'span';
  className?: string;
  children: ReactNode;
}

export function FieldShell({
  ids,
  label,
  hint,
  error,
  required = false,
  labelAs = 'label',
  className,
  children,
}: FieldShellProps): ReactNode {
  const LabelTag = labelAs;
  return (
    <div className={cx('rq-field', className)}>
      {label === undefined ? null : (
        <LabelTag
          className="rq-field__label"
          id={ids.labelId}
          {...(labelAs === 'label' ? { htmlFor: ids.controlId } : {})}
        >
          {label}
          {required ? (
            <span className="rq-field__required" aria-hidden="true">
              *
            </span>
          ) : null}
        </LabelTag>
      )}
      {children}
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
}
