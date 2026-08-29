import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hexToOklch } from '../src/color.js';
import {
  darkColors,
  lightColors,
  magnitudeStops,
  phaseStops,
  radius,
  space,
  typeScale,
  type ColorTokens,
} from '../src/tokens.js';

/*
 * Mechanical enforcement of the locks and the ban list in DESIGN.md. These
 * assertions read the shipped source rather than a copy of it, so a regression
 * anywhere in the package fails here rather than in review.
 */

const ROOT = resolve(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(ROOT).sort();
const sources = files.map((path) => ({
  path: relative(process.cwd(), path),
  text: readFileSync(path, 'utf8'),
}));

const css = sources.filter((f) => f.path.endsWith('.css'));
const code = sources.filter((f) => /\.tsx?$/.test(f.path));

/**
 * Drop comments before policing behaviour. Several files name a banned pattern
 * in a doc comment precisely to say it is banned, and a ban test that fires on
 * its own documentation is a ban test nobody keeps.
 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const executable = sources.map((f) => ({ path: f.path, text: stripComments(f.text) }));

describe('the source tree is not empty', () => {
  it('found the files it is about to police', () => {
    expect(code.length).toBeGreaterThan(40);
    expect(css.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Motion: the scroll listener ban                                            */
/* -------------------------------------------------------------------------- */

describe('scroll listener ban', () => {
  it('never registers a scroll listener anywhere in the package', () => {
    const offenders = executable.filter((f) =>
      /addEventListener\s*\(\s*['"`]scroll['"`]/.test(f.text),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('never reads scrollY or scrollTop to drive motion', () => {
    const offenders = executable.filter(
      (f) =>
        /window\.(scrollY|pageYOffset)/.test(f.text) ||
        /onScroll\s*=/.test(f.text) ||
        /useScroll\s*\(/.test(f.text),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('drives reveals through IntersectionObserver instead', () => {
    const motion = sources.find((f) => f.path.endsWith('motion.ts'));
    expect(motion).toBeDefined();
    expect(motion?.text).toContain('new IntersectionObserver');
  });
});

/* -------------------------------------------------------------------------- */
/* Copy bans                                                                  */
/* -------------------------------------------------------------------------- */

describe('typographic bans', () => {
  it('contains no em-dash and no en-dash, in code or in copy', () => {
    const offenders = sources
      .filter((f) => /[—–]/.test(f.text))
      .map((f) => {
        const line = f.text.split('\n').findIndex((l) => /[—–]/.test(l)) + 1;
        return `${f.path}:${line}`;
      });
    expect(offenders).toEqual([]);
  });

  it('contains no section-numbering eyebrow such as 01 / OVERVIEW', () => {
    const offenders = executable.filter((f) => /['"`]\s*0\d\s*\/\s*[A-Z]{3,}/.test(f.text));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('contains no scroll-to-explore prompt', () => {
    const offenders = executable.filter((f) => /scroll to explore/i.test(f.text));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Surface bans                                                               */
/* -------------------------------------------------------------------------- */

describe('surface bans', () => {
  it('uses no glassmorphism: no backdrop-filter, no blurred translucent panel', () => {
    const offenders = executable.filter(
      (f) => /backdrop-filter/i.test(f.text) || /backdropFilter/.test(f.text),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('uses no mesh or blob gradient', () => {
    const offenders = executable.filter((f) => /radial-gradient|conic-gradient/i.test(f.text));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('never paints a panel shadow in the dark register', () => {
    const tokens = sources.find((f) => f.path.endsWith('tokens.css'));
    const dark = tokens?.text.slice(tokens.text.indexOf(":root[data-theme='dark']")) ?? '';
    expect(dark).toMatch(/--rq-shadow-panel:\s*none;/);
  });
});

/* -------------------------------------------------------------------------- */
/* Shape lock                                                                 */
/* -------------------------------------------------------------------------- */

describe('shape lock', () => {
  it('declares exactly the 4 / 6 / 10 / 14 / 20 scale plus the tag pill', () => {
    expect(radius).toEqual({ xs: 4, sm: 6, md: 10, lg: 14, xl: 20, pill: 9999 });
  });

  it('publishes the same scale as CSS custom properties', () => {
    const tokens = sources.find((f) => f.path.endsWith('tokens.css'))?.text ?? '';
    const declared = [...tokens.matchAll(/--radius-([a-z]+):\s*([^;]+);/g)].map(
      ([, name, value]) => [name, (value as string).trim()] as const,
    );
    expect(Object.fromEntries(declared)).toEqual({
      xs: '4px',
      sm: '6px',
      md: '10px',
      lg: '14px',
      xl: '20px',
      pill: '9999px',
    });
  });

  it('sets every border-radius from the scale, or to a true circle', () => {
    const offenders: string[] = [];
    for (const file of css) {
      for (const [, value] of file.text.matchAll(/border-radius:\s*([^;]+);/g)) {
        const v = (value as string).trim();
        const ok = /^var\(--radius-(xs|sm|md|lg|xl|pill)\)$/.test(v) || v === '50%' || v === '0';
        if (!ok) offenders.push(`${file.path}: ${v}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reserves the pill for the Tag component and nothing else', () => {
    // Rules that *use* the pill, not the one `@theme` block that declares it.
    const rules = css.flatMap((file) =>
      [...file.text.matchAll(/([^{}]+)\{[^{}]*var\(--radius-pill\)[^{}]*\}/g)].map(
        ([, selector]) => (selector as string).trim().split('\n').pop()?.trim() ?? '',
      ),
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const selector of rules) {
      expect(selector).toMatch(/rq-tag/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Colour lock                                                                */
/* -------------------------------------------------------------------------- */

const CHROMATIC = 0.02;

/** Hue bands the palette is allowed to occupy. Purple is not among them. */
const ALLOWED_BANDS: Array<[string, number, number]> = [
  ['vermilion accent and red', 20, 50],
  ['amber warning', 55, 90],
  ['green success', 140, 175],
  ['blue info', 235, 265],
];

function bandOf(hue: number): string | null {
  for (const [name, lo, hi] of ALLOWED_BANDS) {
    if (hue >= lo && hue <= hi) return name;
  }
  return null;
}

function solidTokens(theme: ColorTokens): Array<[string, string]> {
  return Object.entries(theme).filter(([, value]) => value.startsWith('#')) as Array<
    [string, string]
  >;
}

describe.each([
  ['dark', darkColors],
  ['light', lightColors],
] as Array<[string, ColorTokens]>)('%s colour lock', (_name, theme) => {
  it('uses no purple anywhere in the palette', () => {
    const purple = solidTokens(theme).filter(([, value]) => {
      const { C, h } = hexToOklch(value);
      return C >= CHROMATIC && h > 265 && h < 350;
    });
    expect(purple).toEqual([]);
  });

  it('keeps every chromatic token inside a declared hue band', () => {
    const strays = solidTokens(theme)
      .map(([name, value]) => [name, value, hexToOklch(value)] as const)
      .filter(([, , lch]) => lch.C >= CHROMATIC && bandOf(lch.h) === null)
      .map(([name, value, lch]) => `${name} ${value} at h=${lch.h.toFixed(1)}`);
    expect(strays).toEqual([]);
  });

  it('carries one accent hue, with no second brand hue', () => {
    const accents = (['accent', 'accentStrong', 'accentHover', 'accentPress'] as const).map(
      (key) => hexToOklch(theme[key]).h,
    );
    const spread = Math.max(...accents) - Math.min(...accents);
    expect(spread).toBeLessThan(8);
    for (const hue of accents) expect(bandOf(hue)).toBe('vermilion accent and red');
  });

  it('keeps every neutral genuinely neutral', () => {
    const neutrals = (
      [
        'canvas',
        'surface1',
        'surface2',
        'surface3',
        'surfaceInset',
        'hairline',
        'hairlineStrong',
        'ink',
        'inkMuted',
        'inkSubtle',
        'inkFaint',
      ] as const
    ).map((key) => [key, hexToOklch(theme[key]).C] as const);
    for (const [key, chroma] of neutrals) {
      expect(chroma, `${key} carries chroma ${chroma.toFixed(3)}`).toBeLessThan(CHROMATIC);
    }
  });

  it('never grounds a page in pure black or pure white', () => {
    expect(theme.canvas.toLowerCase()).not.toBe('#000000');
    expect(theme.canvas.toLowerCase()).not.toBe('#ffffff');
  });
});

describe('the colormaps are the only exemption', () => {
  it('lets the phase map run the full hue circle, because it encodes data', () => {
    const hues = phaseStops.map((stop) => hexToOklch(stop).h);
    // A cyclic map has to visit the purple side; that is the point of it.
    expect(hues.some((h) => h > 265 && h < 350)).toBe(true);
    expect(phaseStops[0]).toBe(phaseStops[phaseStops.length - 1]);
  });

  it('keeps the magnitude ramp inside the accent hue family', () => {
    for (const stop of magnitudeStops) {
      const { C, h } = hexToOklch(stop);
      if (C < CHROMATIC) continue;
      expect(h, `${stop} at h=${h.toFixed(1)}`).toBeGreaterThan(30);
      expect(h).toBeLessThan(55);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Type and space                                                             */
/* -------------------------------------------------------------------------- */

describe('type and space scales match DESIGN.md', () => {
  it('carries every declared type role at the declared size', () => {
    const expected: Record<string, [number, number, number]> = {
      'display-xl': [76, 500, 1.02],
      'display-lg': [52, 500, 1.06],
      'display-md': [38, 500, 1.12],
      headline: [27, 500, 1.2],
      title: [20, 500, 1.28],
      ui: [14, 450, 1.45],
      'ui-sm': [13, 450, 1.4],
      eyebrow: [12, 550, 1.3],
      prose: [19, 400, 1.65],
      'prose-lg': [21, 400, 1.62],
      'prose-lead': [24, 350, 1.5],
      marginalia: [13, 450, 1.5],
      mono: [13.5, 400, 1.6],
      numeric: [13, 450, 1.3],
    };
    for (const [role, [size, weight, lineHeight]] of Object.entries(expected)) {
      const style = typeScale[role as keyof typeof typeScale];
      expect(style, `missing type role ${role}`).toBeDefined();
      expect([role, style.size], role).toEqual([role, size]);
      expect([role, style.weight], role).toEqual([role, weight]);
      expect([role, style.lineHeight], role).toEqual([role, lineHeight]);
    }
  });

  it('sets every comparable number in mono with tabular figures', () => {
    expect(typeScale.numeric.family).toBe('mono');
    expect(typeScale.numeric.tabular).toBe(true);
    expect(typeScale.mono.family).toBe('mono');
  });

  it('carries the 8px spacing scale and nothing else', () => {
    expect(Object.values(space)).toEqual([4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192]);
  });
});

/* -------------------------------------------------------------------------- */
/* Theme structure                                                            */
/* -------------------------------------------------------------------------- */

describe('theme structure', () => {
  const tokens = sources.find((f) => f.path.endsWith('tokens.css'))?.text ?? '';

  it('defines dark under a prefers-color-scheme block and under an explicit toggle', () => {
    expect(tokens).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme='light'\]\)/,
    );
    expect(tokens).toContain(":root[data-theme='dark']");
  });

  it('defines no colour only inside a media query', () => {
    const inMedia = new Set<string>();
    for (const [, body] of tokens.matchAll(/@media[^{]+\{([\s\S]*?)\n\}/g)) {
      for (const [, name] of (body as string).matchAll(/(--rq-[a-z0-9-]+)\s*:/g)) {
        inMedia.add(name as string);
      }
    }
    expect(inMedia.size).toBeGreaterThan(0);

    // Everything a media query touches must already exist on bare :root.
    const bareStart = tokens.indexOf('\n:root {');
    const bare = tokens.slice(bareStart, tokens.indexOf('\n}', bareStart));
    const onRoot = new Set(
      [...bare.matchAll(/(--rq-[a-z0-9-]+)\s*:/g)].map(([, name]) => name as string),
    );
    const mediaOnly = [...inMedia].filter((name) => !onRoot.has(name));
    expect(mediaOnly).toEqual([]);
  });

  it('gives both themes the same set of tokens', () => {
    expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
  });
});
