# Build status

Honest accounting of what is finished, what is partial, and what has not been
verified. Updated as work lands.

## Verified complete

| Component | Evidence |
|---|---|
| Curriculum research, 20 sources | `docs/research/01-curriculum-benchmark.md` |
| Syllabus: 8 tracks, 74 modules, 331 lessons | `docs/research/02-syllabus.md` |
| System design for 50k concurrent | `docs/architecture/system-design.md` |
| Design system specification | `DESIGN.md` |
| Product, content and team plan | `docs/PRODUCT-PLAN.md` |
| `@redquant/qir`: IR, 42 gates, simulator, 4 code generators, OpenQASM 3 parser, canonical hashing, analysis | 78 tests passing, `tsc` clean, builds |
| Web: circuit lab, marketing site, curriculum index, pricing, roadmaps, auth pages, lesson reader, interview bank | `next build` clean, routes verified in a browser |

## In progress

| Component | What is done | What is missing |
|---|---|---|
| `apps/quantum-kernel` | IR, gates, noise, codegen, transpiler, four backends | FastAPI app, grader, sandbox, visual payloads, test suite |
| `apps/api` | Schema, auth, middleware, entitlements, queues, Redis | Most route handlers, migrations, seed, tests |
| `packages/design` | 53 source files including primitives, charts, tokens | Never typechecked or tested against `DESIGN.md` |
| `content/` | 17 lessons, 40 interview questions, 20 employer briefings | 282 lessons, 170 questions, 20 drill decks, 6 contests |
| `infra/` | 147 files: Docker, Kubernetes, k6, CI, runbooks | Nothing validated by running its validator |

## Known corrections made

- The syllabus summary originally claimed 74 modules and 331 lessons, but its
  own per-track lesson lists totalled 64 and 306. The counts were corrected
  downward everywhere rather than padding the lists to match.
- `metrics().clifford` reported Clifford membership from the base gate alone, so
  CCZ and Toffoli were wrongly marked classically simulable. Adding controls does
  not preserve Clifford membership; fixed with a regression test.
- Grover's iteration count used `round` rather than `floor`, which over-rotates
  past the marked state at n=2 and drops success probability to 0.25.
- The circuit validator rejected barriers spanning more than one wire.
- The lesson figure component required `show` as an array, but authors naturally
  write `show="probabilities"`. It now accepts both.
