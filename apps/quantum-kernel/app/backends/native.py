"""The native NumPy statevector engine -- tier T-B of the simulation design.

This is the only backend with no third-party dependency beyond NumPy, and it is
the one the service promises to always have. It handles mid-circuit
measurement, reset, classical conditions and noise (by quantum-trajectory
unravelling), and it refuses oversized requests *before* allocating.

Two kernels for applying a gate, both exercised by
``tests/test_native.py::test_apply_matrix_paths_agree``:

* **transpose kernel** -- ``psi.reshape([2]*n)``, move the operand axes to the
  front, one BLAS matmul, move them back. Fastest by a wide margin, but it
  allocates a second copy of the state, so it is used only while
  ``2 * 2**n * 16`` bytes is comfortable (n <= 24 by default, 512 MiB).
* **gather kernel** -- enumerate only the base indices (operand bits zero,
  controls satisfied) in chunks and gather a ``2**k`` block for each. Peak
  extra memory is a few MiB regardless of n, which is what makes a 30-qubit
  16 GiB run possible at all.

Qubit 0 is the most significant bit, so the axis of ``reshape([2]*n)``
corresponding to qubit ``q`` is simply axis ``q``.
"""

from __future__ import annotations

import math
from typing import Iterable, Sequence

import numpy as np

from app.backends.base import (
    AdmissionError,
    BackendInfo,
    BlochVector,
    SimOptions,
    SimResult,
    admit_statevector,
    apply_readout_error,
    basis_label,
    bloch_vectors_from_state,
    clbit_label,
    counts_to_clbits,
    finalise_observables,
    make_rng,
    pauli_expectation_state,
    probabilities_from_state,
    reduced_density_from_state,
    sample_counts,
    statevector_bytes,
    timed,
)
from app.gates import GATES, Matrix, base_form, gate
from app.ir import Circuit, Op, resolve_params, validate_or_raise
from app.noise import KrausSet, NoiseModel

#: Above this qubit count the transpose kernel's second copy of the state is
#: no longer free, so we fall back to the chunked gather kernel.
TRANSPOSE_MAX_QUBITS = 24

#: Base indices processed per gather chunk. 2**16 keeps the temporary index
#: array in L2 for small operand counts while amortising Python overhead.
GATHER_CHUNK = 1 << 16

#: Hard ceiling for this engine regardless of plan: 2**30 * 16 B == 16 GiB.
MAX_QUBITS = 30


# --------------------------------------------------------------------------
# The gate-application kernels
# --------------------------------------------------------------------------


def _spread_table(positions: Sequence[int]) -> np.ndarray:
    """Table mapping a compact counter to indices with bits at ``positions``.

    ``tab[j]`` has bit ``positions[i]`` set exactly when bit ``i`` of ``j`` is
    set. Built by successive doubling, which is O(2**len(positions)) once
    instead of O(len) shifts per chunk in the hot loop.
    """
    tab = np.zeros(1, dtype=np.int64)
    for p in positions:
        tab = np.concatenate([tab, tab | np.int64(1 << p)])
    return tab


def _apply_gather(
    state: np.ndarray,
    n: int,
    targets: Sequence[int],
    controls: Sequence[int],
    matrix: Matrix,
    chunk: int = GATHER_CHUNK,
) -> None:
    k = len(targets)
    dim = 1 << k
    tpos = [n - 1 - t for t in targets]
    tmask = 0
    for p in tpos:
        tmask |= 1 << p
    cmask = 0
    for c in controls:
        cmask |= 1 << (n - 1 - c)

    offs = np.zeros(dim, dtype=np.int64)
    for j in range(dim):
        o = 0
        for i, p in enumerate(tpos):
            if (j >> (k - 1 - i)) & 1:
                o |= 1 << p
        offs[j] = o

    free_pos = [p for p in range(n) if not (tmask >> p) & 1 and not (cmask >> p) & 1]
    nfree = len(free_pos)
    total = 1 << nfree
    half = nfree // 2
    low = _spread_table(free_pos[:half])
    high = _spread_table(free_pos[half:])
    low_mask = (1 << half) - 1

    two_d = state.ndim == 2
    for start in range(0, total, chunk):
        stop = min(start + chunk, total)
        idx = np.arange(start, stop, dtype=np.int64)
        base = low[idx & low_mask] + high[idx >> half] + np.int64(cmask)
        rows = base[:, None] + offs[None, :]
        block = state[rows]
        if two_d:
            state[rows] = np.einsum("rj,cjm->crm", matrix, block, optimize=True)
        else:
            state[rows] = block @ matrix.T


