import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { darkColors, lightColors, type ColorTokens } from '../src/tokens.js';

/*
 * The WCAG maths is reimplemented here rather than imported from `src/color.ts`,
 * so this file is an independent check on the palette instead of a restatement
 * of the code that produced it.
 */

function channel(value: string): number {
  return parseInt(value, 16) / 255;
}

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

function readColor(value: string): Rgb {
  const trimmed = value.trim();
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(trimmed);
  if (rgba !== null) {
    const parts = (rgba[1] as string).split(/[,\s/]+/).filter(Boolean);
    return {
      r: Number(parts[0]) / 255,
      g: Number(parts[1]) / 255,
      b: Number(parts[2]) / 255,
      a: parts[3] === undefined ? 1 : Number(parts[3]),
    };
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hex === null) throw new Error(`Cannot read colour: ${value}`);
  const body = hex[1] as string;
  return {
    r: channel(body.slice(0, 2)),
    g: channel(body.slice(2, 4)),
    b: channel(body.slice(4, 6)),
    a: 1,
  };
}

/** WCAG 2.2 relative luminance. */
function luminance(value: string): number {
  const { r, g, b } = readColor(value);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.2 contrast ratio. */
function ratio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Composite a translucent colour over an opaque one. */
function over(top: string, bottom: string): string {
  const fg = readColor(top);
  const bg = readColor(bottom);
  const mix = (f: number, b: number): string =>
    Math.round((f * fg.a + b * (1 - fg.a)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${mix(fg.r, bg.r)}${mix(fg.g, bg.g)}${mix(fg.b, bg.b)}`;
}

const BODY = 4.5;
const LARGE = 3;

interface Ground {
  name: string;
  value: string;
}

/**
 * Grounds that carry resting text. `--surface-3` is deliberately absent: DESIGN.md
 * defines it as "hover, active track", a state layer, and text that lands on it
 * is `--ink`, which is checked separately at the large-text floor.
 */
function textGrounds(theme: ColorTokens): Ground[] {
  return [
    { name: 'canvas', value: theme.canvas },
    { name: 'surface-1', value: theme.surface1 },
    { name: 'surface-2', value: theme.surface2 },
    { name: 'surface-inset', value: theme.surfaceInset },
  ];
}

function washGrounds(theme: ColorTokens): Ground[] {
  const washes: Array<[string, string]> = [
    ['accent-wash', theme.accentWash],
    ['success-wash', theme.successWash],
    ['warning-wash', theme.warningWash],
    ['danger-wash', theme.dangerWash],
    ['info-wash', theme.infoWash],
  ];
  const bases: Array<[string, string]> = [
    ['canvas', theme.canvas],
    ['surface-1', theme.surface1],
    ['surface-2', theme.surface2],
  ];
  return washes.flatMap(([washName, wash]) =>
    bases.map(([baseName, base]) => ({
      name: `${washName} over ${baseName}`,
      value: over(wash, base),
    })),
  );
}

const THEMES: Array<[string, ColorTokens]> = [
  ['dark', darkColors],
  ['light', lightColors],
];

describe.each(THEMES)('%s theme contrast', (themeName, theme) => {
  const grounds = textGrounds(theme);

  it('reads its own sanity check correctly', () => {
    // Black on white is 21:1 by definition. If this drifts, the maths is wrong.
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(ratio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  describe('body text on every text ground meets 4.5:1', () => {
    const bodyForegrounds: Array<[string, string]> = [
      ['ink', theme.ink],
      ['ink-muted', theme.inkMuted],
      ['ink-subtle', theme.inkSubtle],
      ['accent-strong', theme.accentStrong],
      ['success-strong', theme.successStrong],
      ['warning-strong', theme.warningStrong],
      ['danger-strong', theme.dangerStrong],
      ['info-strong', theme.infoStrong],
    ];

    for (const [fgName, fg] of bodyForegrounds) {
      for (const ground of grounds) {
        it(`${fgName} on ${ground.name}`, () => {
          const measured = ratio(fg, ground.value);
          expect(
            measured,
            `${themeName}: ${fgName} on ${ground.name} is ${measured.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(BODY);
        });
      }
    }
  });

  describe('text over a 10 percent wash meets 4.5:1', () => {
    for (const ground of washGrounds(theme)) {
      for (const [fgName, fg] of [
        ['ink', theme.ink],
        ['ink-muted', theme.inkMuted],
      ] as Array<[string, string]>) {
        it(`${fgName} on ${ground.name}`, () => {
          const measured = ratio(fg, ground.value);
          expect(
            measured,
            `${themeName}: ${fgName} on ${ground.name} is ${measured.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(BODY);
        });
      }
    }
  });

  describe('on-accent meets 4.5:1 on every ground that carries it', () => {
    const solids: Array<[string, string]> = [
      ['accent-strong', theme.accentStrong],
      ['accent-hover', theme.accentHover],
      ['accent-press', theme.accentPress],
      ['success-strong', theme.successStrong],
      ['warning-strong', theme.warningStrong],
      ['danger-strong', theme.dangerStrong],
      ['info-strong', theme.infoStrong],
    ];
    for (const [name, background] of solids) {
      it(`on-accent on ${name}`, () => {
        const measured = ratio(theme.onAccent, background);
        expect(
          measured,
          `${themeName}: on-accent on ${name} is ${measured.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(BODY);
      });
    }
  });

  describe('indicators and large text meet 3:1 on every surface', () => {
    const indicators: Array<[string, string]> = [
      ['accent', theme.accent],
      ['success', theme.success],
      ['warning', theme.warning],
      ['danger', theme.danger],
      ['info', theme.info],
    ];
    const allSurfaces = [...grounds, { name: 'surface-3', value: theme.surface3 }];
    for (const [name, fg] of indicators) {
      for (const ground of allSurfaces) {
        it(`${name} on ${ground.name}`, () => {
          const measured = ratio(fg, ground.value);
          expect(
            measured,
            `${themeName}: ${name} on ${ground.name} is ${measured.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(LARGE);
        });
      }
    }
  });

  describe('the ink ladder still clears 3:1 on the state layer', () => {
    for (const [name, fg] of [
      ['ink', theme.ink],
      ['ink-muted', theme.inkMuted],
      ['ink-subtle', theme.inkSubtle],
    ] as Array<[string, string]>) {
      it(`${name} on surface-3`, () => {
        const measured = ratio(fg, theme.surface3);
        expect(
          measured,
          `${themeName}: ${name} on surface-3 is ${measured.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(LARGE);
      });
    }
  });

  it('never uses pure black or pure white as a page ground', () => {
    expect(theme.canvas.toLowerCase()).not.toBe('#000000');
    expect(theme.canvas.toLowerCase()).not.toBe('#ffffff');
  });

  it('keeps ink-faint out of the body-text budget', () => {
    /*
     * DESIGN.md assigns --ink-faint to disabled controls and grid labels. WCAG
     * 1.4.3 exempts inactive components, and this asserts the token is used
     * that way: it is deliberately below the body floor, and any use of it for
     * live text is a bug in the consuming component, not in the palette.
     */
    for (const ground of grounds) {
      expect(ratio(theme.inkFaint, ground.value)).toBeLessThan(BODY);
    }
  });
});

describe('tokens.css agrees with tokens.ts', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/tokens.css'), 'utf8');

  function block(selector: string): Record<string, string> {
    const start = css.indexOf(selector);
    expect(start, `missing selector ${selector}`).toBeGreaterThan(-1);
    const open = css.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = css.slice(open + 1, end);
    const out: Record<string, string> = {};
    for (const match of body.matchAll(/(--rq-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      out[match[1] as string] = (match[2] as string).trim();
    }
    return out;
  }

  const EXPECTED: Array<[keyof ColorTokens, string]> = [
    ['canvas', '--rq-canvas'],
    ['surface1', '--rq-surface-1'],
    ['surface2', '--rq-surface-2'],
    ['surface3', '--rq-surface-3'],
    ['surfaceInset', '--rq-surface-inset'],
    ['hairline', '--rq-hairline'],
    ['hairlineStrong', '--rq-hairline-strong'],
    ['ink', '--rq-ink'],
    ['inkMuted', '--rq-ink-muted'],
    ['inkSubtle', '--rq-ink-subtle'],
    ['inkFaint', '--rq-ink-faint'],
    ['accent', '--rq-accent'],
    ['accentStrong', '--rq-accent-strong'],
    ['accentHover', '--rq-accent-hover'],
    ['accentPress', '--rq-accent-press'],
    ['onAccent', '--rq-on-accent'],
    ['success', '--rq-success'],
    ['successStrong', '--rq-success-strong'],
    ['warning', '--rq-warning'],
    ['warningStrong', '--rq-warning-strong'],
    ['danger', '--rq-danger'],
    ['dangerStrong', '--rq-danger-strong'],
    ['info', '--rq-info'],
    ['infoStrong', '--rq-info-strong'],
  ];

  const norm = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

  it.each([
    ['light', ":root[data-theme='light']", lightColors],
    ['dark', ":root[data-theme='dark']", darkColors],
  ] as Array<[string, string, ColorTokens]>)(
    '%s block matches the TypeScript palette',
    (_name, selector, palette) => {
      const declared = block(selector);
      for (const [key, custom] of EXPECTED) {
        expect(declared[custom], `${selector} is missing ${custom}`).toBeDefined();
        expect(norm(declared[custom] as string)).toBe(norm(palette[key]));
      }
    },
  );

  it('defines the full light palette on bare :root, so no colour is media-only', () => {
    const bare = block('\n:root {');
    for (const [key, custom] of EXPECTED) {
      expect(bare[custom], `bare :root is missing ${custom}`).toBeDefined();
      expect(norm(bare[custom] as string)).toBe(norm(lightColors[key]));
    }
  });

  it('redefines dark under prefers-color-scheme and under an explicit toggle', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(":root:not([data-theme='light'])");
    expect(css).toContain(":root[data-theme='dark']");
    expect(css).toContain(":root[data-theme='light']");
  });

  it('puts the explicit light block last, so a toggle wins in both directions', () => {
    expect(css.lastIndexOf(":root[data-theme='light']")).toBeGreaterThan(
      css.lastIndexOf(":root[data-theme='dark']"),
    );
  });
});
