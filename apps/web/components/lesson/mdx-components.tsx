import type { ComponentProps } from 'react';
import type { MDXComponents } from 'mdx/types';

type P<T extends keyof React.JSX.IntrinsicElements> = ComponentProps<T>;
import { LessonCircuit } from './LessonCircuit';
import { Margin } from './Margin';
import { Check } from './Check';
import { Solution } from './Solution';
import { Callout } from './Callout';

/**
 * Link protocols a lesson may point at.
 *
 * MDX compiles to JSX, so a lesson's `[text](javascript:...)` becomes a real
 * anchor with a real href. Curriculum files are written by people who never
 * touch application code and reviewed as prose, so the renderer refuses the
 * script-bearing schemes rather than trusting review to catch them.
 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function safeHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  const trimmed = href.trim();
  // Relative, absolute-path, and same-page links have no protocol at all.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    try {
      if (!SAFE_PROTOCOLS.has(new URL(trimmed).protocol)) return undefined;
    } catch {
      return undefined;
    }
  }
  return trimmed;
}

export const mdxComponents: MDXComponents = {
  Circuit: LessonCircuit,
  Simulate: LessonCircuit,
  Margin,
  Check,
  Solution,
  Callout,
  h2: (p: P<'h2'>) => <h2 className="rq-lesson-h2" {...p} />,
  h3: (p: P<'h3'>) => <h3 className="rq-lesson-h3" {...p} />,
  p: (p: P<'p'>) => <p className="rq-lesson-p" {...p} />,
  ul: (p: P<'ul'>) => <ul className="rq-lesson-ul" {...p} />,
  ol: (p: P<'ol'>) => <ol className="rq-lesson-ol" {...p} />,
  blockquote: (p: P<'blockquote'>) => <blockquote className="rq-lesson-quote" {...p} />,
  table: (p) => (
    <div className="rq-lesson-table-wrap">
      <table className="rq-lesson-table" {...p} />
    </div>
  ),
  pre: (p: P<'pre'>) => <pre className="rq-lesson-pre" {...p} />,
  code: (p: P<'code'>) => <code className="rq-lesson-code" {...p} />,
  a: ({ href, ...p }: P<'a'>) => <a className="rq-lesson-a" href={safeHref(href)} {...p} />,
};