def _apply_transpose(
    state: np.ndarray,
    n: int,
    targets: Sequence[int],
    controls: Sequence[int],
    matrix: Matrix,
) -> None:
    k = len(targets)
    c = len(controls)
    lead = list(controls) + list(targets)
    rest = [q for q in range(n) if q not in lead]
    perm = lead + rest
    t = state.reshape([2] * n).transpose(perm)
    block = np.ascontiguousarray(t).reshape(1 << c, 1 << k, -1)
    if c:
        # Only the all-controls-set block is touched; the rest is the identity.
        block[-1] = matrix @ block[-1]
    else:
        block[0] = matrix @ block[0]
    back = np.empty(n, dtype=np.int64)
    for i, q in enumerate(perm):
        back[q] = i
    state[:] = block.reshape([2] * n).transpose(back).reshape(-1)


def apply_matrix(
    state: np.ndarray,
    n: int,
    targets: Sequence[int],
    controls: Sequence[int] = (),
    matrix: Matrix | None = None,
) -> None:
    """Apply ``matrix`` over ``targets``, gated on every qubit in ``controls`` being |1>.

    ``state`` is modified in place. It may be a statevector of shape
    ``(2**n,)`` or a batch of shape ``(2**n, m)`` -- the density-matrix engine
    uses the latter to hit both sides of ``U rho U^dagger`` with one kernel.

    ``targets`` are in operand order and the FIRST target is the most
    significant bit of the matrix's index, matching ``app/gates.py``.
    """
    if matrix is None:
        raise ValueError("apply_matrix needs a matrix")
    k = len(targets)
    if matrix.shape != (1 << k, 1 << k):
        raise ValueError(
            f"matrix of size {matrix.shape[0]} cannot act on {k} qubit(s)"
        )
    if k == 0:
        return
    seen = set(targets) | set(controls)
    if len(seen) != k + len(controls):
        raise ValueError("apply_matrix: targets and controls must be disjoint")
    for q in seen:
        if not 0 <= q < n:
            raise ValueError(f"qubit {q} out of range for {n} qubits")
    if state.ndim == 1 and n <= TRANSPOSE_MAX_QUBITS:
        _apply_transpose(state, n, targets, controls, matrix)
    else:
        _apply_gather(state, n, targets, controls, matrix)


# --------------------------------------------------------------------------
# Measurement primitives
# --------------------------------------------------------------------------


def zero_state(n: int) -> np.ndarray:
    """|0...0> as a fresh complex128 vector."""
    psi = np.zeros(1 << n, dtype=np.complex128)
    psi[0] = 1.0
    return psi


def probability_of_one(state: np.ndarray, n: int, q: int) -> float:
    """P(measuring qubit ``q`` in the computational basis yields 1)."""
    before = 1 << q
    after = 1 << (n - 1 - q)
    t = state.reshape(before, 2, after)
    return float(np.sum(np.abs(t[:, 1, :]) ** 2))


def collapse(state: np.ndarray, n: int, q: int, outcome: int) -> None:
    """Project qubit ``q`` onto ``outcome`` and renormalise, in place."""
    before = 1 << q
    after = 1 << (n - 1 - q)
    t = state.reshape(before, 2, after)
    t[:, 1 - outcome, :] = 0.0
    norm = float(np.linalg.norm(state))
    if norm > 0:
        state /= norm


def _sample_outcome(p1: float, rng: np.random.Generator) -> int:
    return 1 if rng.random() < p1 else 0


