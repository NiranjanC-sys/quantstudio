"""Qiskit Aer adapter: statevector, density_matrix and matrix_product_state.

The SDK import lives inside the methods, not at module scope, so a pod built
without the heavy wheels still starts and still reports this backend as
``available: false`` with the import error attached.

Endianness is handled once, in ``app/codegen.to_qiskit``: our qubit ``q``
becomes Qiskit wire ``n-1-q``. With that single change, Aer's amplitude array
and ours are the *same array* -- no reversal of the vector, no relabelling of
counts (both put classical bit 0 rightmost). The proof is in
``tests/test_cross_backend.py``.
"""

from __future__ import annotations

import importlib
from typing import Any

import numpy as np

from app.backends.base import (
    BackendInfo,
    BackendUnavailable,
    SimOptions,
    SimResult,
    admit_density,
    admit_statevector,
    counts_to_clbits,
    finalise_observables,
    make_rng,
    probabilities_from_density,
    probabilities_from_state,
    sample_counts,
    timed,
)
from app.backends.native import is_terminal_measurement_only
from app.codegen import to_qiskit
from app.ir import Circuit, validate_or_raise
from app.noise import NoiseModel

METHODS = ("statevector", "density_matrix", "matrix_product_state")

#: Density-matrix simulation is 4**n; the same 14-qubit ceiling as our own engine.
DENSITY_MAX_QUBITS = 14
STATEVECTOR_MAX_QUBITS = 30

_ONE_QUBIT_GATES = (
    "id", "x", "y", "z", "h", "s", "sdg", "t", "tdg", "sx", "sxdg",
    "rx", "ry", "rz", "p", "u",
)
_TWO_QUBIT_GATES = (
    "cx", "cy", "cz", "ch", "swap", "iswap", "rxx", "ryy", "rzz", "rzx", "ecr",
    "cp", "crx", "cry", "crz", "cu", "cs", "csdg", "csx",
)


def _try_import() -> tuple[Any, Any, str | None]:
    try:
        qiskit = importlib.import_module("qiskit")
        aer = importlib.import_module("qiskit_aer")
        return qiskit, aer, None
    except Exception as exc:  # pragma: no cover - exercised only without the SDK
        return None, None, f"{type(exc).__name__}: {exc}"


def _strip_measurements(circuit: Circuit) -> Circuit:
    """The same circuit without measure ops, for the exact-state pass."""
    return circuit.model_copy(
        update={"ops": [op for op in circuit.ops if op.gate != "measure"]}
    )


def build_aer_noise(model: NoiseModel) -> Any:
    """Translate our NoiseModel into ``qiskit_aer.noise.NoiseModel``.

    Deliberately uses Aer's own error constructors rather than pushing our
    Kraus matrices through: if the two libraries disagree about what
    "depolarising 1%" means, a lesson comparing engines should surface that,
    and ``tests/test_noise.py`` pins the agreement to 2 decimal places.
    """
    from qiskit_aer.noise import (
        NoiseModel as AerNoiseModel,
        ReadoutError,
        depolarizing_error,
        phase_damping_error,
        amplitude_damping_error,
        thermal_relaxation_error,
    )

    nm = AerNoiseModel()
    if model.depolarizing1:
        nm.add_all_qubit_quantum_error(
            depolarizing_error(model.depolarizing1, 1), list(_ONE_QUBIT_GATES)
        )
    if model.depolarizing2:
        nm.add_all_qubit_quantum_error(
            depolarizing_error(model.depolarizing2, 2), list(_TWO_QUBIT_GATES)
        )
    if model.t1 is not None and model.t2 is not None:
        nm.add_all_qubit_quantum_error(
            thermal_relaxation_error(model.t1, model.t2, model.gate_time_1q),
            list(_ONE_QUBIT_GATES),
        )
        two = thermal_relaxation_error(model.t1, model.t2, model.gate_time_2q)
        nm.add_all_qubit_quantum_error(two.tensor(two), list(_TWO_QUBIT_GATES))
    else:
        if model.amplitude_damping:
            nm.add_all_qubit_quantum_error(
                amplitude_damping_error(model.amplitude_damping), list(_ONE_QUBIT_GATES)
            )
        if model.phase_damping:
            nm.add_all_qubit_quantum_error(
                phase_damping_error(model.phase_damping), list(_ONE_QUBIT_GATES)
            )
    if model.readout or model.readout_10:
        p01 = model.readout
        p10 = model.readout if model.readout_10 is None else model.readout_10
        # Aer indexes [true][reported].
        nm.add_all_qubit_readout_error(ReadoutError([[1 - p01, p01], [p10, 1 - p10]]))
    return nm


