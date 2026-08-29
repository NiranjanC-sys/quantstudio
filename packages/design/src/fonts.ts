/**
 * Font wiring for a Next.js App Router consumer.
 *
 * The design package cannot call `next/font/google` itself, because the loader
 * only runs inside a Next build. Instead it publishes the exact arguments the
 * app should pass, and the CSS variable names `tokens.css` reads.
 *
 * ```ts
 * // apps/web/app/layout.tsx
 * import { Instrument_Sans, Newsreader, IBM_Plex_Mono } from 'next/font/google';
 * import { fontVariables } from '@redquant/design';
 *
 * const display = Instrument_Sans({
 *   subsets: ['latin'],
 *   display: 'swap',
 *   variable: '--font-instrument-sans',
 *   weight: ['400', '500', '600'],
 * });
 * const prose = Newsreader({
 *   subsets: ['latin'],
 *   display: 'swap',
 *   variable: '--font-newsreader',
 *   weight: ['300', '400', '500'],
 *   style: ['normal', 'italic'],
 * });
 * const mono = IBM_Plex_Mono({
 *   subsets: ['latin'],
 *   display: 'swap',
 *   variable: '--font-ibm-plex-mono',
 *   weight: ['400', '500'],
 * });
 *
 * <html className={[display.variable, prose.variable, mono.variable].join(' ')}>
 * ```
 */

export interface GoogleFontSpec {
  /** The `next/font/google` export name. */
  loader: string;
  /** Google Fonts family name. */
  family: string;
  /** CSS custom property `tokens.css` reads. */
  variable: string;
  weights: readonly string[];
  styles: readonly string[];
  subsets: readonly string[];
  /** Stack used when the webfont has not loaded. */
  fallback: readonly string[];
}

const SANS_FALLBACK = [
  'ui-sans-serif',
  'system-ui',
  '-apple-system',
  'Segoe UI',
  'Roboto',
  'Helvetica',
  'Arial',
  'sans-serif',
] as const;

const SERIF_FALLBACK = [
  'ui-serif',
  'Georgia',
  'Cambria',
  'Times New Roman',
  'Times',
  'serif',
] as const;

const MONO_FALLBACK = [
  'ui-monospace',
  'SFMono-Regular',
  'SF Mono',
  'Menlo',
  'Consolas',
  'Liberation Mono',
  'monospace',
] as const;

/** Display and UI. Every heading, label and control. */
export const displayFont: GoogleFontSpec = {
  loader: 'Instrument_Sans',
  family: 'Instrument Sans',
  variable: '--font-instrument-sans',
  weights: ['400', '500', '600'],
  styles: ['normal'],
  subsets: ['latin'],
  fallback: SANS_FALLBACK,
};

/** Prose. The Monograph register. */
export const proseFont: GoogleFontSpec = {
  loader: 'Newsreader',
  family: 'Newsreader',
  variable: '--font-newsreader',
  weights: ['300', '400', '500'],
  styles: ['normal', 'italic'],
  subsets: ['latin'],
  fallback: SERIF_FALLBACK,
};

/** Code and every number a learner might compare. The numeric lock. */
export const monoFont: GoogleFontSpec = {
  loader: 'IBM_Plex_Mono',
  family: 'IBM Plex Mono',
  variable: '--font-ibm-plex-mono',
  weights: ['400', '500'],
  styles: ['normal'],
  subsets: ['latin'],
  fallback: MONO_FALLBACK,
};

export const fonts = {
  display: displayFont,
  prose: proseFont,
  mono: monoFont,
} as const;

/** The three CSS variable names, in the order the `<html>` class expects. */
export const fontVariables = [
  displayFont.variable,
  proseFont.variable,
  monoFont.variable,
] as const;

/** Full stack string for a spec, useful outside Tailwind. */
export function fontStack(spec: GoogleFontSpec): string {
  const quoted = (name: string): string => (/\s/.test(name) ? `"${name}"` : name);
  return [`var(${spec.variable}, ${quoted(spec.family)})`, ...spec.fallback.map(quoted)].join(', ');
}
