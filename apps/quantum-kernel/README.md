# quantum-kernel

The RedQuant simulation service: statevector and density-matrix simulation,
noise modelling, transpilation, autograding, sandboxed execution of untrusted
learner Python, and the visual payloads the frontend's 3D instruments draw.

It owns exactly that list. It never does auth, entitlements or billing —
`api-gateway` has done all three before a request arrives (system design §3).

---

## The one thing to know: qubit 0 is the most significant bit

**For `n` qubits, basis index `i` gives qubit `q` the value `(i >> (n - 1 - q)) & 1`.**

Qubit 0 is the leftmost character of a basis label and the *most* significant
bit of an amplitude index. This is the Nielsen & Chuang / Cirq / PennyLane
convention, and it is the one the TypeScript engine in `packages/qir` uses, so
a circuit simulated in the browser and the same circuit simulated here produce
the same array with the same indices.

```
n = 3, index 6 = 0b110  ->  qubit 0 = 1, qubit 1 = 1, qubit 2 = 0  ->  |110>
```

Concretely:

| Object | Ordering |
|---|---|
| `probabilities[i]`, `statevector` | qubit 0 is the most significant bit of `i` |
| `counts` keys with `countsKind: "basis"` | qubit 0 is the **leftmost** character |
| `counts` keys with `countsKind: "clbits"` | clbit 0 is the **rightmost** character |
| Gate matrices in `app/gates.py` | the first operand is the most significant bit |
| `controlled(base, k)` | controls occupy the high bits, so the matrix is block diagonal |

The classical-register exception is deliberate: every SDK prints classical bits
with bit 0 on the right, and fighting that would confuse more people than it
helped.

### Qiskit is the odd one out

Qiskit puts qubit 0 in the **least** significant bit. The entire translation
lives in one line of `app/codegen.to_qiskit`:

```python
w = lambda q: n - 1 - q   # our qubit index -> Qiskit wire index
```

With that single reversal the amplitude arrays line up entry for entry — no
post-hoc reversal of the vector, no relabelling of counts. Going the other way,
`from_qiskit` undoes it, so learner code that writes `qc.h(0)` in the sandbox
comes back as a Hadamard on *our* qubit `n-1`. Both directions are pinned by
`tests/test_cross_backend.py::test_qiskit_wire_reversal_aligns_basis_indices`.

Cirq and PennyLane already agree with us, so their adapters do no index
translation at all.

---

## Layout

```
app/
  ir.py          Circuit IR v1: validation, layering, metrics, canonical form, hashing
  gates.py       the gate matrix registry (the convention is stated and enforced here)
  noise.py       Kraus channels, thermal relaxation, and named device models
  codegen.py     IR <-> OpenQASM 3, Qiskit, Cirq, PennyLane
  transpile.py   decomposition, layout, SABRE routing, basis translation, optimisation
  visual.py      Bloch traces, Q-sphere, density heatmap, timeline, entanglement graph
  grader.py      seven assertion kinds, each with a human-readable diff
  sandbox.py     untrusted Python execution (defence in depth inside gVisor)
  main.py        the FastAPI surface
  backends/
    base.py            the shared SimResult shape, admission control, observables
    native.py          NumPy statevector, always available, up to 30 qubits
    density.py         NumPy density matrix, exact noise, up to 14 qubits
    aer.py             Qiskit Aer: statevector, density matrix, MPS
    cirq_backend.py    Cirq
    pennylane_backend.py  PennyLane default.qubit / default.mixed
tests/           the suite described below
openapi.json     generated at startup; the typed TS <-> Python contract (§3)
```

---

## Circuit IR

```json
{
  "version": 1,
  "name": "bell",
  "qubits": 2,
  "clbits": 2,
  "ops": [
    {"id": "a", "gate": "h", "targets": [0]},
    {"id": "b", "gate": "x", "targets": [1], "controls": [0]},
    {"id": "c", "gate": "measure", "targets": [0], "cbits": [0]}
  ]
}
```

Op fields: `id`, `gate`, `targets[]`, `controls?[]`, `params?[]`, `cbits?[]`,
`condition?{bits[], value}`.

Ops are a flat ordered list. The visual columns are **derived** by ASAP
scheduling, never stored, so an edit cannot leave layer metadata inconsistent
with semantics.

A gate can be written as a controlled alias or as a base gate plus explicit
controls — `{"gate": "cx", "targets": [0, 1]}` and
`{"gate": "x", "targets": [1], "controls": [0]}` are the same op and hash
identically.

