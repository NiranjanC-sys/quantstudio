/**
 * Colour science for the RedQuant design system.
 *
 * Everything here is dependency free and pure. It exists for two reasons:
 *
 *  1. The phase and magnitude colormaps in DESIGN.md must be interpolated in a
 *     perceptual space. Naive sRGB interpolation drives the midpoints through
 *     grey and produces the muddy transitions the spec forbids.
 *  2. The contrast floor in DESIGN.md (4.5:1 body, 3:1 large text and non-text
 *     indicators, in both themes) is asserted by the test suite, so the WCAG
 *     relative luminance formula is implemented here rather than imported.
 *
 * Conversions follow Bjoern Ottosson's OKLab derivation.
 */

export interface RGB {
  /** 0..1 */ r: number;
  /** 0..1 */ g: number;
  /** 0..1 */ b: number;
}

export interface OKLab {
  /** 0..1 perceptual lightness */ L: number;
  a: number;
  b: number;
}

export interface OKLCH {
  /** 0..1 perceptual lightness */ L: number;
  /** >= 0 */ C: number;
  /** degrees, 0..360 */ h: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/* -------------------------------------------------------------------------- */
/* Hex                                                                        */
/* -------------------------------------------------------------------------- */

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. Alpha is discarded; every
 * token in DESIGN.md that carries alpha is expressed as `rgba()` instead.
 */
export function parseHex(hex: string): RGB {
  const match = HEX_RE.exec(hex.trim());
  if (!match) throw new Error(`Not a hex colour: ${hex}`);
  const body = match[1] as string;
  const expand = (s: string): number => parseInt(s.length === 1 ? s + s : s, 16) / 255;
  if (body.length <= 4) {
    return {
      r: expand(body[0] as string),
      g: expand(body[1] as string),
      b: expand(body[2] as string),
    };
  }
  return {
    r: expand(body.slice(0, 2)),
    g: expand(body.slice(2, 4)),
    b: expand(body.slice(4, 6)),
  };
}

const channelToHex = (v: number): string =>
  Math.round(clamp01(v) * 255)
    .toString(16)
    .padStart(2, '0');

export function formatHex({ r, g, b }: RGB): string {
  return `#${channelToHex(r)}${channelToHex(g)}${channelToHex(b)}`;
}

/* -------------------------------------------------------------------------- */
/* sRGB transfer function                                                     */
/* -------------------------------------------------------------------------- */

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/* -------------------------------------------------------------------------- */
/* OKLab / OKLCH                                                              */
/* -------------------------------------------------------------------------- */

export function rgbToOklab({ r, g, b }: RGB): OKLab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

export function oklabToRgb({ L, a, b }: OKLab): RGB {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: clamp01(linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp01(linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp01(linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  };
}

export function oklabToOklch({ L, a, b }: OKLab): OKLCH {
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

export function oklchToOklab({ L, C, h }: OKLCH): OKLab {
  const rad = (h * Math.PI) / 180;
  return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
}

export const hexToOklab = (hex: string): OKLab => rgbToOklab(parseHex(hex));
export const hexToOklch = (hex: string): OKLCH => oklabToOklch(hexToOklab(hex));
export const oklabToHex = (lab: OKLab): string => formatHex(oklabToRgb(lab));
export const oklchToHex = (lch: OKLCH): string => oklabToHex(oklchToOklab(lch));

/* -------------------------------------------------------------------------- */
/* Interpolation                                                              */
/* -------------------------------------------------------------------------- */

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Straight-line mix in OKLab. Correct for sequential ramps. */
export function mixOklab(from: string, to: string, t: number): string {
  const a = hexToOklab(from);
  const b = hexToOklab(to);
  return oklabToHex({ L: lerp(a.L, b.L, t), a: lerp(a.a, b.a, t), b: lerp(a.b, b.b, t) });
}

/**
 * Mix in OKLCH taking the shorter arc around the hue circle. Correct for
 * cyclic ramps, where a straight OKLab line would cut through the achromatic
 * axis and desaturate the midpoint.
 */
export function mixOklch(from: string, to: string, t: number): string {
  const a = hexToOklch(from);
  const b = hexToOklch(to);

  let dh = b.h - a.h;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;

  // A stop with no chroma has no meaningful hue; hold the neighbour's hue so
  // the interpolation does not swing through an arbitrary angle.
  const ah = a.C < 1e-6 ? b.h : a.h;
  const hue = a.C < 1e-6 ? b.h : ah + dh * t;

  return oklchToHex({
    L: lerp(a.L, b.L, t),
    C: lerp(a.C, b.C, t),
    h: ((hue % 360) + 360) % 360,
  });
}

export type RampSpace = 'oklab' | 'oklch';

/**
 * Sample a ramp of hex stops at `t`, clamped to [0, 1]. `t = 1` returns the
 * final stop exactly.
 */
export function sampleRamp(stops: readonly string[], t: number, space: RampSpace): string {
  if (stops.length === 0) throw new Error('sampleRamp needs at least one stop');
  const first = stops[0] as string;
  if (stops.length === 1) return first;

  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const segments = stops.length - 1;
  const scaled = clamped * segments;
  const index = Math.min(segments - 1, Math.floor(scaled));
  const local = scaled - index;

  const a = stops[index] as string;
  const b = stops[index + 1] as string;
  if (local === 0) return a.toLowerCase();
  if (local === 1) return b.toLowerCase();
  return space === 'oklch' ? mixOklch(a, b, local) : mixOklab(a, b, local);
}

/**
 * Shift lightness in OKLCH while holding hue and chroma. Used to derive the
 * light-theme variants of tokens DESIGN.md only fixes for dark, exactly the way
 * the spec derives its own light accent ("darkened for AA on paper"). It never
 * introduces a new hue, so the colour lock holds.
 */
export function withLightness(hex: string, L: number): string {
  const lch = hexToOklch(hex);
  return oklchToHex({ ...lch, L: clamp01(L) });
}

/** Scale lightness by a factor in OKLCH, holding hue and chroma. */
export function scaleLightness(hex: string, factor: number): string {
  const lch = hexToOklch(hex);
  return oklchToHex({ ...lch, L: clamp01(lch.L * factor) });
}

/* -------------------------------------------------------------------------- */
/* WCAG contrast                                                              */
/* -------------------------------------------------------------------------- */

/** WCAG 2.x relative luminance. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2.x contrast ratio, 1..21. Order of arguments does not matter. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Composite a translucent `rgba(r, g, b, a)` or hex colour over an opaque
 * backdrop so the result can be measured for contrast.
 */
export function flatten(color: string, backdrop: string): string {
  const rgba = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/i.exec(
    color.trim(),
  );
  const base = parseHex(backdrop);
  if (!rgba) {
    const solid = parseHex(color);
    return formatHex(solid);
  }
  const alpha = rgba[4] === undefined ? 1 : Number(rgba[4]);
  const fg: RGB = {
    r: Number(rgba[1]) / 255,
    g: Number(rgba[2]) / 255,
    b: Number(rgba[3]) / 255,
  };
  return formatHex({
    r: fg.r * alpha + base.r * (1 - alpha),
    g: fg.g * alpha + base.g * (1 - alpha),
    b: fg.b * alpha + base.b * (1 - alpha),
  });
}