def apply_kraus_trajectory(
    state: np.ndarray,
    n: int,
    qubits: Sequence[int],
    kraus: KrausSet,
    rng: np.random.Generator,
) -> None:
    """Sample which Kraus branch fired, then project and renormalise.

    Exact in the many-trajectory limit and, crucially, O(2**n) rather than
    O(4**n): the branch probabilities ``Tr(K rho_S K^dagger)`` only need the
    reduced state of the one or two qubits the channel touches, which is a
    2x2 or 4x4 object no matter how big the register is.
    """
    if len(kraus) <= 1:
        return
    rho = reduced_density_from_state(state, n, qubits)
    probs = np.array(
        [float(np.real(np.trace(k @ rho @ k.conj().T))) for k in kraus], dtype=np.float64
    )
    total = probs.sum()
    if total <= 0:
        return
    probs /= total
    choice = int(rng.choice(len(kraus), p=probs))
    apply_matrix(state, n, list(qubits), (), kraus[choice])
    norm = float(np.linalg.norm(state))
    if norm > 0:
        state /= norm


# --------------------------------------------------------------------------
# Circuit execution
# --------------------------------------------------------------------------


def op_target_matrix(op: Op, bindings: dict[str, float] | None) -> tuple[Matrix, list[int], list[int]]:
    """Resolve an op into ``(base matrix, targets, controls)``.

    Controlled aliases are rewritten to base gate plus controls so there is one
    code path for cx, ccx and mcx alike, and so that the applied matrix stays
    small (a 6-control mcx applies a 2x2, never a 128x128).
    """
    base_key, targets, controls = base_form(op.gate, op.targets, op.controls)
    d = gate(base_key)
    if d.matrix is None:
        raise ValueError(f"gate {op.gate!r} has no matrix")
    params = resolve_params(op.params, bindings)
    return d.matrix(params), targets, controls


def is_terminal_measurement_only(ops: Sequence[Op]) -> bool:
    """True when the circuit is unitary evolution followed by measurements.

    Such a circuit has an exact statevector, so we can evolve once and sample
    the distribution instead of simulating collapse per shot -- the difference
    between one 2**n pass and ``shots`` of them.
    """
    seen_measure = False
    for op in ops:
        if op.condition is not None:
            return False
        if op.gate == "reset":
            return False
        if op.gate == "measure":
            seen_measure = True
        elif op.gate == "barrier":
            continue
        elif seen_measure:
            return False
    return True


def condition_holds(op: Op, clbits: list[int]) -> bool:
    if op.condition is None:
        return True
    value = 0
    for i, b in enumerate(op.condition.bits):
        bit = clbits[b] if 0 <= b < len(clbits) else 0
        value |= bit << i
    return value == op.condition.value


def run_once(
    circuit: Circuit,
    bindings: dict[str, float] | None,
    rng: np.random.Generator,
    noise: NoiseModel | None = None,
    initial: np.ndarray | None = None,
    defer_measurements: bool = False,
) -> tuple[np.ndarray, list[int]]:
    """One trajectory: evolve the state, resolving measurements as they occur.

    ``defer_measurements`` skips ``measure`` ops entirely. It is only ever set
    for circuits that :func:`is_terminal_measurement_only` accepts, where the
    principle of deferred measurement guarantees that evolving past the
    measurements and sampling the resulting distribution is *exactly*
    equivalent to collapsing per shot -- and gives the learner the
    pre-measurement amplitudes their Bloch sphere and probability bars need,
    instead of one arbitrary collapsed branch.
    """
    n = circuit.qubits
    state = zero_state(n) if initial is None else initial
    clbits = [0] * circuit.clbits
    noisy = noise is not None and noise.active
    kraus_1q = noise.one_qubit_kraus() if noisy else None
    kraus_2q = noise.two_qubit_kraus() if noisy and noise.depolarizing2 else None
    kraus_relax_2q = noise.relaxation_kraus_2q() if noisy else None

    for op in circuit.ops:
        if not condition_holds(op, clbits):
            continue
        if op.gate == "barrier":
            continue

        if op.gate == "measure":
            if defer_measurements:
                continue
            q = op.targets[0]
            outcome = _sample_outcome(probability_of_one(state, n, q), rng)
            collapse(state, n, q, outcome)
            reported = outcome
            if noisy and noise is not None:
                p_flip = noise.readout if outcome == 0 else (
                    noise.readout if noise.readout_10 is None else noise.readout_10
                )
                if p_flip and rng.random() < p_flip:
                    reported = 1 - outcome
            if op.cbits and op.cbits[0] < len(clbits):
                clbits[op.cbits[0]] = reported
            continue

        if op.gate == "reset":
            q = op.targets[0]
            outcome = _sample_outcome(probability_of_one(state, n, q), rng)
            collapse(state, n, q, outcome)
            if outcome == 1:
                apply_matrix(state, n, [q], (), GATES["x"].matrix([]))
            continue

        matrix, targets, controls = op_target_matrix(op, bindings)
        apply_matrix(state, n, targets, controls, matrix)

        if noisy:
            touched = op.qubits
            if len(touched) >= 2:
                if kraus_2q is not None and len(touched) == 2:
                    apply_kraus_trajectory(state, n, touched, kraus_2q, rng)
                if kraus_relax_2q is not None:
                    for q in touched:
                        apply_kraus_trajectory(state, n, [q], kraus_relax_2q, rng)
            elif kraus_1q is not None:
                for q in touched:
                    apply_kraus_trajectory(state, n, [q], kraus_1q, rng)

    return state, clbits


