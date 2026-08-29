# RedQuant

**Learn quantum computing by building it.** A 306 lesson curriculum benchmarked
against 20 university syllabi, a circuit builder that simulates as you type,
autograded labs, and weekly rated contests.

---

## What is here

| Path | What it is | State |
|---|---|---|
| `docs/research/01-curriculum-benchmark.md` | 20 primary sources (Caltech, MIT, Berkeley, Stanford, CMU, Oxford, Waterloo, Delft, IBM, Google, Microsoft, Xanadu, QWorld) and the five teaching gaps they share | complete |
| `docs/research/02-syllabus.md` | The curriculum: 8 tracks, 64 modules, 306 lessons over a prerequisite DAG, plus 7 persona roadmaps and the assessment and mastery model | complete |
| `docs/architecture/system-design.md` | Capacity model, topology, data model, contest correctness, plans and entitlements, identity, degradation ladder, sandbox, observability, cost, all sized for 50,000 concurrent users | complete |
| `docs/PRODUCT-PLAN.md` | Feature inventory, build phases, content production plan, team and cost | complete |
| `DESIGN.md` | The design system specification: five locks, tokens for both themes, type scale, motion, component specs, anti-slop ban list | complete |
| `packages/qir` | The circuit IR and browser simulation engine | complete, 78 tests |
| `apps/web` | Next.js 15 application | core flows working |
| `packages/design` | React design system implementing DESIGN.md | in progress |
| `apps/quantum-kernel` | Python FastAPI multi-backend simulation service | in progress |
| `apps/api` | Fastify gateway, Postgres, Redis, contests, billing | in progress |
| `content/` | Authored lessons, drills, interview bank, contests | in progress |
| `infra/` | Docker, Kubernetes, k6 load tests, observability | written, validation in progress |

Run `pnpm -w test` for the test suites that are green today, and see
`docs/BUILD-STATUS.md` for exactly what is finished and what is not.

---

## The convention that matters most

**Qubit 0 is the most significant bit.** For `n` qubits, basis index `i` gives
qubit `q` the value `(i >> (n - 1 - q)) & 1`, so a two-qubit state `|q0 q1>`
reads left to right. This matches Nielsen and Chuang, Cirq, and every lecture
course in the benchmark.

Qiskit uses the opposite order. The Qiskit code generator and the OpenQASM
parser convert at that boundary, and the discrepancy is itself a lesson
(`T0.M5.L3`), because it is the single most common source of wrong answers when
people move between SDKs.

---

## Quick start

```bash
pnpm install

# The web app, including the circuit lab
pnpm --filter @redquant/web dev        # http://localhost:3000

# The simulation engine's test suite
pnpm --filter @redquant/qir test

# The Python simulation service
cd apps/quantum-kernel && .venv/bin/uvicorn app.main:app --port 8100

# Everything, locally
docker compose -f infra/docker/docker-compose.yml up
```

---

## Architecture in one paragraph

The browser runs a full statevector simulator (`packages/qir`) for circuits up
to 14 qubits, so editing a circuit re-simulates at frame rate with no network
round trip. That covers roughly 92% of simulation traffic and is a business
decision as much as a latency one: client simulations cost nothing to serve.
Larger circuits go to a Python service that fronts Qiskit Aer, Cirq, PennyLane
and a native NumPy engine behind one interface, with results cached by a
canonical hash of the circuit so the thousands of learners running the same
lesson circuit hit one cache entry. A Fastify gateway owns identity, entitlements
and the contest path, where scoring is a single Redis Lua script that makes
at-least-once delivery safe and the leaderboard monotone. Full detail in
[docs/architecture/system-design.md](docs/architecture/system-design.md).

---

## The two registers

The interface is deliberately two things. **The Instrument** (the lab, the
builder, contests, dashboards) is a near-black laboratory surface with hairline
rules, monospaced numerics and a single vermilion accent reserved for action and
live state. **The Monograph** (lessons and theory) is a typeset physics text set
in Newsreader at a generous measure, with definitions in the margin. The two
never blend inside one viewport: a lesson that embeds a lab renders it as a
framed inset with its own ground. See [DESIGN.md](DESIGN.md).

---

## Licence

Not yet determined.
