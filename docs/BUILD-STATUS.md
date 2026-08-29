# Build status

Honest accounting of what is finished, what is partial, and what has not been
verified. Every number below came from running the command, not from estimating.

## Verified complete

| Component | Evidence |
|---|---|
| Curriculum research, 20 sources | `docs/research/01-curriculum-benchmark.md` |
| Syllabus: 8 tracks, 74 modules, 331 lessons | `docs/research/02-syllabus.md` |
| System design for 50k concurrent | `docs/architecture/system-design.md` |
| Design system specification | `DESIGN.md` |
| Product, content and team plan | `docs/PRODUCT-PLAN.md` |
| `@redquant/qir`: IR, 42 gates, browser simulator, 4 code generators, OpenQASM 3 parser, canonical hashing, analysis | **78 tests**, `tsc` clean |
| `@redquant/design`: tokens for both themes, 36 primitives, charts, colormaps | **307 tests**, WCAG floor enforced by 205 of them |
| `@redquant/content`: 331-node catalogue, prerequisite DAG, 7 roadmaps | **54 tests** |
| `apps/quantum-kernel`: FastAPI, 11 endpoints, 5 backends, noise, transpiler, visual payloads, autograder, sandbox | **680 tests**, 4 legitimate skips |
| `apps/web`: circuit lab, marketing site, curriculum, pricing, roadmaps, auth, lesson reader, interview bank, contests | **40 e2e tests**, 194 static pages |
| Accessibility, WCAG 2.1 AA, 11 routes in both themes | 22 axe tests, zero violations |
| Cross-engine agreement, browser vs kernel | 52 amplitudes, worst difference 1.67e-16 |
| Infra: compose, 17 kustomize roots, 8 k6 scripts, 5 workflows, yamllint | every validator run, all pass |
| Content: T0 complete | 26 lessons, all circuits re-simulated, 1,868 KaTeX spans rendered |

Total: **1,159 automated tests** plus 22 accessibility scans.

## In progress

| Component | Done | Missing |
|---|---|---|
| `apps/api` | Schema, auth, middleware, entitlements, queues, Redis | Route handlers, migrations, seed, tests |
| Content: T1 | ~33 of 61 lessons | The rest, plus 20 drill decks |
| Content: T2 to T7 | Catalogue nodes only | 244 lessons |
| Interview bank | 70 of 240 questions, 20 employer briefings | 170 questions |
| Contests | none | 6 contests, 24 problems |

## Bugs found and fixed, with their causes

**Simulation**
- `metrics().clifford` read Clifford membership off the base gate, so CCZ and
  Toffoli were reported classically simulable. Adding controls does not
  preserve Clifford membership.
- Grover's iteration count used `round` where the derivation needs `floor`. At
  n=2 that over-rotates past the marked state and drops success from 1.0 to 0.25.
- The circuit validator rejected barriers spanning more than one wire.
- Qiskit's default `transpile` runs `ElidePermutations`, which deletes SWAP
  gates and records the relabelling in the `TranspileLayout`, so Aer returned a
  permuted statevector. Cross-backend error 0.518, now 4e-16.
- A controlled-U helper wrapped angles to (-pi, pi], but Rz has period 4pi, so
  a wrap across the boundary flipped the operator's sign. Invisible as a global
  phase until the operator is controlled, at which point it is observable.

**Web and design**
- The web app kept a duplicate palette whose light theme failed contrast two
  ways: the accent read 4.15:1 as text and 4.33:1 as a button ground, and a
  disabled-only token was being used for readable text at 2.53:1. DESIGN.md
  claimed 5.9:1, but that figure only ever held for the dark theme.
- A hydration mismatch: the editor store timed its own simulation at module
  scope, so server and client rendered different numbers.
- The lesson figure component required `show` as an array, but authors write
  `show="probabilities"`.

**Content**
- 155 MDX failures across 19 lessons: an inline `$...$` span wrapped across a
  line break. remark-math only tokenises within one line, so the span never
  closes and its braces reach the JavaScript parser.
- Two roadmaps taught a lesson before its prerequisite: resource estimation for
  Shor at scale before Shor, and QML modules that assert on shot budgets before
  the lesson that teaches them.

**Infrastructure**
- `quantum-kernel-heavy` requested 96Gi on a 16GiB node pool with no selector
  or toleration, so it could never be scheduled.

## Corrections to my own earlier claims

- I reduced the syllabus to 64 modules and 306 lessons because its summary
  disagreed with its own per-track lists. That was the wrong direction: the
  catalogue resolved the same disagreement by expanding T5 into 14 real
  modules. 74 and 331 are correct and have been restored.

## Not verified

- Nothing has been deployed. `kustomize build` proves rendering, not
  server-side validation against a live API server.
- k6 scripts are syntax-checked, not executed against a real fleet.
- `docker compose config` validates schema, not that every image builds. Only
  Postgres and Loki were actually run.
- The 50,000 concurrent user figure is a capacity model, not a measurement.