def circuit_unitary(
    circuit: Circuit, bindings: dict[str, float] | None = None, max_qubits: int = 12
) -> np.ndarray:
    """The full 2**n x 2**n unitary, by evolving every basis state at once.

    Only for small n -- this is a teaching and testing tool (the transpiler's
    equivalence proofs use it), not a simulation strategy.
    """
    n = circuit.qubits
    if n > max_qubits:
        raise AdmissionError(
            f"circuit_unitary is limited to {max_qubits} qubits, got {n}"
        )
    for op in circuit.ops:
        d = GATES.get(op.gate)
        if d is None:
            raise ValueError(f"unknown gate {op.gate!r}")
        if not d.unitary and op.gate != "barrier":
            raise ValueError(f"circuit contains non-unitary op {op.gate!r}")
    dim = 1 << n
    u = np.eye(dim, dtype=np.complex128)
    for op in circuit.ops:
        if op.gate == "barrier":
            continue
        matrix, targets, controls = op_target_matrix(op, bindings)
        apply_matrix(u, n, targets, controls, matrix)
    return u


def equal_up_to_global_phase(a: np.ndarray, b: np.ndarray, atol: float = 1e-9) -> bool:
    """True when ``a == e^{i phi} b`` for some real phi.

    Compares by aligning on the largest-magnitude entry of ``b``, which is
    numerically stabler than dividing by an arbitrary entry that might be zero.
    """
    a = np.asarray(a)
    b = np.asarray(b)
    if a.shape != b.shape:
        return False
    flat_b = b.ravel()
    k = int(np.argmax(np.abs(flat_b)))
    if abs(flat_b[k]) < 1e-14:
        return bool(np.allclose(a, b, atol=atol))
    phase = a.ravel()[k] / flat_b[k]
    mag = abs(phase)
    if abs(mag - 1.0) > 1e-6:
        return False
    return bool(np.allclose(a, phase * b, atol=atol))


# --------------------------------------------------------------------------
# The backend
# --------------------------------------------------------------------------


