import type { ComponentProps } from 'react';
import type { MDXComponents } from 'mdx/types';

type P<T extends keyof React.JSX.IntrinsicElements> = ComponentProps<T>;
import { LessonCircuit } from './LessonCircuit';
import { Margin } from './Margin';
import { Check } from './Check';
import { Solution } from './Solution';
import { Callout } from './Callout';

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
  a: (p: P<'a'>) => <a className="rq-lesson-a" {...p} />,
};
