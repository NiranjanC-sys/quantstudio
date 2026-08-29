---
version: 1.0
name: RedQuant-design-system
description: "A dual-register system for a quantum computing school. Register one, THE INSTRUMENT, is a near-black laboratory surface (#08090B) with hairline rules, monospaced numerics, and a single vermilion accent (#FF4A1C) reserved for state and action; it governs the circuit builder, labs, contests and dashboards. Register two, THE MONOGRAPH, is a typeset physics text set in Newsreader at a generous measure on warm paper (#FBFAF8) or deep ink, with definitions in the margin and real mathematical typography; it governs lessons and theory. The two registers never blend inside one viewport. Colour appears in exactly three roles: the vermilion accent for action, semantic status, and a cyclic colormap that encodes quantum phase as data. Everything else is neutral. Interactive 3D is procedural code, never downloaded art."
---

## Locks (non-negotiable)

1. **Colour lock.** One chromatic accent page-wide: vermilion `#FF4A1C`. It marks
   action and live state, nothing decorative. The phase colormap is exempt because
   it encodes data, not brand. No second brand hue appears anywhere.
2. **Shape lock.** Soft radii only: `4 / 6 / 10 / 14 / 20`. Pills exist for tags
   and nothing else. No mixed sharp/soft within a surface.
3. **Theme lock.** Dark is the default. Both themes are complete. Off-black and
   off-white only, never `#000` or `#fff` as a page ground.
4. **Register lock.** A viewport is either Instrument or Monograph. A lesson page
   that embeds a lab renders the lab as an inset Instrument panel with its own
   ground, visibly framed, never bleeding into the prose column.
5. **Numeric lock.** Every number a learner might compare against another number
   is set in IBM Plex Mono with tabular figures. Amplitudes, probabilities, gate
   counts, depths, ratings, timers.

## Colour

```
--canvas            #08090B   page ground, dark
--surface-1         #0E1013   cards, panels
--surface-2         #14171B   raised, inputs
--surface-3         #1A1E23   hover, active track
--surface-inset     #0A0B0D   wells, code blocks, circuit grid
--hairline          #22262C   default border
--hairline-strong   #2F343B   emphasis border, focus ring base
--ink               #F4F5F7   primary text
--ink-muted         #B4BAC3   secondary text
--ink-subtle        #7C848F   tertiary, captions
--ink-faint         #525963   disabled, grid labels
--accent            #FF4A1C   action, live state
--accent-hover      #FF6740
--accent-press      #E23A10
--accent-wash       rgba(255,74,28,0.10)
--on-accent         #0A0A0A
--success           #2FA36B
--warning           #D99420
--danger            #E2453B
--info              #3D8BD4
```

Light theme (Monograph default when the reader chooses light):

```
--canvas            #FBFAF8   warm paper
--surface-1         #FFFFFF
--surface-2         #F4F2EE
--surface-3         #EAE7E1
--surface-inset     #F7F5F1
--hairline          #E2DED7
--hairline-strong   #CFC9C0
--ink               #131518
--ink-muted         #4A4F57
--ink-subtle        #6E747D
--ink-faint         #9AA0A8
--accent            #E23A10   (darkened for AA on paper)
--on-accent         #FFFFFF
```

**Phase colormap** (cyclic, for arg(amplitude) ∈ [0, 2π); data only):
`#5B8FF0 → #3FBFA8 → #9BD146 → #F2C230 → #F2703A → #D6539E → #7B5BD6 → #5B8FF0`

**Magnitude ramp** (sequential, for |amplitude|²):
`#12161B → #3A2016 → #6B2E14 → #A63B12 → #E2500F → #FF7A45 → #FFB894`

Contrast floor: 4.5:1 for body, 3:1 for large text and non-text indicators, in
both themes. The accent on `--canvas` measures 5.9:1; the accent as a *background*
always carries `--on-accent`, never `--ink`.

## Typography

| Role | Family | Size | Weight | Line height | Tracking |
|---|---|---|---|---|---|
| display-xl | Instrument Sans | 76px | 500 | 1.02 | -0.035em |
| display-lg | Instrument Sans | 52px | 500 | 1.06 | -0.028em |
| display-md | Instrument Sans | 38px | 500 | 1.12 | -0.022em |
| headline | Instrument Sans | 27px | 500 | 1.20 | -0.016em |
| title | Instrument Sans | 20px | 500 | 1.28 | -0.011em |
| ui | Instrument Sans | 14px | 450 | 1.45 | -0.003em |
| ui-sm | Instrument Sans | 13px | 450 | 1.40 | 0 |
| eyebrow | Instrument Sans | 12px | 550 | 1.30 | 0.07em, uppercase |
| prose | Newsreader | 19px | 400 | 1.65 | 0 |
| prose-lg | Newsreader | 21px | 400 | 1.62 | -0.005em |
| prose-lead | Newsreader | 24px | 350 | 1.50 | -0.008em |
| marginalia | Instrument Sans | 13px | 450 | 1.50 | 0 |
| mono | IBM Plex Mono | 13.5px | 400 | 1.60 | 0 |
| numeric | IBM Plex Mono | 13px | 450 | 1.30 | 0, tnum |

