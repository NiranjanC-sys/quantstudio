'use client';

import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';
import { CheckIcon, CopyIcon } from '../icons.js';
import { IconButton } from './IconButton.js';

export interface CodeBlockProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  code: string;
  /** Shown in the 40px header row when present. */
  filename?: string;
  /** Announced only; no highlighting is applied. */
  language?: string;
  showLineNumbers?: boolean;
  /** 1-based line numbers to mark with an accent rule. */
  highlightLines?: readonly number[];
  showCopy?: boolean;
  copyLabel?: string;
  copiedLabel?: string;
  /** Header row, right of the filename. */
  actions?: ReactNode;
}

/**
 * IBM Plex Mono on `--surface-inset`.
 *
 * The copy button writes to the clipboard and confirms in place for two
 * seconds. If the Clipboard API is unavailable or refused, the button reports
 * the failure rather than silently pretending it worked.
 */
export const CodeBlock = forwardRef<HTMLDivElement, CodeBlockProps>(function CodeBlock(
  {
    code,
    filename,
    language,
    showLineNumbers = false,
    highlightLines,
    showCopy = true,
    copyLabel = 'Copy code',
    copiedLabel = 'Copied',
    actions,
    className,
    ...props
  },
  ref,
) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(() => {
    const reset = (): void => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), 2000);
    };
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      setState('failed');
      reset();
      return;
    }
    navigator.clipboard.writeText(code).then(
      () => {
        setState('copied');
        reset();
      },
      () => {
        setState('failed');
        reset();
      },
    );
  }, [code]);

  const lines = code.replace(/\n$/, '').split('\n');
  const highlighted = new Set(highlightLines ?? []);
  const hasHead = filename !== undefined || actions !== undefined;

  const copyButton = showCopy ? (
    <IconButton
      className="rq-code__copy"
      size="sm"
      label={state === 'copied' ? copiedLabel : copyLabel}
      icon={state === 'copied' ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      onClick={copy}
    />
  ) : null;

  return (
    <div
      ref={ref}
      className={cx('rq-code', className)}
      data-numbered={showLineNumbers ? 'true' : undefined}
      data-has-head={hasHead ? 'true' : undefined}
      {...props}
    >
      {hasHead ? (
        <div className="rq-code__head">
          <span className="rq-code__filename">{filename}</span>
          <span className="rq-panel__controls">
            {actions}
            {copyButton}
          </span>
        </div>
      ) : (
        copyButton
      )}
      <pre className="rq-code__pre" tabIndex={0} aria-label={language ?? undefined}>
        <code>
          {lines.map((line, index) => (
            <span
              // eslint-disable-next-line react/no-array-index-key -- lines are positional
              key={index}
              className="rq-code__line"
              data-highlighted={highlighted.has(index + 1) ? 'true' : undefined}
            >
              {line === '' ? ' ' : line}
            </span>
          ))}
        </code>
      </pre>
      <span className="rq-sr-only" role="status">
        {state === 'copied' ? copiedLabel : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </div>
  );
});
