import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  duration,
  easing,
  ms,
  spring,
  transition,
  useReveal,
  usePrefersReducedMotion,
} from '../src/motion.js';

/*
 * useReveal is the only sanctioned way to run scroll-linked motion in this
 * system. It has to observe, it has to clean up, and it has to hand a reader on
 * reduced motion a revealed element rather than an invisible one.
 */

type ObserverRecord = {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
  observed: Element[];
  disconnected: boolean;
};

const records: ObserverRecord[] = [];

function installObserver(): void {
  records.length = 0;
  class Recording implements IntersectionObserver {
    readonly root: Element | null = null;
    readonly rootMargin: string = '';
    readonly thresholds: readonly number[] = [];
    private readonly record: ObserverRecord;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.record = { callback, options, observed: [], disconnected: false };
      records.push(this.record);
    }
    observe(target: Element): void {
      this.record.observed.push(target);
    }
    unobserve(): void {}
    disconnect(): void {
      this.record.disconnected = true;
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', Recording as unknown as typeof IntersectionObserver);
}

function fire(index: number, isIntersecting: boolean): void {
  const record = records[index];
  if (record === undefined) throw new Error(`no observer at ${index}`);
  const target = record.observed[0];
  if (target === undefined) throw new Error('observer never observed anything');
  act(() => {
    record.callback(
      [
        {
          isIntersecting,
          target,
          intersectionRatio: isIntersecting ? 1 : 0,
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
  });
}

function Revealer(props: Parameters<typeof useReveal>[0] = {}) {
  const { ref, revealed, props: dataProps } = useReveal<HTMLDivElement>(props);
  return (
    <div ref={ref} data-testid="target" {...dataProps}>
      {revealed ? 'shown' : 'hidden'}
    </div>
  );
}

describe('motion constants', () => {
  it('carries the durations DESIGN.md fixes', () => {
    expect(duration).toEqual({ state: 120, enter: 200, exit: 200, layout: 320, camera: 600 });
    expect(ms('layout')).toBe('320ms');
  });

  it('carries the declared easings and drag spring', () => {
    expect(easing.enter).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(easing.exit).toBe('cubic-bezier(0.4, 0, 1, 1)');
    expect(spring).toEqual({ stiffness: 260, damping: 30 });
  });

  it('drops to opacity under reduced motion', () => {
    expect(transition(['transform', 'opacity'], 'enter', 'enter', true)).toBe('opacity 1ms linear');
    expect(transition(['opacity'], 'state')).toBe('opacity 120ms cubic-bezier(0.2, 0, 0, 1)');
  });
});

describe('useReveal', () => {
  it('observes the node with the requested threshold and margin', () => {
    installObserver();
    render(<Revealer threshold={0.4} rootMargin="0px 0px -25% 0px" />);

    expect(records).toHaveLength(1);
    expect(records[0]?.options).toEqual({ threshold: 0.4, rootMargin: '0px 0px -25% 0px' });
    expect(records[0]?.observed[0]).toBe(screen.getByTestId('target'));
  });

  it('starts hidden and reveals when the element intersects', async () => {
    installObserver();
    render(<Revealer />);

    const target = screen.getByTestId('target');
    expect(target).toHaveAttribute('data-rq-reveal', 'hidden');

    fire(0, true);
    await waitFor(() => expect(target).toHaveAttribute('data-rq-reveal', 'shown'));
  });

  it('disconnects after the first reveal when once is set', async () => {
    installObserver();
    render(<Revealer once />);
    fire(0, true);
    await waitFor(() => expect(records[0]?.disconnected).toBe(true));
  });

  it('keeps observing and can hide again when once is false', async () => {
    installObserver();
    render(<Revealer once={false} />);
    const target = screen.getByTestId('target');

    fire(0, true);
    await waitFor(() => expect(target).toHaveAttribute('data-rq-reveal', 'shown'));
    expect(records[0]?.disconnected).toBe(false);

    fire(0, false);
    await waitFor(() => expect(target).toHaveAttribute('data-rq-reveal', 'hidden'));
  });

  it('disconnects on unmount', () => {
    installObserver();
    const view = render(<Revealer />);
    view.unmount();
    expect(records[0]?.disconnected).toBe(true);
  });

  it('reveals immediately when disabled, without observing', () => {
    installObserver();
    render(<Revealer disabled />);
    expect(records).toHaveLength(0);
    expect(screen.getByTestId('target')).toHaveAttribute('data-rq-reveal', 'shown');
  });

  it('reveals immediately when the browser has no IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<Revealer />);
    expect(screen.getByTestId('target')).toHaveAttribute('data-rq-reveal', 'shown');
  });

  it('reveals immediately under prefers-reduced-motion and never observes', () => {
    installObserver();
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );

    render(<Revealer />);
    expect(usePrefersReducedMotion).toBeTypeOf('function');
    expect(records).toHaveLength(0);
    expect(screen.getByTestId('target')).toHaveAttribute('data-rq-reveal', 'shown');
  });
});
