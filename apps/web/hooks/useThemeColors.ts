'use client';

import { useEffect, useState } from 'react';
import type React from 'react';

const TOKENS = [
  'canvas', 'surface-1', 'surface-2', 'surface-inset',
  'hairline', 'hairline-strong',
  'ink', 'ink-muted', 'ink-subtle', 'ink-faint',
  'accent', 'accent-hover', 'success', 'warning', 'danger', 'info',
] as const;

export type TokenName = (typeof TOKENS)[number];
export type TokenMap = Record<TokenName, string>;

const FALLBACK: TokenMap = {
  canvas: '#08090B', 'surface-1': '#0E1013', 'surface-2': '#14171B', 'surface-inset': '#0A0B0D',
  hairline: '#22262C', 'hairline-strong': '#2F343B',
  ink: '#F4F5F7', 'ink-muted': '#B4BAC3', 'ink-subtle': '#7C848F', 'ink-faint': '#525963',
  accent: '#FF4A1C', 'accent-hover': '#FF6740',
  success: '#2FA36B', warning: '#D99420', danger: '#E2453B', info: '#3D8BD4',
};

/**
 * Read the design tokens out of CSS so WebGL materials follow the theme.
 *
 * Three.js cannot resolve `var(--accent)`, so the values are sampled from the
 * DOM. Sampling must happen at the consuming element, not at documentElement:
 * the Instrument register redefines the whole palette on a subtree, and
 * reading from the root would hand a dark-surface instrument the light theme.
 */
export function useThemeColors(ref?: React.RefObject<HTMLElement | null>): TokenMap {
  const [colors, setColors] = useState<TokenMap>(FALLBACK);

  useEffect(() => {
    const read = () => {
      const el = ref?.current ?? document.documentElement;
      const style = getComputedStyle(el);
      const next = { ...FALLBACK };
      for (const t of TOKENS) {
        const v = style.getPropertyValue(`--${t}`).trim();
        if (v) next[t] = v;
      }
      setColors(next);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', read);
    return () => {
      observer.disconnect();
      mq.removeEventListener('change', read);
    };
  }, [ref]);

  return colors;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}