class NativeBackend:
    """NumPy statevector simulation, always available."""

    name = "native"
    methods = ("statevector",)
    max_qubits = MAX_QUBITS

    def __init__(self, memory_budget_bytes: int | None = None) -> None:
        #: Per-worker allocation ceiling. ``None`` means "trust ``max_qubits``".
        self.memory_budget_bytes = memory_budget_bytes

    def info(self) -> BackendInfo:
        return BackendInfo(
            name=self.name,
            available=True,
            methods=self.methods,
            max_qubits=self.max_qubits,
            supports_noise=True,
            supports_mid_circuit_measurement=True,
            version=np.__version__,
        )

    def run(self, circuit: Circuit, options: SimOptions) -> SimResult:
        watch = timed()
        n = circuit.qubits
        cap = min(options.max_qubits, self.max_qubits)
        admit_statevector(n, cap, self.memory_budget_bytes)
        validate_or_raise(circuit)
        watch.mark("admitMs")

        rng = make_rng(options.seed)
        noise = options.noise if (options.noise and options.noise.active) else None
        deterministic = noise is None and is_terminal_measurement_only(circuit.ops)

        if deterministic:
            return self._run_deterministic(circuit, options, rng, watch)
        return self._run_trajectories(circuit, options, rng, noise, watch)

    # -- exact path --------------------------------------------------------

    def _run_deterministic(
        self, circuit: Circuit, options: SimOptions, rng: np.random.Generator, watch
    ) -> SimResult:
        n = circuit.qubits
        state, _ = run_once(
            circuit, options.bindings, rng, None, defer_measurements=True
        )
        watch.mark("evolveMs")
        probs = probabilities_from_state(state)

        counts: dict[str, int] | None = None
        counts_kind = None
        if options.shots > 0:
            basis_counts = sample_counts(probs, n, options.shots, rng)
            if any(op.gate == "measure" for op in circuit.ops):
                counts = counts_to_clbits(basis_counts, circuit)
                counts_kind = "clbits"
            else:
                counts = basis_counts
                counts_kind = "basis"
        watch.mark("sampleMs")

        result = SimResult(
            backend=self.name,
            method="statevector",
            qubits=n,
            clbits=circuit.clbits,
            probabilities=probs,
            statevector=state if options.return_statevector else None,
            counts=counts,
            counts_kind=counts_kind,
            stochastic=False,
            trajectories=1,
            shots=options.shots,
        )
        finalise_observables(result, options, state, None, n)
        watch.mark("observablesMs")
        result.timings = watch.finish()
        return result

    # -- trajectory path ---------------------------------------------------

    def _run_trajectories(
        self,
        circuit: Circuit,
        options: SimOptions,
        rng: np.random.Generator,
        noise: NoiseModel | None,
        watch,
    ) -> SimResult:
        n = circuit.qubits
        trajectories = min(max(options.shots, 1), options.max_trajectories)
        has_measure = any(op.gate == "measure" for op in circuit.ops)

        probs = np.zeros(1 << n, dtype=np.float64)
        bloch_acc = np.zeros((n, 3), dtype=np.float64)
        counts: dict[str, int] = {}
        rdm_acc: dict[str, np.ndarray] = {}
        exp_acc: dict[str, float] = {spec: 0.0 for spec in options.expectations}

        for _ in range(trajectories):
            state, clbits = run_once(circuit, options.bindings, rng, noise)
            p = probabilities_from_state(state)
            probs += p
            if options.return_bloch:
                for q, b in enumerate(bloch_vectors_from_state(state, n)):
                    bloch_acc[q] += (b.x, b.y, b.z)
            for keep in options.reduced_density:
                key = ",".join(str(q) for q in keep)
                r = reduced_density_from_state(state, n, keep)
                rdm_acc[key] = r if key not in rdm_acc else rdm_acc[key] + r
            for spec in options.expectations:
                exp_acc[spec] += pauli_expectation_state(state, n, spec)
            if has_measure:
                key = clbit_label(clbits)
            else:
                key = basis_label(int(rng.choice(p.size, p=p / p.sum())), n)
            counts[key] = counts.get(key, 0) + 1
        watch.mark("evolveMs")

        probs /= trajectories
        bloch_acc /= trajectories
        bloch = [
            BlochVector(
                float(x), float(y), float(z), float(math.sqrt(x * x + y * y + z * z))
            )
            for x, y, z in bloch_acc
        ]
        result = SimResult(
            backend=self.name,
            method="statevector",
            qubits=n,
            clbits=circuit.clbits,
            probabilities=probs,
            statevector=None,
            counts=counts,
            counts_kind="clbits" if has_measure else "basis",
            bloch=bloch if options.return_bloch else [],
            reduced_density={k: v / trajectories for k, v in rdm_acc.items()},
            expectations={k: v / trajectories for k, v in exp_acc.items()},
            stochastic=True,
            trajectories=trajectories,
            shots=options.shots,
            warnings=(
                ["shots exceeded max_trajectories; counts are undersampled"]
                if options.shots > trajectories
                else []
            ),
        )
        watch.mark("observablesMs")
        result.timings = watch.finish()
        return result


__all__ = [
    "GATHER_CHUNK",
    "MAX_QUBITS",
    "NativeBackend",
    "TRANSPOSE_MAX_QUBITS",
    "apply_kraus_trajectory",
    "apply_matrix",
    "circuit_unitary",
    "collapse",
    "condition_holds",
    "equal_up_to_global_phase",
    "is_terminal_measurement_only",
    "op_target_matrix",
    "probability_of_one",
    "run_once",
    "zero_state",
]
