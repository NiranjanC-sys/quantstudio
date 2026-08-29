"""PennyLane adapter: ``default.qubit`` and ``default.mixed``.

PennyLane, like Cirq, puts wire 0 in the most significant bit, so wire indices
carry over from the IR unchanged.

``default.qubit`` gives the exact statevector for unitary circuits with terminal
measurement. ``default.mixed`` carries a density matrix and is the path for
noise: our channel parameters map onto PennyLane's ``DepolarizingChannel``,
``AmplitudeDamping`` and ``PhaseDamping`` with the same meaning, which
``tests/test_noise.py`` checks against the NumPy density engine.
"""

from __future__ import annotations

import importlib
from typing import Any, Callable

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
from app.gates import GATES, base_form, gate
from app.ir import Circuit, resolve_params, validate_or_raise

METHODS = ("default.qubit", "default.mixed")

#: `default.qubit` is a dense NumPy simulator; beyond 24 qubits it is unusable.
MAX_QUBITS = 24
MIXED_MAX_QUBITS = 12


def _try_import() -> tuple[Any, str | None]:
    try:
        return importlib.import_module("pennylane"), None
    except Exception as exc:  # pragma: no cover - exercised only without the SDK
        return None, f"{type(exc).__name__}: {exc}"


def _op_factories(qml: Any) -> dict[str, Callable[[list[float], list[int]], Any]]:
    """Named PennyLane ops whose matrices are exactly ours, verified by test."""
    return {
        "id": lambda p, w: qml.Identity(w[0]),
        "x": lambda p, w: qml.PauliX(w[0]),
        "y": lambda p, w: qml.PauliY(w[0]),
        "z": lambda p, w: qml.PauliZ(w[0]),
        "h": lambda p, w: qml.Hadamard(w[0]),
        "s": lambda p, w: qml.S(w[0]),
        "sdg": lambda p, w: qml.adjoint(qml.S(w[0])),
        "t": lambda p, w: qml.T(w[0]),
        "tdg": lambda p, w: qml.adjoint(qml.T(w[0])),
        "sx": lambda p, w: qml.SX(w[0]),
        "sxdg": lambda p, w: qml.adjoint(qml.SX(w[0])),
        "rx": lambda p, w: qml.RX(p[0], w[0]),
        "ry": lambda p, w: qml.RY(p[0], w[0]),
        "rz": lambda p, w: qml.RZ(p[0], w[0]),
        "p": lambda p, w: qml.PhaseShift(p[0], w[0]),
        "u": lambda p, w: qml.U3(p[0], p[1], p[2], w[0]),
        "swap": lambda p, w: qml.SWAP(w),
        "iswap": lambda p, w: qml.ISWAP(w),
        "rxx": lambda p, w: qml.IsingXX(p[0], w),
        "ryy": lambda p, w: qml.IsingYY(p[0], w),
        "rzz": lambda p, w: qml.IsingZZ(p[0], w),
        "ecr": lambda p, w: qml.ECR(w),
    }


def apply_pennylane_ops(
    circuit: Circuit, bindings: dict[str, float] | None, noise: Any | None = None
) -> None:
    """Queue the circuit's ops inside an active PennyLane tape."""
    import pennylane as qml

    factories = _op_factories(qml)
    for op in circuit.ops:
        if op.gate in ("barrier", "measure"):
            continue
        if op.gate == "reset":
            qml.measure(op.targets[0], reset=True)
            continue
        base_key, targets, controls = base_form(op.gate, op.targets, op.controls)
        params = resolve_params(op.params, bindings)
        factory = factories.get(base_key)
        if factory is not None:
            pl_op = factory(params, list(targets))
        else:
            d = gate(base_key)
            if d.matrix is None:
                raise BackendUnavailable(f"gate {op.gate!r} has no matrix for PennyLane")
            pl_op = qml.QubitUnitary(d.matrix(params), wires=list(targets))
        if controls:
            qml.ctrl(pl_op, control=list(controls))
        if noise is not None:
            _apply_noise(qml, noise, op.qubits)


