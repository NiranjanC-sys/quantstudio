"""The transpiler must not change what a circuit computes.

Every assertion here is semantic equivalence on the full unitary, up to a
global phase -- the one thing that is physically unobservable and therefore the
only thing a compiler is allowed to change. Where routing has permuted the
qubits, the permutation is undone explicitly with
``permutation_operator`` rather than tolerated, because "equivalent after some
relabelling I did not write down" is not a property anyone can rely on.
"""

from __future__ import annotations

import math
import random

import numpy as np
import pytest

from app.backends.native import circuit_unitary, equal_up_to_global_phase
from app.gates import op_matrix
from app.ir import Circuit, Op, metrics
from app.noise import DEVICE_NAMES
from app.transpile import (
    BASIS_SETS,
    CouplingMap,
    TranspileTarget,
    cancel_adjacent_inverses,
    controlled_u_ops,
    decompose,
    drop_trivial_rotations,
    emit_ibm,
    emit_ion,
    emit_u,
    emit_zyz,
    multi_controlled_ops,
    permutation_operator,
    toffoli_ops,
    transpile,
    zyz,
)

BASES = ("none", "ibm", "ion", "u_cx")

ONE_QUBIT = ("h", "x", "y", "z", "s", "t", "sx")
ONE_QUBIT_PARAM = ("rx", "ry", "rz", "p")
TWO_QUBIT = ("cx", "cz", "cy", "swap", "ch", "iswap")
TWO_QUBIT_PARAM = ("cp", "crx", "cry", "crz", "rzz")


def random_circuit(n: int, depth: int, rng: random.Random) -> Circuit:
    ops: list[Op] = []
    for _ in range(depth):
        if rng.random() < 0.5 or n < 2:
            key = rng.choice(ONE_QUBIT + ONE_QUBIT_PARAM)
            params = [rng.uniform(-math.pi, math.pi)] if key in ONE_QUBIT_PARAM else []
            ops.append(Op(gate=key, targets=[rng.randrange(n)], params=params))
        else:
            a, b = rng.sample(range(n), 2)
            key = rng.choice(TWO_QUBIT + TWO_QUBIT_PARAM)
            params = [rng.uniform(-math.pi, math.pi)] if key in TWO_QUBIT_PARAM else []
            ops.append(Op(gate=key, targets=[a, b], params=params))
    return Circuit(qubits=n, name="random", ops=ops)


def assert_equivalent(a: Circuit, b: Circuit, message: str = "") -> None:
    ua, ub = circuit_unitary(a), circuit_unitary(b)
    assert equal_up_to_global_phase(ua, ub, 1e-8), (
        f"{message}: circuits differ; max entrywise error "
        f"{np.abs(ua - ub).max():.3e}"
    )


# --------------------------------------------------------------------------
# Single-qubit decomposition
# --------------------------------------------------------------------------


def random_unitary(rng: np.random.Generator, dim: int = 2) -> np.ndarray:
    """Haar-random via QR of a complex Ginibre matrix, with the phase fixed."""
    z = rng.normal(size=(dim, dim)) + 1j * rng.normal(size=(dim, dim))
    q, r = np.linalg.qr(z)
    return q * (np.diag(r) / np.abs(np.diag(r)))


@pytest.mark.parametrize("seed", range(12))
def test_zyz_reconstructs_the_unitary_exactly(seed: int) -> None:
    """Including the global phase: the controlled-gate constructions need it."""
    u = random_unitary(np.random.default_rng(seed))
    alpha, beta, gamma, delta = zyz(u)
    rz = lambda t: op_matrix("rz", [t])  # noqa: E731
    ry = lambda t: op_matrix("ry", [t])  # noqa: E731
    rebuilt = np.exp(1j * alpha) * rz(beta) @ ry(gamma) @ rz(delta)
    assert np.allclose(rebuilt, u, atol=1e-12)


@pytest.mark.parametrize("emitter", [emit_u, emit_zyz, emit_ibm, emit_ion])
@pytest.mark.parametrize("seed", range(8))
def test_one_qubit_emitters_preserve_the_operator(emitter, seed: int) -> None:
    u = random_unitary(np.random.default_rng(1000 + seed))
    ops = emitter(u, 0)
    circuit = Circuit(qubits=1, ops=ops)
    assert equal_up_to_global_phase(circuit_unitary(circuit), u, 1e-10), (
        f"{emitter.__name__} lost the operator"
    )


@pytest.mark.parametrize("emitter,basis", [(emit_ibm, "ibm"), (emit_ion, "ion")])
def test_one_qubit_emitters_stay_in_their_basis(emitter, basis: str) -> None:
    allowed = set(BASIS_SETS[basis])
    u = random_unitary(np.random.default_rng(5))
    for op in emitter(u, 0):
        assert op.gate in allowed, f"{emitter.__name__} emitted {op.gate}"


