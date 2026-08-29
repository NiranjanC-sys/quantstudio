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
| `@redquant/qir`: IR, 42 gates, browser simulator, 4 code generators, OpenQASM 3 parser, canonical hashing, analysis | **118 tests**, `tsc` clean |
| `@redquant/design`: tokens for both themes, 36 primitives, charts, colormaps | **307 tests**, WCAG floor enforced by 205 of them |
| `@redquant/content`: 331-node catalogue, prerequisite DAG, 7 roadmaps | **54 tests** |
| `apps/quantum-kernel`: FastAPI, 11 endpoints, 5 backends, noise, transpiler, visual payloads, autograder, sandbox | **701 tests**, 4 legitimate skips |
| `apps/api`: Fastify gateway, auth, catalog, progress, labs, contests, leaderboard, billing, simulate proxy, rate limiting, credit debit, CSRF | **185 tests** |
| `apps/web`: circuit lab, marketing, curriculum, pricing, roadmaps, auth, lesson reader, interview bank, contests, dashboard, leaderboard, tutor, instructor, billing | **42 e2e tests**, 431+ prerendered pages |
| Accessibility, WCAG 2.1 AA, 11 routes in both themes | 22 axe tests, zero violations |
| Cross-engine agreement, browser vs kernel | 52 amplitudes, worst difference 1.67e-16 |
| Infra: compose, 17 kustomize roots, 8 k6 scripts, 5 workflows, yamllint | every validator run, all pass |
| Content: T0 26/31, T1 61/61, T2 34/48, T3 41/41 | 163 lessons authored, all circuits re-simulated |
| Interview bank: 240 questions, 20 employer briefings, 20 drill decks | faceted search verified in browser |
| Contests: 6 weekly, 24 problems, 24 editorials, 24 reference solutions | every solution verified by execution |

Total: **1,407 automated tests** plus 22 accessibility scans across 17 verified routes.

## Feature surfaces (all browser-verified)

| Route | Feature | Auth required |
|---|---|---|
| `/` | Marketing landing page with live quantum engine hero | no |
| `/lab` | Circuit builder: drag-drop, 42 gates, browser simulation, Bloch sphere, 4 code dialects | no |
| `/curriculum` | 8 tracks, 74 modules, progress counters | no |
| `/learn/[...slug]` | Lesson reader: KaTeX math, live circuit figures, self-tests | no |
| `/interview` | 240 questions, faceted filter by company/difficulty/kind | no |
| `/interview/[id]` | Question detail with follow-ups and common mistakes | no |
| `/interview/companies` | 20 employer briefings | no |
| `/contests` | 6 weekly contests, Glicko-2 rating explanation | no |
| `/contests/[id]` | Contest detail: problems, points, difficulty badges | no |
| `/pricing` | Free / Pro / Team / Enterprise tiers | no |
| `/roadmaps` | 7 persona-based learning paths | no |
| `/login` | SSO: Google, GitHub, Microsoft, ORCID + email/password | no |
| `/signup` | Account creation | no |
| `/dashboard` | XP, streak, mastery, review queue, next-lesson DAG | yes |
| `/leaderboard` | XP and contest rating boards with seeded data | no |
| `/tutor` | AI tutor: sends circuit IR + amplitudes, grounded in curriculum | yes |
| `/instructor` | Cohort management, gradebook, mastery heatmap | yes |
| `/billing` | Stripe integration, subscription, credits panel | yes |

## Content authored

| Track | Title | Authored | Total |
|---|---|---|---|
| T0 | Mathematical and Computational Foundations | 26 | 31 |
| T1 | Quantum Computing Core | 61 | 61 |
| T2 | Quantum Algorithms and Complexity | 34 | 48 |
| T3 | Quantum Software Engineering | 41 | 41 |
| T4 | Noise, Error Correction and Fault Tolerance | 1 | 42 |
| T5 | Applications | 0 | 63 |
| T6 | Hardware and Systems | 0 | 30 |
| T7 | Career and Research | 0 | 15 |
| **Total** | | **163** | **331** |

168 remaining lessons are catalogued in `REMAINING-TASKS.md` with ids, types,
paths, and authoring conventions.

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
- 12.6 MB probability payload for 20 qubits. Added `probability_top_k` with
  O(n) argpartition: 12.6 MB down to 1.7 KB (7,200x reduction).

**Web and design**
- The web app kept a duplicate palette whose light theme failed contrast two
  ways: the accent read 4.15:1 as text and 4.33:1 as a button ground, and a
  disabled-only token was being used for readable text at 2.53:1.
- A hydration mismatch: the editor store timed its own simulation at module
  scope, so server and client rendered different numbers.
- The lesson figure component required `show` as an array, but authors write
  `show="probabilities"`.
- CSP missing `blob:` in `script-src` broke WebGL workers and hydration.
  drei's troika fetched a font inside a web worker, blocked by CSP. Replaced
  WebGL axis text with DOM kets in the Bloch sphere.
- `var()` substitution happens where declared, not where inherited. Token
  aliases must be redeclared inside `[data-register='instrument']`.
- Client assumed gateway served `/v1/` paths; gateway is unversioned.
- CORS missing `http://localhost:3210` in gateway origins.

**Content**
- 155 MDX failures across 19 lessons: an inline `$...$` span wrapped across a
  line break. remark-math only tokenises within one line.
- Two roadmaps taught a lesson before its prerequisite: resource estimation for
  Shor at scale before Shor, and QML modules that assert on shot budgets before
  the lesson that teaches them.
- Four independent syllabus transcriptions produced 306, 331, 353, and 289
  lessons. Unified onto one catalogue derived from `@redquant/content`.

**Infrastructure**
- `quantum-kernel-heavy` requested 96Gi on a 16GiB node pool with no selector
  or toleration, so it could never be scheduled.
- Stale mock server left on port 8200 by a killed agent caused test failures.

## Load test results (local, single machine)

k6 load tests executed against localhost (gateway on 3001, kernel on 8100).
Not a fleet measurement, but proves the scripts run, the endpoints respond
correctly, and the latency profile matches the system design claims.

**Simulation capacity sweep** (kernel direct, cold cache, 8-22 qubits):

| Qubits | Latency | Status |
|---|---|---|
| 8 | 9 ms | 200 |
| 10 | 9 ms | 200 |
| 12 | 17 ms | 200 |
| 14 | 57 ms | 200 |
| 16 | 286 ms | 200 |
| 18 | 888 ms | 200 |
| 20 | 1.66 s | 200 |
| 22 | 5.44 s | 200 |

**Throughput test** (14 qubits, 5 req/s, 30s, cold cache):
151 requests, 100% success, p99 = 65 ms.

**Mixed cohort test** (reading + editing + dashboards, 30s):
243 requests, 0% error rate, all thresholds passed.
- `lat_read_lesson` p99: 70 ms (threshold: <300 ms)
- `lat_simulate` p95: 333 ms (threshold: <900 ms)
- `lat_dashboard` p99: 60 ms (threshold: <300 ms)
- `sim_cache_hit_rate`: 83%

## Not verified

- Nothing has been deployed. `kustomize build` proves rendering, not
  server-side validation against a live API server.
- `docker compose config` validates schema, not that every image builds. Only
  Postgres and Loki were actually run.
- The 50,000 concurrent user figure is a capacity model, not a measurement.
  The load test above ran against one machine, not a fleet.
