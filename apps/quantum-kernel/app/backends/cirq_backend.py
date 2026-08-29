"""Cirq adapter.

Cirq shares our qubit convention exactly -- the first qubit of a moment's
operand list is the most significant bit of the basis index -- so this adapter
does no index translation at all. That is not an accident: the convention in
``app/gates.py`` was chosen to match Cirq and the textbooks, and
``tests/test_cross_backend.py`` checks that a Cirq run and a native run agree to
1e-9 on a random circuit ensemble, which would fail immediately if either side
reversed anything.

Scope: unitary evolution plus terminal measurement. Mid-circuit measurement,
classical conditions and noise route to the native or Aer backends, which model
them properly; this adapter refuses them explicitly rather than silently
producing something plausible-looking.
"""

from __future__ import annotations

import importlib
import math
from typing import Any, Callable

import numpy as np

from app.backends.base import (
    BackendInfo,
    BackendUnavailable,
    SimOptions,
    SimResult,
    admit_statevector,
    counts_to_clbits,
    finalise_observables,
    make_rng,
    probabilities_from_state,
    sample_counts,
    timed,
)
from app.backends.native import is_terminal_measurement_only
from app.gates import GATES, base_form, gate
from app.ir import Circuit, resolve_params, validate_or_raise

#: Cirq's dense simulator is a Python/NumPy loop; 24 qubits is already minutes.
MAX_QUBITS = 24


def _try_import() -> tuple[Any, str | None]:
    try:
        return importlib.import_module("cirq"), None
    except Exception as exc:  # pragma: no cover - exercised only without the SDK
        return None, f"{type(exc).__name__}: {exc}"


def _gate_factories(cirq: Any) -> dict[str, Callable[[list[float]], Any]]:
    """Named Cirq gates whose matrices are *exactly* ours, verified by test.

    Everything absent from this table falls back to ``cirq.MatrixGate`` built
    from the registry, which is exact by construction and still exercises
    Cirq's simulator rather than ours.
    """
    pi = math.pi
    return {
        "id": lambda p: cirq.I,
        "x": lambda p: cirq.X,
        "y": lambda p: cirq.Y,
        "z": lambda p: cirq.Z,
        "h": lambda p: cirq.H,
        "s": lambda p: cirq.S,
        "sdg": lambda p: cirq.S**-1,
        "t": lambda p: cirq.T,
        "tdg": lambda p: cirq.T**-1,
        "sx": lambda p: cirq.X**0.5,
        "sxdg": lambda p: cirq.X**-0.5,
        "rx": lambda p: cirq.rx(p[0]),
        "ry": lambda p: cirq.ry(p[0]),
        "rz": lambda p: cirq.rz(p[0]),
        "p": lambda p: cirq.ZPowGate(exponent=p[0] / pi),
        "swap": lambda p: cirq.SWAP,
        "iswap": lambda p: cirq.ISWAP,
        "rxx": lambda p: cirq.XXPowGate(exponent=p[0] / pi, global_shift=-0.5),
        "ryy": lambda p: cirq.YYPowGate(exponent=p[0] / pi, global_shift=-0.5),
        "rzz": lambda p: cirq.ZZPowGate(exponent=p[0] / pi, global_shift=-0.5),
    }


def to_cirq(circuit: Circuit, bindings: dict[str, float] | None = None):
    """Build a ``cirq.Circuit``. Qubit ``q`` is ``cirq.LineQubit(q)`` -- no reversal."""
    import cirq

    factories = _gate_factories(cirq)
    qubits = cirq.LineQubit.range(circuit.qubits)
    ops: list[Any] = []
    for op in circuit.ops:
        if op.gate in ("barrier", "measure"):
            continue
        if op.gate == "reset":
            ops.append(cirq.reset(qubits[op.targets[0]]))
            continue
        base_key, targets, controls = base_form(op.gate, op.targets, op.controls)
        params = resolve_params(op.params, bindings)
        factory = factories.get(base_key)
        if factory is not None:
            g = factory(params)
        else:
            d = gate(base_key)
            if d.matrix is None:
                raise BackendUnavailable(f"gate {op.gate!r} has no matrix for Cirq")
            g = cirq.MatrixGate(d.matrix(params), name=base_key)
        cop = g.on(*[qubits[t] for t in targets])
        if controls:
            cop = cop.controlled_by(*[qubits[c] for c in controls])
        ops.append(cop)
    return cirq.Circuit(ops), qubits


class CirqBackend:
    """Cirq's dense statevector simulator, in double precision."""

    name = "cirq"
    methods = ("statevector",)
    max_qubits = MAX_QUBITS

    def __init__(self) -> None:
        self._cirq, self._error = _try_import()

    @property
    def available(self) -> bool:
        return self._cirq is not None

    def info(self) -> BackendInfo:
        return BackendInfo(
            name=self.name,
            available=self.available,
            methods=self.methods,
            max_qubits=MAX_QUBITS,
            supports_noise=False,
            supports_mid_circuit_measurement=False,
            detail=self._error,
            version=getattr(self._cirq, "__version__", None) if self._cirq else None,
        )

    def run(self, circuit: Circuit, options: SimOptions) -> SimResult:
        if not self.available:
            raise BackendUnavailable(f"cirq is not installed ({self._error})")
        if options.noise is not None and options.noise.active:
            raise BackendUnavailable(
                "the Cirq adapter models unitary evolution only; use the 'density' "
                "or 'aer' backend for noise"
            )
        if not is_terminal_measurement_only(circuit.ops):
            raise BackendUnavailable(
                "the Cirq adapter supports terminal measurement only; use the "
                "'native' or 'aer' backend for mid-circuit measurement, reset or "
                "classical conditions"
            )
        watch = timed()
        n = circuit.qubits
        admit_statevector(n, min(options.max_qubits, MAX_QUBITS))
        validate_or_raise(circuit)
        watch.mark("admitMs")

        import cirq

        cc, qubits = to_cirq(circuit, options.bindings)
        sim = cirq.Simulator(dtype=np.complex128, seed=options.seed)
        # `qubit_order` is pinned so an unused leading qubit cannot shift the
        # amplitude layout; Cirq would otherwise drop qubits it never sees.
        final = sim.simulate(cc, qubit_order=qubits)
        psi = np.asarray(final.final_state_vector, dtype=np.complex128)
        watch.mark("evolveMs")

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
            method="statevector",
            qubits=n,
            clbits=circuit.clbits,
            probabilities=probs,
            statevector=psi if options.return_statevector else None,
            counts=counts,
            counts_kind=counts_kind,
            shots=options.shots,
        )
        finalise_observables(result, options, psi, None, n)
        watch.mark("observablesMs")
        result.timings = watch.finish()
        return result


__all__ = ["MAX_QUBITS", "CirqBackend", "to_cirq"]
