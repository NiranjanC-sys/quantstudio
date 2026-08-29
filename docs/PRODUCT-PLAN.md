# RedQuant — Product and Engineering Plan

**One line.** The platform where you learn quantum computing by building it: a
331-lesson curriculum benchmarked against 20 institutional syllabi, a circuit
builder that simulates as you type, autograded labs, weekly rated contests, and
an AI tutor that can read your circuit.

**Who.** Three personas, one product, different paths through the same DAG:
undergraduate and graduate students; software engineers and data scientists
moving into quantum; and physicists and researchers who need the software half of
the field.

---

## Feature inventory

### Learn
- 8 tracks, 74 modules, 331 lessons over a prerequisite DAG (not a playlist).
- Six lesson types: concept, interactive, lab, drill, checkpoint, project.
- Typeset theory with KaTeX, marginalia definitions, and per-claim numerical
  verification the reader can re-run.
- Spaced-repetition drills generated per module, with a forgetting-curve schedule.
- Seven persona roadmaps, plus a personalised path from the mastery model.
- Placement test that writes directly into the DAG and can skip up to 34 lessons.

### Build
- Drag-and-drop circuit builder: 38 gates, multi-qubit drag, controls, barriers,
  mid-circuit measure/reset, parameterised gates with live sliders.
- Code editor with four dialects: OpenQASM 3, Qiskit, Cirq, PennyLane.
  Bidirectional: builder → code and code → builder, through one canonical IR.
- Simulate-as-you-type: ≤ 14 qubits runs in the browser at frame rate.
- Multi-backend execution: native statevector, Qiskit Aer, PennyLane
  `default.qubit`/`default.mixed`, Cirq, plus a provider adapter for qBraid-style
  remote devices.
- Noise models: depolarising, amplitude/phase damping, readout error, and
  device-derived models.
- Transpilation view: layout, routing, SWAP insertion, basis translation, before
  and after metrics.

### See
- Procedural Three.js instruments, code-only: Bloch sphere with trace history,
  Q-sphere, entanglement graph, surface-code lattice, dilution-refrigerator
  cutaway for hardware lessons.
- 2D: amplitude/phase bars, probability histogram with error bars, density-matrix
  heatmap, unitary matrix inspector, circuit-depth timeline, state-evolution
  scrubber.

### Practise
- Autograded labs: public tests visible, hidden tests decide, resource bounds
  scored (a correct-but-wasteful circuit scores lower).
- 240-question interview bank, tagged by company (20 employers), with model
  answers and primary-source links.
- Weekly rated contests, four problems, Glicko-2 ratings, editorials, virtual
  participation of past contests.
- Streaks, XP, achievements, global and per-institution leaderboards.

### Teach
- Instructor dashboard: cohorts, assignments, per-concept mastery heatmap,
  submission review, plagiarism signals, gradebook export.
- Org management: seats, SSO, SCIM, private contests, co-branded certificates.

### AI tutor
- Reads the learner's actual circuit IR and simulation output, not just their text.
- Modes: explain, Socratic hint (never leaks the answer, and is hard-disabled
  during rated contests), debug my circuit, critique and optimise, recommend what
  to do next.
- Retrieval-grounded in the curriculum with inline citations; refuses to answer
  outside the curriculum rather than inventing physics.
- Hard per-plan and per-hour cost ceilings with automatic downgrade to
  retrieval-only.

---

## Build phases

Every phase ends with tests passing and the app runnable. No phase is "done"
without verification output.

| Phase | Deliverable | Verification |
|---|---|---|
| **P0** Foundations | Monorepo, tooling, DESIGN.md, syllabus, system design | `pnpm -w typecheck` clean |
| **P1** Quantum IR | `@redquant/qir`: circuit IR, 38 gates, TS statevector engine, 4-dialect codegen and parsers, canonical hashing | Unit tests incl. known-state fixtures for Bell, GHZ, QFT, Grover, teleportation |
| **P2** Kernel | Python FastAPI service: multi-backend adapters, noise, transpile, metrics, visual payloads, autograder harness, sandbox | pytest, cross-backend agreement tests (Aer vs Cirq vs PennyLane vs native, TVD < 1e-9 on statevector) |
| **P3** Data + API | Drizzle schema, migrations, Fastify gateway: auth/SSO, catalog, progress, labs, contests, leaderboard, billing, entitlements, rate limits, tutor | Integration tests against a live Postgres and Redis |
| **P4** Web | Design system, marketing, auth, roadmap, lesson reader, builder, lab, visualisations, contests, dashboards, pricing, interview bank | Build green, Playwright e2e on the critical paths |
| **P5** Content | Authored lessons, interview bank, contest problems, drill decks | Content schema validation, every lab's reference solution passes its own tests |
| **P6** Infra | Docker, compose, k8s + HPA/KEDA, CI, k6 load test, observability, runbooks | k6 run at target RPS with p99 recorded |
| **P7** Harden | Security review, a11y audit, perf budget, fix list | Audit output attached |

---

## Content production plan

Authoring 331 lessons is a content-operations problem, not a coding problem. The
plan separates *catalogue* (all 331 nodes, machine-readable, with objectives,
prerequisites, sources and assessment spec) from *authored prose*.

| Wave | Scope | Who |
|---|---|---|
| W1 | Full catalogue: all 331 nodes with objectives, DAG edges, source citations, lab specs | in this build |
| W2 | T0 + T1 fully authored (92 lessons), all labs with reference solutions and hidden tests | in this build (partial: see BUILD-STATUS.md) |
| W3 | T2, T3 authored | subject-matter authors, 8 weeks |
| W4 | T4, T5, T6, T7 authored | 12 weeks |
| W5 | Localisation, video, accessibility pass | 8 weeks |

Editorial standards: every claim either derives on the page or cites a primary
source; every lesson ships a runnable circuit; every drill answer is falsifiable;
no lesson exceeds 1,400 words without an interactive break.

## Team and cost to run this for real

| Role | Count | Note |
|---|---|---|
| Quantum content leads (PhD) | 3 | one per track cluster |
| Content authors | 5 | contract, per-lesson |
| Frontend engineers | 4 | 1 dedicated to the builder and 3D |
| Backend engineers | 3 | 1 dedicated to contests and grading |
| Quantum software engineer | 2 | kernel, transpiler, provider adapters |
| Platform / SRE | 2 | |
| ML engineer (tutor) | 1 | |
| Designer | 1 | |
| PM, editor, community | 3 | |
| **Total** | **24** | ~$5.4M/yr loaded |

Infrastructure at 50k concurrent: **$41-54k/month** (see system design §12).

## Business model

Free tier is genuinely useful (T0-T1 complete, 40 labs/month, contests) because
the funnel is the curriculum. Pro at $19/mo unlocks the advanced tracks, the
interview bank, unlimited labs, and 28-qubit simulation. Teams at $39/seat adds
instructor tooling. Campus is an annual institutional licence with SAML, SCIM and
co-branded certificates. Revenue also from certification exams and a sponsored
contest series.

Unit economics: a Pro user costs ~$1.10/month in infrastructure and up to
$2.40/month in tutor inference at the plan ceiling, against $19 revenue.