# --------------------------------------------------------------------------
# Controlled-gate decomposition
# --------------------------------------------------------------------------


@pytest.mark.parametrize("seed", range(8))
def test_controlled_u_decomposition_is_exact(seed: int) -> None:
    """Exact, not up to phase: a controlled gate that lost its phase becomes
    wrong the moment something controls *it*."""
    u = random_unitary(np.random.default_rng(2000 + seed))
    ops = controlled_u_ops(u, 0, 1)
    from app.gates import controlled

    built = circuit_unitary(Circuit(qubits=2, ops=ops))
    assert np.allclose(built, controlled(u, 1), atol=1e-10)


def test_toffoli_decomposition_is_exact() -> None:
    built = circuit_unitary(Circuit(qubits=3, ops=toffoli_ops(0, 1, 2)))
    assert np.allclose(built, op_matrix("ccx", []), atol=1e-10)


def test_toffoli_decomposition_costs_six_cnots() -> None:
    """The textbook number, and the one the lesson quotes."""
    ops = toffoli_ops(0, 1, 2)
    assert sum(1 for o in ops if o.gate == "cx") == 6


@pytest.mark.parametrize("controls", [1, 2, 3, 4])
def test_multi_controlled_x_is_exact(controls: int) -> None:
    from app.gates import controlled

    n = controls + 1
    ops = multi_controlled_ops(op_matrix("x", []), list(range(controls)), controls)
    built = circuit_unitary(Circuit(qubits=n, ops=ops))
    assert np.allclose(built, controlled(op_matrix("x", []), controls), atol=1e-9)


def test_decompose_preserves_semantics() -> None:
    for seed in range(6):
        circuit = random_circuit(3, 10, random.Random(300 + seed))
        assert_equivalent(circuit, decompose(circuit), f"decompose seed {seed}")


def test_decompose_leaves_only_one_and_two_qubit_gates() -> None:
    circuit = Circuit(
        qubits=4,
        ops=[
            Op(gate="ccx", targets=[0, 1, 2]),
            Op(gate="cswap", targets=[0, 2, 3]),
            Op(gate="mcx", targets=[3], controls=[0, 1, 2]),
        ],
    )
    out = decompose(circuit)
    for op in out.ops:
        assert len(op.qubits) <= 2, f"{op.gate} still acts on {len(op.qubits)} qubits"


# --------------------------------------------------------------------------
# Optimisation passes
# --------------------------------------------------------------------------


def test_cancel_adjacent_inverses_removes_pairs() -> None:
    circuit = Circuit(
        qubits=2,
        ops=[Op(gate="h", targets=[0]), Op(gate="h", targets=[0]), Op(gate="x", targets=[1])],
    )
    out = cancel_adjacent_inverses(circuit)
    assert [o.gate for o in out.ops] == ["x"]
    assert_equivalent(circuit, out, "cancellation")


def test_cancellation_looks_through_independent_gates() -> None:
    """``h(0), x(1), h(0)`` cancels: adjacency is in the dependency graph."""
    circuit = Circuit(
        qubits=2,
        ops=[Op(gate="h", targets=[0]), Op(gate="x", targets=[1]), Op(gate="h", targets=[0])],
    )
    out = cancel_adjacent_inverses(circuit)
    assert [o.gate for o in out.ops] == ["x"]


def test_cancellation_does_not_cross_a_barrier() -> None:
    circuit = Circuit(
        qubits=1,
        ops=[
            Op(gate="h", targets=[0]),
            Op(gate="barrier", targets=[0]),
            Op(gate="h", targets=[0]),
        ],
    )
    out = cancel_adjacent_inverses(circuit)
    assert sum(1 for o in out.ops if o.gate == "h") == 2


def test_drop_trivial_rotations() -> None:
    circuit = Circuit(
        qubits=1,
        ops=[Op(gate="rz", targets=[0], params=[0.0]), Op(gate="rx", targets=[0], params=[0.5])],
    )
    out = drop_trivial_rotations(circuit)
    assert [o.gate for o in out.ops] == ["rx"]


# --------------------------------------------------------------------------
# The full pipeline
# --------------------------------------------------------------------------


@pytest.mark.parametrize("basis", BASES)
@pytest.mark.parametrize("seed", range(5))
def test_transpile_preserves_semantics_without_routing(basis: str, seed: int) -> None:
    circuit = random_circuit(3, 12, random.Random(400 + seed))
    result = transpile(
        circuit, TranspileTarget(basis=basis, layout="none", route=False)
    )
    assert_equivalent(circuit, result.circuit, f"basis={basis} seed={seed}")