def _apply_noise(qml: Any, noise: Any, qubits: list[int]) -> None:
    """Attach PennyLane channels after a gate, matching our channel definitions."""
    two = len(qubits) >= 2
    if two and noise.depolarizing2:
        # PennyLane has no 2-qubit depolarising channel; the standard reduction
        # applies the single-qubit channel with the matched marginal strength.
        # 1 - (1-q)^2 == p_2q  =>  q == 1 - sqrt(1 - p_2q).
        q = 1.0 - float(np.sqrt(max(0.0, 1.0 - noise.depolarizing2)))
        for w in qubits:
            qml.DepolarizingChannel(q, wires=w)
    elif not two and noise.depolarizing1:
        for w in qubits:
            qml.DepolarizingChannel(noise.depolarizing1, wires=w)
    if noise.amplitude_damping:
        for w in qubits:
            qml.AmplitudeDamping(noise.amplitude_damping, wires=w)
    if noise.phase_damping:
        for w in qubits:
            qml.PhaseDamping(noise.phase_damping, wires=w)


class PennyLaneBackend:
    """PennyLane's reference devices, exact statevector and exact density matrix."""

    name = "pennylane"
    methods = METHODS
    max_qubits = MAX_QUBITS

    def __init__(self) -> None:
        self._qml, self._error = _try_import()

    @property
    def available(self) -> bool:
        return self._qml is not None

    def info(self) -> BackendInfo:
        return BackendInfo(
            name=self.name,
            available=self.available,
            methods=self.methods,
            max_qubits=MAX_QUBITS,
            supports_noise=True,
            supports_mid_circuit_measurement=False,
            detail=self._error,
            version=getattr(self._qml, "version", lambda: None)() if self._qml else None,
        )

    def run(self, circuit: Circuit, options: SimOptions) -> SimResult:
        if not self.available:
            raise BackendUnavailable(f"pennylane is not installed ({self._error})")
        if not is_terminal_measurement_only(circuit.ops):
            raise BackendUnavailable(
                "the PennyLane adapter supports terminal measurement only; use the "
                "'native' or 'aer' backend for mid-circuit measurement, reset or "
                "classical conditions"
            )
        noise = options.noise if (options.noise and options.noise.active) else None
        method = options.method if options.method in METHODS else (
            "default.mixed" if noise else "default.qubit"
        )
        if noise and method == "default.qubit":
            method = "default.mixed"

        watch = timed()
        n = circuit.qubits
        if method == "default.mixed":
            admit_density(n, min(options.max_qubits, MIXED_MAX_QUBITS))
        else:
            admit_statevector(n, min(options.max_qubits, MAX_QUBITS))
        validate_or_raise(circuit)
        watch.mark("admitMs")

        import pennylane as qml

        dev = qml.device(method, wires=n)

        if method == "default.mixed":
            @qml.qnode(dev)
            def qnode():  # type: ignore[no-untyped-def]
                apply_pennylane_ops(circuit, options.bindings, noise)
                return qml.density_matrix(wires=list(range(n)))
        else:
            @qml.qnode(dev)
            def qnode():  # type: ignore[no-untyped-def]
                apply_pennylane_ops(circuit, options.bindings, None)
                return qml.state()

        raw = np.asarray(qnode(), dtype=np.complex128)
        watch.mark("evolveMs")

        psi = rho = None
        if method == "default.mixed":
            rho = raw.reshape(1 << n, 1 << n)
            probs = probabilities_from_density(rho)
        else:
            psi = raw.ravel()
            probs = probabilities_from_state(psi)

        rng = make_rng(options.seed)
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


__all__ = ["MAX_QUBITS", "METHODS", "MIXED_MAX_QUBITS", "PennyLaneBackend", "apply_pennylane_ops"]