class AerBackend:
    """Qiskit Aer. Three methods, chosen by ``SimOptions.method``."""

    name = "aer"
    methods = METHODS

    def __init__(self) -> None:
        self._qiskit, self._aer, self._error = _try_import()

    @property
    def available(self) -> bool:
        return self._aer is not None

    @property
    def max_qubits(self) -> int:
        return STATEVECTOR_MAX_QUBITS

    def info(self) -> BackendInfo:
        return BackendInfo(
            name=self.name,
            available=self.available,
            methods=self.methods,
            max_qubits=STATEVECTOR_MAX_QUBITS,
            supports_noise=True,
            supports_mid_circuit_measurement=True,
            detail=self._error,
            version=getattr(self._qiskit, "__version__", None) if self._qiskit else None,
        )

    def run(self, circuit: Circuit, options: SimOptions) -> SimResult:
        if not self.available:
            raise BackendUnavailable(f"qiskit-aer is not installed ({self._error})")
        method = options.method if options.method in METHODS else "statevector"
        watch = timed()
        n = circuit.qubits
        if method == "density_matrix":
            admit_density(n, min(options.max_qubits, DENSITY_MAX_QUBITS))
        else:
            admit_statevector(n, min(options.max_qubits, STATEVECTOR_MAX_QUBITS))
        validate_or_raise(circuit)
        watch.mark("admitMs")

        from qiskit_aer import AerSimulator

        noise = options.noise if (options.noise and options.noise.active) else None
        aer_noise = build_aer_noise(noise) if noise else None
        sim = AerSimulator(method=method, noise_model=aer_noise)
        rng = make_rng(options.seed)
        deterministic = noise is None and is_terminal_measurement_only(circuit.ops)

        if deterministic:
            return self._run_exact(circuit, options, sim, method, rng, watch)
        return self._run_sampled(circuit, options, sim, method, rng, watch)

    # -- exact -------------------------------------------------------------

    def _run_exact(
        self, circuit: Circuit, options: SimOptions, sim, method: str, rng, watch
    ) -> SimResult:
        from qiskit import transpile as qk_transpile

        n = circuit.qubits
        qc = to_qiskit(_strip_measurements(circuit), options.bindings)
        if method == "density_matrix":
            qc.save_density_matrix(label="rho")
        else:
            qc.save_statevector(label="psi")
        job = sim.run(qk_transpile(qc, sim), shots=1, seed_simulator=options.seed)
        data = job.result().data(0)
        watch.mark("evolveMs")

        psi = rho = None
        if method == "density_matrix":
            rho = np.asarray(data["rho"], dtype=np.complex128)
            probs = probabilities_from_density(rho)
        else:
            psi = np.asarray(data["psi"], dtype=np.complex128)
            probs = probabilities_from_state(psi)

        counts = None
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
            method=method,
            qubits=n,
            clbits=circuit.clbits,
            probabilities=probs,
            statevector=psi if options.return_statevector else None,
            density_matrix=rho,
            counts=counts,
            counts_kind=counts_kind,
            shots=options.shots,
        )
        finalise_observables(result, options, psi, rho, n)
        watch.mark("observablesMs")
        result.timings = watch.finish()
        return result

    # -- sampled -----------------------------------------------------------

    def _run_sampled(
        self, circuit: Circuit, options: SimOptions, sim, method: str, rng, watch
    ) -> SimResult:
        """Noisy or mid-circuit-measurement runs: Aer samples, we summarise.

        ``density_matrix`` still yields an exact ``rho`` even under noise, so
        probabilities come from the diagonal; the other methods can only report
        the empirical distribution, and we say so via ``stochastic``.
        """
        from qiskit import transpile as qk_transpile

        n = circuit.qubits
        shots = max(options.shots, 1)
        qc = to_qiskit(circuit, options.bindings)
        want_rho = method == "density_matrix"
        if want_rho:
            qc.save_density_matrix(label="rho")
        job = sim.run(qk_transpile(qc, sim), shots=shots, seed_simulator=options.seed)
        res = job.result()
        watch.mark("evolveMs")

        raw_counts: dict[str, int] = {}
        try:
            raw_counts = {k.replace(" ", ""): int(v) for k, v in res.get_counts().items()}
        except Exception:
            raw_counts = {}

        rho = None
        if want_rho:
            rho = np.asarray(res.data(0)["rho"], dtype=np.complex128)
            probs = probabilities_from_density(rho)
        else:
            probs = np.zeros(1 << n, dtype=np.float64)
            if raw_counts and not any(op.gate == "measure" for op in circuit.ops):
                for key, c in raw_counts.items():
                    probs[int(key, 2)] += c
                probs /= probs.sum()

        result = SimResult(
            backend=self.name,
            method=method,
            qubits=n,
            clbits=circuit.clbits,
            probabilities=probs,
            statevector=None,
            density_matrix=rho,
            counts=raw_counts or None,
            counts_kind="clbits" if raw_counts else None,
            stochastic=True,
            trajectories=shots,
            shots=options.shots,
            warnings=(
                []
                if want_rho
                else ["probabilities are empirical: a noisy statevector run has no single amplitude vector"]
            ),
        )
        finalise_observables(result, options, None, rho, n)
        watch.mark("observablesMs")
        result.timings = watch.finish()
        return result


__all__ = ["AerBackend", "DENSITY_MAX_QUBITS", "METHODS", "STATEVECTOR_MAX_QUBITS", "build_aer_noise"]