**Gates.** `id x y z h s sdg t tdg sx sxdg rx ry rz p u swap iswap rxx ryy rzz
rzx ecr cx cy cz ch cs csdg csx cp crx cry crz cu ccx ccz cswap mcx measure
reset barrier`

**Parameters** may be numbers or `{"symbol": "theta"}`, bound at request time
via `options.bindings`.

**Conditions** are least-significant-first: `{"bits": [2, 5], "value": 2}` means
`clbit[2] == 0 and clbit[5] == 1`.

### Canonical form and hashing

`circuit_hash` hashes a canonical string with barriers dropped, controlled
aliases normalised and commuting ops sorted within their layer. Two circuits
that differ only by the order gates were dragged onto the canvas therefore
collide **on purpose** — thousands of learners run the same lesson circuit, and
that collision is what makes the cache work.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/simulate` | synchronous run (tier T-B, 900 ms budget) |
| `POST` | `/v1/simulate/async` | enqueue a heavy or noisy run (tier T-C) |
| `GET` | `/v1/jobs/{id}` | poll an async job |
| `POST` | `/v1/transpile` | decompose, lay out, route, translate, optimise |
| `POST` | `/v1/grade` | run assertions against a circuit |
| `POST` | `/v1/execute` | run untrusted learner Python |
| `POST` | `/v1/convert` | IR to any dialect, or OpenQASM 3 back to IR |
| `GET` | `/v1/backends` | which engines this pod has, plus devices and plans |
| `GET` | `/healthz` | liveness |
| `GET` | `/readyz` | readiness — actually simulates a Bell pair |
| `GET` | `/metrics` | Prometheus exposition |

```bash
curl -s localhost:8100/v1/simulate -H 'content-type: application/json' -d '{
  "circuit": {"version":1,"qubits":2,"clbits":2,"ops":[
    {"gate":"h","targets":[0]},
    {"gate":"x","targets":[1],"controls":[0]},
    {"gate":"measure","targets":[0],"cbits":[0]}]},
  "options": {"shots": 1024, "seed": 7}
}'
```

`options` accepts `shots`, `seed`, `bindings`, `noise`, `method`, `max_qubits`,
`return_statevector`, `return_probabilities`, `return_bloch`, `reduced_density`,
`expectations` and `max_trajectories`. Set `"include_visual": true` on
`/v1/simulate` to get the instrument payloads in the same response.

Errors are JSON with a stable `error` code, a human `message` and the
`requestId`: `invalid_circuit` (422), `plan_limit` (402), `too_large` (413),
`backend_unavailable` (503), `unknown_job` (404), `request_too_large` (413).

### Backends

| Name | Method(s) | Max qubits | Noise | Mid-circuit measurement |
|---|---|---|---|---|
| `native` | statevector | 30 | yes (trajectories) | yes |
| `density` | density matrix | 14 | yes (exact) | yes |
| `aer` | statevector, density matrix, MPS | 30 | yes | yes |
| `cirq` | statevector | 24 | no | no |
| `pennylane` | default.qubit, default.mixed | 24 / 12 | yes | no |

`native` is the only one with no dependency beyond NumPy, and it is the only one
the service promises. Every other adapter imports its SDK lazily inside a
`try/except`, so a pod built without the heavy wheels still starts, still serves
`native`, and reports `available: false` with the import error attached in
`GET /v1/backends`. `backend: "auto"` (the default) picks `density` for a noisy
request and `native` otherwise; a *named* backend that is absent falls back to
`native` and says so in `warnings`.

### Plan ceilings (§7)

| | free | pro | teams | campus |
|---|---|---|---|---|
| Max qubits | 16 | 28 | 30 | 32 |
| Noisy simulation | — | ≤ 12 q | ≤ 14 q | ≤ 14 q |
| Max shots | 8,192 | 100,000 | 1,000,000 | 1,000,000 |
| Async jobs | no | yes | yes | yes |

The tier arrives in the `X-RedQuant-Plan` header. The gateway has already
authenticated and evaluated entitlements; the kernel is not internet-reachable
and only uses the header to bound the size of the work. An over-limit request is
**refused**, never silently shrunk — silently reducing shots would make the same
circuit grade differently for a free user and a pro user, which is the kind of
bug nobody ever finds.

### Caching

Every simulation is keyed by
`sha256(canonical_ir || backend || method || shots || noise || seed || bindings || …)`
and served from a bounded in-process LRU (`KERNEL_CACHE_CAPACITY`, default 512).
Section 4 puts a Redis LRU behind this one; the in-process tier absorbs the
thundering herd of one lesson's worth of learners hitting the identical circuit
in the same second. `cached: true` in the response says where the answer came
from, and `sim_cache_hit_ratio` tracks it.

### Async jobs

`POST /v1/simulate/async` returns `202` with a `jobId` and a `pollUrl`. Jobs are
**pod-local** and expire after `KERNEL_JOB_TTL_SECONDS` (default 900): an
unknown id is a 404 that says so rather than pretending. The durable queue and
the WebSocket streaming live in `api-gateway`; what the kernel owns is the
execution slot.

---

## Grading

Seven assertion kinds, each returning pass/fail plus a diff a learner can act on:

| Kind | Checks |
|---|---|
| `statevector_equals` | amplitudes, by default up to a global phase |
| `unitary_equals` | the whole `2ⁿ × 2ⁿ` operator |
| `distribution_close` | total variation distance **and** a chi-square p-value |
| `counts_contains` | required and forbidden outcomes, by share of shots |
| `resource_bound` | max depth / 2-qubit gates / qubits / size / T-count |
| `gate_set_subset` | only the gates this lesson has taught |
| `custom_python` | arbitrary check, run in the sandbox |

A failure names the quantity that disagreed:

```
expected amplitude 0.7071 on |01>, got 0.0000; expected amplitude 0.7071 on |10>, got 0.0000
expected at most 1 two-qubit gates, got 3 (2 over budget)
this exercise allows only {h}, but the circuit uses x
```

`distribution_close` requires **both** statistical measures. TVD alone lets a
sloppy circuit pass at low shot counts; a p-value alone fails a *correct*
circuit about once in every `1/alpha` runs. Requiring both is what makes a
seeded rerun reproducible and a marginal submission arguable.

Global phase is unobservable, so amplitude and unitary comparisons ignore it by
default; a lesson specifically about phase kickback sets
`"up_to_global_phase": false` and gets the strict comparison, with a message
that says the state matched *except* for phase.

---

## Sandbox

`app/sandbox.py` executes untrusted learner Python. **It is not the security
boundary.** In production every call runs inside a gVisor (`runsc`) sandbox with
an empty network namespace — an absent interface, not a firewall rule — a
read-only root filesystem, a 64 MiB `tmpfs` scratch, and a seccomp profile cut
to the ~60 syscalls CPython and NumPy need. The pod is recycled after 50
executions.

Everything in the module is **defence in depth inside that boundary**:

- a separate process, started with `spawn` so nothing is inherited;
- `resource` limits applied by the child before it touches learner code — CPU
  2 s (soft, with a hard limit one second later so the `SIGXCPU` handler can
  report cleanly), 512 MiB of address space, 64 processes, 8 MiB `FSIZE`, no
  core dumps;
- an emptied environment, repopulated only with BLAS thread caps;
- a fresh temporary working directory per call;
- an import allowlist — `numpy`, `qiskit`, `cirq`, `pennylane`, `scipy`, `math`,
  `itertools`, `typing` — enforced by a replacement `__import__` that applies
  only to the learner's own module, because NumPy itself imports `os` and an
  unconditional check would break the one import every lab needs;
- stdout capped at 4 MiB with a truncation flag rather than a silent cut;
- a wall-clock kill at 3× the CPU limit, because a sleeping process burns no CPU.

A determined attacker can walk out of a CPython `exec` sandbox through object
introspection. That is exactly why the kernel-level isolation exists and why
this layer is never relied on alone. What it buys is that the common cases —
`import os`, reaching for the network, an infinite loop, a runaway allocation —
become clean, attributable messages instead of a killed pod.

> **Note on `RLIMIT_AS`.** 512 MiB of *address space* is stricter than 512 MiB
> of RSS: it counts every mapping, shared libraries included. NumPy, SciPy and
> Qiskit fit comfortably; Cirq and PennyLane do not, so a lab that needs them
> must raise `SandboxLimits.address_space_bytes` explicitly. Failing loudly at
> the stated limit beats quietly running with none.

---

## Visual payloads

`app/visual.py` computes everything the instruments draw, so the frontend owns
geometry and colour but never quantum linear algebra — otherwise the browser
engine and this kernel would each own half a physics model and would drift.

- **Bloch traces** — one vector per qubit at every moment boundary, so the arrow
  animates along its path instead of teleporting. `purity` is the vector length;
  `mixedness = 1 - purity` is how entangled the qubit is with the rest.
- **Q-sphere** — magnitude and phase per basis state, latitude by Hamming
  weight, longitude spread within a weight. Phase is measured relative to the
  first significant amplitude, so a global-phase twin renders identically.
- **Density heatmap** — `|ρᵢⱼ|` and `arg(ρᵢⱼ)` as separate grids (brightness and
  hue), plus purity, trace and von Neumann entropy.
- **Timeline** — the statevector after each moment, with the op ids that
  produced it and a one-number entanglement summary to plot under the circuit.
- **Entanglement graph** — pairwise Wootters concurrence *and* mutual
  information. Both, because a GHZ state's pairs have zero concurrence but a
  full bit of mutual information, and a learner who sees edges under one measure
  and not the other has learned something true about monogamy of entanglement.

Measurements and resets are **deferred** in these payloads: a learner scrubbing
a circuit sees the superposition they built, not one arbitrary collapsed branch.
The payload says so in `warnings`.

Capped at 16 qubits overall, amplitudes in the timeline up to 12, and heatmaps
at 128 × 128.

---

## Running it

```bash
.venv/bin/python -m uvicorn app.main:app --port 8100        # serve
.venv/bin/python -m pytest -q                                # the suite
.venv/bin/python -c 'from app.main import write_openapi; print(write_openapi())'
```

Config is environment variables, all optional:
`KERNEL_MAX_REQUEST_BYTES` (1 MiB), `KERNEL_CACHE_CAPACITY` (512),
`KERNEL_JOB_WORKERS` (2), `KERNEL_JOB_TTL_SECONDS` (900),
`KERNEL_OPENAPI_PATH`, `KERNEL_WRITE_OPENAPI` (`0` to skip the startup write on
a read-only root filesystem).

Logs are structured JSON on stdout with `request_id` on every line, taken from
`X-Request-Id` or generated. No PII, which is easy here — the kernel never sees
a user, only circuits.

---

## Tests

```bash
.venv/bin/python -m pytest -q                 # everything
.venv/bin/python -m pytest -q -m 'not slow'   # skip the CPU-limit tests
```

| File | Covers |
|---|---|
| `test_gates.py` | every gate is unitary, has the declared size, and inverts; the convention asserted directly on CNOT |
| `test_ir.py` | validation, ASAP layering, metrics, canonical form, hash collisions and non-collisions |
| `test_algorithms.py` | Bell/GHZ/W exact amplitudes, QFT = DFT, Grover, teleportation, Deutsch–Jozsa, Bernstein–Vazirani, Simon |
| `test_cross_backend.py` | all five engines agree to < 1e-9; unavailable SDKs skip |
| `test_transpile.py` | semantic equivalence up to global phase for every pass and basis, including through routing |
| `test_codegen.py` | QASM3 round-trips every gate; generated Qiskit/Cirq/PennyLane source runs and agrees |
| `test_noise.py` | channels are trace-preserving; T1/T2 decay at exactly the right rates; devices are physical |
| `test_visual.py` | Bloch, Q-sphere, heatmap, timeline, concurrence and mutual information |
| `test_grader.py` | every assertion kind, and the wording of each failure message |
| `test_sandbox.py` | `import os` denied, network denied, CPU limit kills, memory refused, stdout capped |
| `test_api.py` | every endpoint, plan caps, caching, request limits, the OpenAPI contract |

Tests marked `slow` are the ones that must actually burn a second of CPU to
prove the limit bites.

A few assertions are load-bearing regression guards worth naming:

- `test_qft_equals_the_dft_matrix` — the strongest statement of the endian
  convention in the suite. The textbook circuit equals `F` *exactly* only when
  qubit 0 is the most significant bit.
- `test_swap_is_not_elided_by_the_qiskit_transpiler` — Qiskit's preset pass
  managers run `ElidePermutations` from optimisation level 1, which deletes SWAP
  gates and records the relabelling in the `TranspileLayout` instead, so the
  saved statevector comes back permuted. `app/backends/aer.py` pins
  `optimization_level=0` because of this.
- `test_bernstein_vazirani_is_not_symmetric_under_reversal` — pins a secret
  whose bit-reversal differs, so a silent endian flip cannot pass.
