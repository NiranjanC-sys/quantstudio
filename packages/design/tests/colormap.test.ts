import { describe, expect, it } from 'vitest';
import {
  magnitudeColor,
  magnitudeStops,
  phaseColor,
  phaseStops,
} from '../src/tokens.js';
import { hexToOklch, parseHex, relativeLuminance } from '../src/color.js';

const TAU = Math.PI * 2;

describe('phaseColor', () => {
  it('closes the cycle: 0 and 2 pi are the same colour', () => {
    expect(phaseColor(0)).toBe(phaseColor(TAU));
  });

  it('wraps in both directions', () => {
    expect(phaseColor(-TAU)).toBe(phaseColor(0));
    expect(phaseColor(Math.PI)).toBe(phaseColor(Math.PI + TAU));
    expect(phaseColor(Math.PI)).toBe(phaseColor(Math.PI - TAU));
    expect(phaseColor(7 * TAU + 1)).toBe(phaseColor(1));
  });

  it('lands on each declared stop', () => {
    for (let index = 0; index < phaseStops.length - 1; index += 1) {
      const angle = (index / (phaseStops.length - 1)) * TAU;
      expect(phaseColor(angle)).toBe((phaseStops[index] as string).toLowerCase());
    }
  });

  it('is continuous across the seam', () => {
    const before = parseHex(phaseColor(TAU - 1e-4));
    const after = parseHex(phaseColor(1e-4));
    const distance = Math.hypot(
      before.r - after.r,
      before.g - after.g,
      before.b - after.b,
    );
    expect(distance).toBeLessThan(0.02);
  });

  it('keeps midpoints saturated, which naive sRGB interpolation would not', () => {
    // The lowest chroma of any declared stop, as the floor a midpoint must hold.
    const stopChroma = phaseStops.map((stop) => hexToOklch(stop).C);
    const floor = Math.min(...stopChroma) * 0.85;
    for (let i = 0; i < 256; i += 1) {
      const angle = (i / 256) * TAU;
      expect(hexToOklch(phaseColor(angle)).C).toBeGreaterThan(floor);
    }
  });

  it('returns the first stop for non-finite input rather than throwing', () => {
    expect(phaseColor(Number.NaN)).toBe((phaseStops[0] as string).toLowerCase());
    expect(phaseColor(Number.POSITIVE_INFINITY)).toBe((phaseStops[0] as string).toLowerCase());
  });

  it('produces a valid hex colour at every angle', () => {
    for (let i = 0; i < 512; i += 1) {
      expect(phaseColor((i / 512) * TAU)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('magnitudeColor', () => {
  it('declares stops that strictly increase in perceptual lightness', () => {
    let previous = -Infinity;
    for (const stop of magnitudeStops) {
      const L = hexToOklch(stop).L;
      expect(L).toBeGreaterThan(previous);
      previous = L;
    }
  });

  it('strictly increases in perceptual lightness as it is sampled', () => {
    let previous = -Infinity;
    for (let i = 0; i <= 64; i += 1) {
      const L = hexToOklch(magnitudeColor(i / 64)).L;
      expect(L).toBeGreaterThan(previous);
      previous = L;
    }
  });

  it('never reverses in lightness, sampled finely', () => {
    /*
     * The interpolation itself is exactly monotonic; the output is quantised to
     * 8 bits per channel, which can nudge a sample back by a fraction of one
     * code point. The tolerance is that quantisation floor and nothing more:
     * the measured worst case over 2000 samples is 4.2e-4.
     */
    const quantisation = 1e-3;
    let previous = -Infinity;
    for (let i = 0; i <= 2000; i += 1) {
      const L = hexToOklch(magnitudeColor(i / 2000)).L;
      expect(L).toBeGreaterThanOrEqual(previous - quantisation);
      previous = Math.max(previous, L);
    }
  });

  it('is monotonic in WCAG relative luminance too', () => {
    let previous = -Infinity;
    for (let i = 0; i <= 64; i += 1) {
      const luminance = relativeLuminance(magnitudeColor(i / 64));
      expect(luminance).toBeGreaterThan(previous);
      previous = luminance;
    }
  });

  it('strictly increases in lightness end to end', () => {
    expect(hexToOklch(magnitudeColor(1)).L).toBeGreaterThan(hexToOklch(magnitudeColor(0)).L);
  });

  it('lands on the declared endpoints', () => {
    expect(magnitudeColor(0)).toBe((magnitudeStops[0] as string).toLowerCase());
    expect(magnitudeColor(1)).toBe(
      (magnitudeStops[magnitudeStops.length - 1] as string).toLowerCase(),
    );
  });

  it('clamps out of range input', () => {
    expect(magnitudeColor(-5)).toBe(magnitudeColor(0));
    expect(magnitudeColor(5)).toBe(magnitudeColor(1));
    expect(magnitudeColor(Number.NaN)).toBe(magnitudeColor(0));
  });
});
