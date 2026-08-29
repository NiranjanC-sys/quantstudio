/**
 * Motion constants and hooks.
 *
 * DESIGN.md bans scroll event listeners on `window`. Scroll-linked reveals go
 * through `IntersectionObserver`, and `prefers-reduced-motion` drops everything
 * to opacity.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Milliseconds. */
export const duration = {
  /** Hover, press, checked. */
  state: 120,
  /** Overlay and popover enter. */
  enter: 200,
  /** Overlay and popover exit. */
  exit: 200,
  /** Size, position and reflow. */
  layout: 320,
  /** 3D camera moves. */
  camera: 600,
} as const;

export const easing = {
  enter: 'cubic-bezier(0.2, 0, 0, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;

/** For anything a pointer drags. Feed straight into a spring integrator. */
export const spring = { stiffness: 260, damping: 30 } as const;

export type DurationName = keyof typeof duration;

/** `120ms` etc, ready for a style object. */
export const ms = (name: DurationName): string => `${duration[name]}ms`;

/**
 * A transition shorthand. Returns `'none'` when the reader has asked for
 * reduced motion, so callers cannot accidentally animate a transform.
 */
export function transition(
  properties: readonly string[],
  name: DurationName = 'state',
  curve: keyof typeof easing = 'enter',
  reduced = false,
): string {
  if (reduced) return 'opacity 1ms linear';
  return properties.map((p) => `${p} ${ms(name)} ${easing[curve]}`).join(', ');
}

/* -------------------------------------------------------------------------- */
/* prefers-reduced-motion                                                     */
/* -------------------------------------------------------------------------- */

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const mql = window.matchMedia(REDUCED_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function readReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_QUERY).matches;
}

/** Server snapshot is `false`; the client corrects on hydration. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false);
}

/* -------------------------------------------------------------------------- */
/* useReveal                                                                  */
/* -------------------------------------------------------------------------- */

export interface RevealOptions {
  /** Fraction of the element that must be visible. */
  threshold?: number;
  /** Root margin, same syntax as IntersectionObserver. */
  rootMargin?: string;
  /** Stop observing after the first reveal. Default true. */
  once?: boolean;
  /** Skip observation entirely and report revealed immediately. */
  disabled?: boolean;
}

export interface Reveal<T extends Element> {
  /** Attach to the element that should reveal. */
  ref: (node: T | null) => void;
  /** True once the element has entered the viewport. */
  revealed: boolean;
  /**
   * Spread onto the element. Carries `data-rq-reveal`, which the stylesheet
   * uses to run the transition, so no inline transform is needed.
   */
  props: { 'data-rq-reveal': 'hidden' | 'shown' };
}

/**
 * Reveal on scroll without a scroll listener.
 *
 * Under `prefers-reduced-motion` the element is reported revealed on mount, so
 * nothing translates and nothing is hidden from a reader who never scrolls.
 */
export function useReveal<T extends Element = HTMLElement>(
  options: RevealOptions = {},
): Reveal<T> {
  const { threshold = 0.15, rootMargin = '0px 0px -10% 0px', once = true, disabled = false } =
    options;

  const reducedMotion = usePrefersReducedMotion();
  const skip =
    disabled ||
    reducedMotion ||
    typeof IntersectionObserver === 'undefined' ||
    typeof window === 'undefined';

  const [revealed, setRevealed] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const nodeRef = useRef<T | null>(null);

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  const ref = useCallback(
    (node: T | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      nodeRef.current = node;

      if (node === null) return;
      if (skip) {
        setRevealed(true);
        return;
      }

      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              setRevealed(true);
              if (once) {
                observer.disconnect();
                observerRef.current = null;
              }
            } else if (!once) {
              setRevealed(false);
            }
          }
        },
        { threshold, rootMargin },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [skip, once, threshold, rootMargin],
  );

  useEffect(() => {
    if (skip) setRevealed(true);
  }, [skip]);

  return {
    ref,
    revealed,
    props: { 'data-rq-reveal': revealed ? 'shown' : 'hidden' },
  };
}
