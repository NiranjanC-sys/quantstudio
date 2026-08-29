/**
 * RedQuant design tokens.
 *
 * These are the same values `tokens.css` publishes as custom properties. The TS
 * copy exists so charts, colormaps and tests can reason about the palette
 * without a live stylesheet.
 *
 * Provenance rules used throughout this file:
 *  - Values marked `spec` are copied verbatim from DESIGN.md.
 *  - Values marked `derived` are produced from a spec value by moving lightness
 *    in OKLCH while holding hue and chroma. DESIGN.md derives its own light
 *    accent that way ("darkened for AA on paper"), and the contrast floor it
 *    sets (4.5:1 body, 3:1 large text and non-text indicators, both themes)
 *    cannot be met otherwise. No derivation introduces a new hue, so the colour
 *    lock holds.
 */

import { sampleRamp } from './color.js';

/* -------------------------------------------------------------------------- */
/* Colour                                                                     */
/* -------------------------------------------------------------------------- */

export interface ColorTokens {
  /** Page ground. */
  canvas: string;
  /** Cards, panels. */
  surface1: string;
  /** Raised surfaces, input fills. */
  surface2: string;
  /** Hover and active track. A state layer, never a resting text ground. */
  surface3: string;
  /** Wells, code blocks, circuit grid. */
  surfaceInset: string;
  /** Default border. */
  hairline: string;
  /** Emphasis border, focus ring base. */
  hairlineStrong: string;
  /** Primary text. */
  ink: string;
  /** Secondary text. */
  inkMuted: string;
  /** Tertiary text, captions. */
  inkSubtle: string;
  /** Disabled text and grid labels. Exempt from WCAG 1.4.3 as inactive. */
  inkFaint: string;
  /** Action and live state. Rules, focus rings, indicators. */
  accent: string;
  /** Accent as text, and as a ground that carries `onAccent`. */
  accentStrong: string;
  accentHover: string;
  accentPress: string;
  /** 10% accent, backdrops only. */
  accentWash: string;
  /** Foreground for anything sitting on an accent or semantic ground. */
  onAccent: string;
  success: string;
  successStrong: string;
  successWash: string;
  warning: string;
  warningStrong: string;
  warningWash: string;
  danger: string;
  dangerStrong: string;
  dangerWash: string;
  info: string;
  infoStrong: string;
  infoWash: string;
}

/** Instrument register. The default theme. */
export const darkColors: ColorTokens = {
  canvas: '#08090B', //          spec
  surface1: '#0E1013', //        spec
  surface2: '#14171B', //        spec
  surface3: '#1A1E23', //        spec
  surfaceInset: '#0A0B0D', //    spec
  hairline: '#22262C', //        spec
  hairlineStrong: '#2F343B', //  spec
  ink: '#F4F5F7', //             spec
  inkMuted: '#B4BAC3', //        spec
  inkSubtle: '#7C848F', //       spec
  inkFaint: '#525963', //        spec
  accent: '#FF4A1C', //          spec
  accentStrong: '#FF4A1C', //    spec (already clears 4.5:1 on every text ground)
  accentHover: '#FF6740', //     spec
  accentPress: '#E23A10', //     spec
  accentWash: 'rgba(255, 74, 28, 0.10)', // spec
  onAccent: '#0A0A0A', //        spec
  success: '#2FA36B', //         spec
  successStrong: '#2FA36B', //   spec
  successWash: 'rgba(47, 163, 107, 0.10)',
  warning: '#D99420', //         spec
  warningStrong: '#D99420', //   spec
  warningWash: 'rgba(217, 148, 32, 0.10)',
  danger: '#E2453B', //          spec
  // derived: spec danger lifted 0.006 OKLCH L. At #E2453B it measures 4.41:1 on
  // --surface-2 and misses the body floor; identical hue and chroma.
  dangerStrong: '#E4473D',
  dangerWash: 'rgba(226, 69, 59, 0.10)',
  info: '#3D8BD4', //            spec
  infoStrong: '#3D8BD4', //      spec
  infoWash: 'rgba(61, 139, 212, 0.10)',
};

