/** Join class names, dropping anything falsy. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    out = out === '' ? part : `${out} ${part}`;
  }
  return out;
}

/** Clamp `value` into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return value < min ? min : value > max ? max : value;
}

let counter = 0;
/**
 * Stable-enough id for cases where `useId` is unavailable, such as module-scope
 * chart helpers. Prefer `useId` inside components.
 */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}