@pytest.mark.parametrize("basis", ("ibm", "ion", "u_cx"))
def test_transpiled_circuit_uses_only_its_basis(basis: str) -> None:
    circuit = random_circuit(3, 14, random.Random(11))
    result = transpile(
        circuit, TranspileTarget(basis=basis, layout="none", route=False)
    )
    allowed = set(BASIS_SETS[basis]) | {"barrier", "measure", "reset"}
    used = {o.gate for o in result.circuit.ops}
    assert used <= allowed, f"{basis} left {used - allowed} behind"


@pytest.mark.parametrize("seed", range(8))
def test_routing_preserves_semantics_under_the_layout_permutation(seed: int) -> None:
    """``U_logical == P(final)^dagger . U_physical . P(initial)``.

    A four-qubit line is used so the device is exactly as wide as the circuit
    and the reported layouts are complete; on a wider device the result's
    layouts are truncated to the logical width and the permutation could not be
    reconstructed from them.
    """
    line = [[0, 1], [1, 2], [2, 3]]
    circuit = random_circuit(4, 12, random.Random(500 + seed))
    result = transpile(
        circuit,
        TranspileTarget(basis="ibm", coupling_map=line, layout="trivial", route=True),
    )
    logical = circuit_unitary(circuit)
    physical = circuit_unitary(result.circuit)
    p_initial = permutation_operator(result.initial_layout, 4)
    p_final = permutation_operator(result.final_layout, 4)
    reconstructed = p_final.conj().T @ physical @ p_initial
    assert equal_up_to_global_phase(logical, reconstructed, 1e-8), (
        f"routing changed the operator (seed {seed}, {result.swaps_added} swaps)"
    )


@pytest.mark.parametrize("seed", range(6))
def test_routed_two_qubit_gates_respect_the_coupling_map(seed: int) -> None:
    line = [[0, 1], [1, 2], [2, 3]]
    coupling = CouplingMap.from_pairs(line)
    circuit = random_circuit(4, 12, random.Random(600 + seed))
    result = transpile(
        circuit,
        TranspileTarget(basis="ibm", coupling_map=line, layout="greedy", route=True),
    )
    for op in result.circuit.ops:
        qubits = op.qubits
        if len(qubits) == 2:
            assert coupling.is_adjacent(qubits[0], qubits[1]), (
                f"{op.gate} on {qubits} is not an edge of the device"
            )


@pytest.mark.parametrize("device", DEVICE_NAMES)
def test_transpiling_for_every_device_produces_a_legal_circuit(device: str) -> None:
    """The honest-numbers promise: the lesson quotes these gate counts."""
    from app.noise import device_model

    model = device_model(device)
    coupling = CouplingMap.from_device(device)
    circuit = random_circuit(min(4, model.num_qubits), 10, random.Random(21))
    basis = "ion" if device == "ionq_11" else "ibm"
    result = transpile(circuit, TranspileTarget(basis=basis, device=device))
    for op in result.circuit.ops:
        if len(op.qubits) == 2:
            assert coupling.is_adjacent(*op.qubits), f"{device}: {op.gate} on {op.qubits}"
    assert result.after.size >= 1


def test_transpile_reports_growth_honestly() -> None:
    """A Toffoli-heavy circuit must get bigger, and the report must say so."""
    circuit = Circuit(qubits=3, ops=[Op(gate="ccx", targets=[0, 1, 2])] * 3)
    result = transpile(circuit, TranspileTarget(basis="ibm", layout="none", route=False))
    assert result.before.size == 3
    assert result.after.size > result.before.size
    body = result.to_dict()
    assert body["delta"]["size"] == result.after.size - result.before.size
    assert body["delta"]["twoQubitGates"] > 0


def test_optimisation_level_zero_still_translates_the_basis() -> None:
    circuit = random_circuit(2, 8, random.Random(3))
    result = transpile(
        circuit,
        TranspileTarget(basis="ibm", layout="none", route=False, optimisation_level=0),
    )
    assert_equivalent(circuit, result.circuit, "optimisation level 0")


def test_higher_optimisation_never_makes_it_bigger() -> None:
    circuit = random_circuit(3, 20, random.Random(31))
    sizes = []
    for level in (0, 1, 2, 3):
        result = transpile(
            circuit,
            TranspileTarget(
                basis="ibm", layout="none", route=False, optimisation_level=level
            ),
        )
        assert_equivalent(circuit, result.circuit, f"level {level}")
        sizes.append(result.after.size)
    assert sizes[3] <= sizes[1], f"a deeper sweep grew the circuit: {sizes}"


def test_permutation_operator_is_a_permutation() -> None:
    pi = [2, 0, 3, 1]
    p = permutation_operator(pi, 4)
    assert np.allclose(p @ p.conj().T, np.eye(16))
    assert set(np.argmax(np.abs(p), axis=0).tolist()) == set(range(16))