/** Monograph register on warm paper. */
export const lightColors: ColorTokens = {
  canvas: '#FBFAF8', //          spec
  surface1: '#FFFFFF', //        spec
  surface2: '#F4F2EE', //        spec
  surface3: '#EAE7E1', //        spec
  surfaceInset: '#F7F5F1', //    spec
  hairline: '#E2DED7', //        spec
  hairlineStrong: '#CFC9C0', //  spec
  ink: '#131518', //             spec
  inkMuted: '#4A4F57', //        spec
  // derived: spec #6E747D measures 4.21:1 on --surface-2. Darkened 0.008 OKLCH L.
  inkSubtle: '#696F78',
  inkFaint: '#9AA0A8', //        spec
  accent: '#E23A10', //          spec
  // derived: spec accent measures 4.33:1 against --on-accent and 4.15:1 on
  // paper, short of the body floor. Same hue, darkened for AA exactly as the
  // spec darkens the dark-theme accent for paper.
  accentStrong: '#D52A00',
  accentHover: '#CC1F00', //     derived, hover darkens on paper
  accentPress: '#BB0000', //     derived
  accentWash: 'rgba(226, 58, 16, 0.10)',
  onAccent: '#FFFFFF', //        spec
  // derived: DESIGN.md fixes no light-theme semantics. Each is the dark hue
  // darkened until it clears 4.5:1 on every light text ground.
  success: '#007F4A',
  successStrong: '#007F4A',
  successWash: 'rgba(0, 127, 74, 0.10)',
  warning: '#A15F00',
  warningStrong: '#A15F00',
  warningWash: 'rgba(161, 95, 0, 0.10)',
  danger: '#D0322B',
  dangerStrong: '#D0322B',
  dangerWash: 'rgba(208, 50, 43, 0.10)',
  info: '#2072B9',
  infoStrong: '#2072B9',
  infoWash: 'rgba(32, 114, 185, 0.10)',
};

export const colors = { dark: darkColors, light: lightColors } as const;

export type ThemeName = 'light' | 'dark';

/* -------------------------------------------------------------------------- */
/* Colormaps                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Cyclic colormap for `arg(amplitude)`. Data only, exempt from the colour lock.
 * The last stop repeats the first so the ramp closes on itself.
 */
export const phaseStops = [
  '#5B8FF0',
  '#3FBFA8',
  '#9BD146',
  '#F2C230',
  '#F2703A',
  '#D6539E',
  '#7B5BD6',
  '#5B8FF0',
] as const;

/** Sequential ramp for `|amplitude|^2`. Monotonic in lightness. */
export const magnitudeStops = [
  '#12161B',
  '#3A2016',
  '#6B2E14',
  '#A63B12',
  '#E2500F',
  '#FF7A45',
  '#FFB894',
] as const;

const TAU = Math.PI * 2;

/**
 * Colour for a phase angle in radians. The input wraps, so `phaseColor(0)`,
 * `phaseColor(2 * Math.PI)` and `phaseColor(-2 * Math.PI)` are the same colour.
 *
 * Interpolation runs in OKLCH along the shorter hue arc. Interpolating this
 * ramp in sRGB would drive every midpoint toward grey.
 */
export function phaseColor(radians: number): string {
  if (!Number.isFinite(radians)) return phaseStops[0].toLowerCase();
  const wrapped = ((radians % TAU) + TAU) % TAU;
  return sampleRamp(phaseStops, wrapped / TAU, 'oklch');
}

/**
 * Colour for a normalised magnitude or probability in `[0, 1]`. Out of range
 * input clamps. Interpolation runs in OKLab, which keeps the ramp monotonic in
 * perceptual lightness.
 */
export function magnitudeColor(p: number): string {
  return sampleRamp(magnitudeStops, p, 'oklab');
}

/* -------------------------------------------------------------------------- */
/* Typography                                                                 */
/* -------------------------------------------------------------------------- */

export type FontFamilyRole = 'display' | 'prose' | 'mono';

/**
 * Font stacks. The first entry of each is the CSS variable a Next.js app sets
 * with `next/font/google`, so the loaded face wins and the literal family name
 * covers a locally installed copy.
 */