Prose measure: **62-72 characters**. Marginalia sits in a 200px right rail on
viewports ≥ 1180px and collapses inline below that, as a bordered aside.

Mathematics is set with KaTeX, `\displaystyle` for block, and inherits
`--ink`. Inline math never breaks the prose baseline grid.

## Space and layout

8px base. Scale: `4 8 12 16 24 32 48 64 96 128 192`.

- Instrument pages: 12-column fluid grid, 16px gutters, panels flush to
  hairlines, no outer page padding beyond 24px. Density over air.
- Monograph pages: single 680px prose column, left-aligned in a 1180px frame,
  marginalia rail right. Section breaks are 96px of space plus a hairline that
  spans only the prose column.
- Never centre a body paragraph. Never centre a heading over a left-aligned body.

## Motion

- Durations: 120ms (state), 200ms (enter/exit), 320ms (layout), 600ms (3D camera).
- Easing: `cubic-bezier(0.2, 0, 0, 1)` for enters, `cubic-bezier(0.4, 0, 1, 1)`
  for exits, spring `stiffness 260 / damping 30` for anything a pointer drags.
- Scroll-linked motion uses `IntersectionObserver` or CSS scroll-driven
  animations. **`window.addEventListener('scroll')` is banned.**
- Motion must convey state: a gate landing on a wire, an amplitude changing, a
  rank moving. Nothing animates as ornament.
- `prefers-reduced-motion` removes all transforms and keeps opacity only. The
  3D instruments switch to a static orthographic render.

## Components

**Panel** — `--surface-1`, 1px `--hairline`, radius 10, no shadow in dark. Header
row 40px with an eyebrow label left and controls right, separated by a hairline.

**Button** — height 36 (32 sm, 44 lg), radius 6, `--accent` bg / `--on-accent` fg
for primary; `--surface-2` bg / `--ink` fg + hairline for secondary; bare text +
underline-on-hover for tertiary. Focus: 2px `--accent` ring at 2px offset.

**Circuit canvas** — `--surface-inset`, wire rules 1px `--hairline-strong` at
48px pitch, moment columns 56px, gate tiles radius 6 with a 1px hairline; the
tile fill is `--surface-2` and the *glyph* carries meaning. Control dots are 7px,
`--ink`. The selected moment column gets an `--accent-wash` backdrop. Drop
targets show a 2px dashed `--accent` outline.

**Bloch instrument** — procedural Three.js. Wireframe sphere at 24 meridians /
12 parallels in `--hairline-strong`, axes in `--ink-faint` with mono labels, state
vector as an `--accent` arrow with a 0.06 radius shaft, trace history as a fading
polyline. Ground grid off. Perspective camera, fov 38, orbit damped.

**Amplitude bars** — one row per basis state, magnitude as bar length from the
magnitude ramp, phase as a small 10px disc filled from the phase colormap with a
1px hairline and a radial tick showing the angle. Label in mono, tabular.

**Marginalia** — 13px Instrument Sans, `--ink-subtle`, 2px left rule in
`--accent-wash`, used for definitions, notation reminders, and source citations.

**Verdict strip** (lab result) — full-width 44px bar, `--success` / `--danger`
left rule at 3px, monospace test name, right-aligned timing in `--ink-subtle`.

## Bans

Enforced on every screen.

- No em-dash or en-dash in any product copy. Hyphen, or rewrite.
- No purple, no mesh-blob gradients, no glassmorphism.
- No three-equal-card feature rows. Use asymmetric two-column or a scroll-pinned
  sequence.
- No `border-t` *and* `border-b` on every row of a long table. One rule between rows.
- No section-numbering eyebrows (`01 / OVERVIEW`). Name the thing.
- No "Scroll to explore", no bouncing chevrons.
- No fake product UI built from styled divs. Every screenshot-like element on the
  marketing page is the **real component**, running.
- No locale/time strips, no build-version footers, no decorative status dots.
- No hand-drawn decorative SVG illustration. Diagrams are either real data or
  procedural 3D.
- No stock photography of people at laptops.

## Hero discipline

Above the fold, at 1440×900: nav ≤ 64px on one line; headline ≤ 2 lines; subtext
≤ 20 words; primary CTA visible; and one live instrument (a real 2-qubit circuit
with a real Bloch sphere responding to real gates). Nothing below the fold is
required to understand what the product is.
