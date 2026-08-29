"""NumPy density-matrix engine, for exact noisy simulation.

Where the statevector engine unravels a channel into sampled trajectories, this
one carries the full ``2**n x 2**n`` density matrix and applies
``rho -> sum_k K_k rho K_k^dagger`` directly, so a noisy result is exact rather
than converged. That costs ``4**n * 16`` bytes -- 4 GiB at n = 14 -- which is
why the cap is 14 qubits and why the admission check runs before any allocation
(system design, section 4).

The Kraus sandwich is written without assuming ``rho`` is Hermitian:
``M rho M^dagger`` is computed as ``((M (M rho)^dagger)^dagger``, using the same
in-place gate kernel as the statevector engine on a batched ``(2**n, 2**n)``
array. Two conjugate transposes cost two copies; assuming Hermiticity would
save one but would silently square any drift, and an exact engine that is only
approximately exact is worse than useless in a lesson about noise.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np

from app.backends.base import (
    AdmissionError,
    BackendInfo,
    BackendUnavailable,
    SimOptions,
    SimResult,
    admit_density,
    basis_label,
    bloch_vectors_from_density,
    clbit_label,
    counts_to_clbits,
    density_bytes,
    finalise_observables,
    make_rng,
    pauli_expectation_density,
    probabilities_from_density,
    reduced_density_from_density,
    sample_counts,
    timed,
)
from app.backends.native import (
    apply_matrix,
    condition_holds,
    is_terminal_measurement_only,
    op_target_matrix,
)
from app.gates import GATES, Matrix
from app.ir import Circuit, validate_or_raise
from app.noise import KrausSet, NoiseModel

#: 4**14 * 16 B == 4 GiB. Section 4 of the system design fixes this number.
MAX_QUBITS = 14


def _conj_t(m: np.ndarray) -> np.ndarray:
    """Contiguous conjugate transpose. The gate kernel needs a real array."""
    return np.ascontiguousarray(m.conj().T)


def sandwich(
    rho: np.ndarray, n: int, targets: Sequence[int], controls: Sequence[int], m: Matrix
) -> np.ndarray:
    """``M rho M^dagger`` using the statevector gate kernel on both sides."""
    tmp = rho.copy()
    apply_matrix(tmp, n, targets, controls, m)  # M rho
    tmp = _conj_t(tmp)  # rho^dagger M^dagger
    apply_matrix(tmp, n, targets, controls, m)  # M rho^dagger M^dagger
    return _conj_t(tmp)  # M rho M^dagger


def apply_channel(
    rho: np.ndarray, n: int, qubits: Sequence[int], kraus: KrausSet
) -> np.ndarray:
    """``sum_k K_k rho K_k^dagger`` -- the exact action of a Kraus channel."""
    if len(kraus) == 1:
        return sandwich(rho, n, qubits, (), kraus[0])
    acc = np.zeros_like(rho)
    for k in kraus:
        acc += sandwich(rho, n, qubits, (), k)
    return acc


def zero_density(n: int) -> np.ndarray:
    rho = np.zeros((1 << n, 1 << n), dtype=np.complex128)
    rho[0, 0] = 1.0
    return rho


def measurement_probability(rho: np.ndarray, n: int, q: int) -> float:
    """``Tr(Pi_1 rho)`` for qubit ``q``: the diagonal mass with that bit set."""
    diag = np.real(np.diag(rho))
    bit = 1 << (n - 1 - q)
    idx = np.arange(rho.shape[0])
    return float(diag[(idx & bit) != 0].sum())


def project(rho: np.ndarray, n: int, q: int, outcome: int) -> np.ndarray:
    """``Pi_o rho Pi_o`` renormalised: the post-measurement state of one branch."""
    bit = 1 << (n - 1 - q)
    idx = np.arange(rho.shape[0])
    keep = ((idx & bit) != 0) == bool(outcome)
    out = np.zeros_like(rho)
    sel = np.ix_(keep, keep)
    out[sel] = rho[sel]
    tr = float(np.real(np.trace(out)))
    if tr > 0:
        out /= tr
    return out


def purity(rho: np.ndarray) -> float:
    """``Tr(rho^2)``: 1 for a pure state, 1/2**n for the maximally mixed one."""
    return float(np.real(np.einsum("ij,ji->", rho, rho)))


class DensityBackend:
    """Exact noisy simulation on the density matrix. Capped at 14 qubits."""

    name = "density"
    methods = ("density_matrix",)
    max_qubits = MAX_QUBITS

    def __init__(self, memory_budget_bytes: int | None = None) -> None:
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
        admit_density(n, cap, self.memory_budget_bytes)
        validate_or_raise(circuit)
        watch.mark("admitMs")

        rng = make_rng(options.seed)
        noise = options.noise if (options.noise and options.noise.active) else None
        exact = is_terminal_measurement_only(circuit.ops)

        if exact:
            rho = self._evolve(circuit, options, noise, rng, defer_measurements=True)[0]
            watch.mark("evolveMs")
            return self._assemble(circuit, options, rho, rng, watch, 1, None)

        # Mid-circuit measurement or a classical condition: unravel the
        # measurement channel by sampling a branch per trajectory. Exact in the
        # many-trajectory limit and the only way to honour `condition`.
        trajectories = min(max(options.shots, 1), options.max_trajectories)
        acc = np.zeros((1 << n, 1 << n), dtype=np.complex128)
        counts: dict[str, int] = {}
        has_measure = any(op.gate == "measure" for op in circuit.ops)
        for _ in range(trajectories):
            rho, clbits = self._evolve(circuit, options, noise, rng, defer_measurements=False)
            acc += rho
            if has_measure:
                key = clbit_label(clbits)
                counts[key] = counts.get(key, 0) + 1
        acc /= trajectories
        watch.mark("evolveMs")
        return self._assemble(
            circuit, options, acc, rng, watch, trajectories, counts if has_measure else None
        )

    # -- internals ---------------------------------------------------------

    def _evolve(
        self,
        circuit: Circuit,
        options: SimOptions,
        noise: NoiseModel | None,
        rng: np.random.Generator,
        defer_measurements: bool,
    ) -> tuple[np.ndarray, list[int]]:
        n = circuit.qubits
        rho = zero_density(n)
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
                p1 = measurement_probability(rho, n, q)
                outcome = 1 if rng.random() < p1 else 0
                rho = project(rho, n, q, outcome)
                reported = outcome
                if noisy and noise is not None:
                    p_flip = (
                        noise.readout
                        if outcome == 0
                        else (noise.readout if noise.readout_10 is None else noise.readout_10)
                    )
                    if p_flip and rng.random() < p_flip:
                        reported = 1 - outcome
                if op.cbits and op.cbits[0] < len(clbits):
                    clbits[op.cbits[0]] = reported
                continue
            if op.gate == "reset":
                q = op.targets[0]
                p1 = measurement_probability(rho, n, q)
                outcome = 1 if rng.random() < p1 else 0
                rho = project(rho, n, q, outcome)
                if outcome == 1:
                    rho = sandwich(rho, n, [q], (), GATES["x"].matrix([]))
                continue

            matrix, targets, controls = op_target_matrix(op, options.bindings)
            rho = sandwich(rho, n, targets, controls, matrix)

            if noisy:
                touched = op.qubits
                if len(touched) >= 2:
                    if kraus_2q is not None and len(touched) == 2:
                        rho = apply_channel(rho, n, touched, kraus_2q)
                    if kraus_relax_2q is not None and len(kraus_relax_2q) > 1:
                        for q in touched:
                            rho = apply_channel(rho, n, [q], kraus_relax_2q)
                elif kraus_1q is not None and len(kraus_1q) > 1:
                    for q in touched:
                        rho = apply_channel(rho, n, [q], kraus_1q)
        return rho, clbits

    def _assemble(
        self,
        circuit: Circuit,
        options: SimOptions,
        rho: np.ndarray,
        rng: np.random.Generator,
        watch,
        trajectories: int,
        counts: dict[str, int] | None,
    ) -> SimResult:
        n = circuit.qubits
        probs = probabilities_from_density(rho)
        counts_kind = None
        if counts is not None:
            counts_kind = "clbits"
        elif options.shots > 0:
            basis_counts = sample_counts(probs, n, options.shots, rng)
            if any(op.gate == "measure" for op in circuit.ops):
                counts = counts_to_clbits(basis_counts, circuit)
                counts_kind = "clbits"
                if options.noise and options.noise.readout:
                    from app.backends.base import apply_readout_error

                    counts = apply_readout_error(
                        counts,
                        options.noise.readout,
                        options.noise.readout
                        if options.noise.readout_10 is None
                        else options.noise.readout_10,
                        rng,
                    )
            else:
                counts = basis_counts
                counts_kind = "basis"
        watch.mark("sampleMs")

        result = SimResult(
            backend=self.name,
            method="density_matrix",
            qubits=n,
            clbits=circuit.clbits,
            probabilities=probs,
            statevector=None,
            density_matrix=rho,
            counts=counts,
            counts_kind=counts_kind,
            stochastic=trajectories > 1,
            trajectories=trajectories,
            shots=options.shots,
            metadata={"purity": purity(rho)},
        )
        finalise_observables(result, options, None, rho, n)
        watch.mark("observablesMs")
        result.timings = watch.finish()
        return result


__all__ = [
    "MAX_QUBITS",
    "DensityBackend",
    "apply_channel",
    "measurement_probability",
    "project",
    "purity",
    "sandwich",
    "zero_density",
]