export const fontFamilies = {
  /** Instrument Sans. Display and UI. */
  display:
    'var(--font-instrument-sans, "Instrument Sans"), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  /** Newsreader. Prose. */
  prose:
    'var(--font-newsreader, "Newsreader"), ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  /** IBM Plex Mono. Code and every comparable number. */
  mono: 'var(--font-ibm-plex-mono, "IBM Plex Mono"), ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const satisfies Record<FontFamilyRole, string>;

export interface TypeStyle {
  family: FontFamilyRole;
  /** px */
  size: number;
  weight: number;
  lineHeight: number;
  /** em */
  tracking: number;
  transform?: 'uppercase';
  /** Tabular figures. The numeric lock. */
  tabular?: boolean;
}

export type TypeRole =
  | 'display-xl'
  | 'display-lg'
  | 'display-md'
  | 'headline'
  | 'title'
  | 'ui'
  | 'ui-sm'
  | 'eyebrow'
  | 'prose'
  | 'prose-lg'
  | 'prose-lead'
  | 'marginalia'
  | 'mono'
  | 'numeric';

export const typeScale = {
  'display-xl': { family: 'display', size: 76, weight: 500, lineHeight: 1.02, tracking: -0.035 },
  'display-lg': { family: 'display', size: 52, weight: 500, lineHeight: 1.06, tracking: -0.028 },
  'display-md': { family: 'display', size: 38, weight: 500, lineHeight: 1.12, tracking: -0.022 },
  headline: { family: 'display', size: 27, weight: 500, lineHeight: 1.2, tracking: -0.016 },
  title: { family: 'display', size: 20, weight: 500, lineHeight: 1.28, tracking: -0.011 },
  ui: { family: 'display', size: 14, weight: 450, lineHeight: 1.45, tracking: -0.003 },
  'ui-sm': { family: 'display', size: 13, weight: 450, lineHeight: 1.4, tracking: 0 },
  eyebrow: {
    family: 'display',
    size: 12,
    weight: 550,
    lineHeight: 1.3,
    tracking: 0.07,
    transform: 'uppercase',
  },
  prose: { family: 'prose', size: 19, weight: 400, lineHeight: 1.65, tracking: 0 },
  'prose-lg': { family: 'prose', size: 21, weight: 400, lineHeight: 1.62, tracking: -0.005 },
  'prose-lead': { family: 'prose', size: 24, weight: 350, lineHeight: 1.5, tracking: -0.008 },
  marginalia: { family: 'display', size: 13, weight: 450, lineHeight: 1.5, tracking: 0 },
  mono: { family: 'mono', size: 13.5, weight: 400, lineHeight: 1.6, tracking: 0 },
  numeric: { family: 'mono', size: 13, weight: 450, lineHeight: 1.3, tracking: 0, tabular: true },
} as const satisfies Record<TypeRole, TypeStyle>;

/* -------------------------------------------------------------------------- */
/* Space, shape, layout                                                       */
/* -------------------------------------------------------------------------- */

/** 8px base. The only spacing values in the system. */
export const space = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
  12: 48,
  16: 64,
  24: 96,
  32: 128,
  48: 192,
} as const;

/** Soft radii only. `pill` is reserved for Tag and nothing else. */
export const radius = {
  xs: 4,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 9999,
} as const;

export const layout = {
  /** Prose column width, holding the 62 to 72 character measure. */
  proseColumn: 680,
  /** Monograph frame the prose column is left-aligned inside. */
  monographFrame: 1180,
  /** Marginalia rail width on viewports at or above `marginaliaBreakpoint`. */
  marginaliaRail: 200,
  marginaliaBreakpoint: 1180,
  /** Instrument grid. */
  gridColumns: 12,
  gridGutter: 16,
  pagePadding: 24,
  /** Space at a Monograph section break, plus a prose-width hairline. */
  sectionBreak: 96,
  /** Panel header row. */
  panelHeader: 40,
  /** Lab result bar. */
  verdictStrip: 44,
  /** Circuit canvas. */
  wirePitch: 48,
  momentColumn: 56,
  controlDot: 7,
  /** Phase disc beside an amplitude bar. */
  phaseDisc: 10,
  /** Nav bar ceiling above the fold. */
  navHeight: 64,
} as const;

export const controlHeight = { sm: 32, md: 36, lg: 44 } as const;
export type ControlSize = keyof typeof controlHeight;

/** Focus ring: 2px accent at 2px offset, on every focusable thing. */
export const focusRing = { width: 2, offset: 2 } as const;

/* -------------------------------------------------------------------------- */
/* Bloch instrument                                                           */
/* -------------------------------------------------------------------------- */

/** Geometry for the procedural Bloch sphere. No downloaded art. */
export const blochSpec = {
  meridians: 24,
  parallels: 12,
  fov: 38,
  shaftRadius: 0.06,
  groundGrid: false,
} as const;
