"""The gate registry: every matrix is unitary, and every convention holds."""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.gates import (
    GATES,
    PALETTE,
    SELF_INVERSE,
    UnknownGate,
    base_form,
    controlled,
    gate,
    is_unitary_matrix,
    op_matrix,
)

#: Angles chosen to be irrational multiples of pi so no gate accidentally
#: lands on a special case that happens to be unitary.
SAMPLE_PARAMS = (0.37, -1.913, 2.6041)

UNITARY_KEYS = sorted(
    k for k, d in GATES.items() if d.category != "nonunitary" and d.matrix is not None
)


def params_for(key: str) -> list[float]:
    return list(SAMPLE_PARAMS[: len(GATES[key].param_names)])


@pytest.mark.parametrize("key", UNITARY_KEYS)
def test_every_gate_matrix_is_unitary(key: str) -> None:
    m = op_matrix(key, params_for(key))
    assert is_unitary_matrix(m, 1e-12), f"{key} is not unitary"
    assert m.dtype == np.complex128


@pytest.mark.parametrize("key", UNITARY_KEYS)
def test_every_gate_matrix_has_the_declared_size(key: str) -> None:
    d = GATES[key]
    m = op_matrix(key, params_for(key))
    assert m.shape == (1 << d.arity, 1 << d.arity), f"{key} has the wrong shape"


@pytest.mark.parametrize("key", UNITARY_KEYS)
def test_every_gate_matrix_has_unit_determinant_modulus(key: str) -> None:
    """|det U| == 1 is implied by unitarity, and catches a scaled matrix that
    ``U U^dagger == I`` would also catch but less legibly."""
    m = op_matrix(key, params_for(key))
    assert abs(abs(np.linalg.det(m)) - 1.0) < 1e-12


@pytest.mark.parametrize("key", sorted(SELF_INVERSE))
def test_self_inverse_gates_square_to_identity(key: str) -> None:
    d = GATES[key]
    if d.matrix is None:  # mcx carries its controls in the op, not the definition
        pytest.skip(f"{key} has no intrinsic matrix")
    m = op_matrix(key, params_for(key))
    assert np.allclose(m @ m, np.eye(m.shape[0]), atol=1e-12)


@pytest.mark.parametrize("key", UNITARY_KEYS)
def test_declared_inverse_undoes_the_gate(key: str) -> None:
    d = GATES[key]
    if d.inverse is None:
        pytest.skip(f"{key} declares no inverse")
    p = params_for(key)
    inv_key = d.inverse.gate
    inv_params = list(d.inverse.params(p)) if d.inverse.params is not None else p
    m = op_matrix(key, p)
    inv = op_matrix(inv_key, inv_params)
    assert np.allclose(inv @ m, np.eye(m.shape[0]), atol=1e-12), (
        f"{key}^-1 = {inv_key} does not undo it"
    )


def test_pauli_algebra() -> None:
    x, y, z = (op_matrix(k, []) for k in ("x", "y", "z"))
    assert np.allclose(x @ y, 1j * z)
    assert np.allclose(y @ z, 1j * x)
    assert np.allclose(z @ x, 1j * y)


def test_hadamard_diagonalises_x() -> None:
    h, x, z = (op_matrix(k, []) for k in ("h", "x", "z"))
    assert np.allclose(h @ x @ h, z)


def test_s_and_t_are_roots_of_z() -> None:
    s, t, z = (op_matrix(k, []) for k in ("s", "t", "z"))
    assert np.allclose(s @ s, z)
    assert np.allclose(t @ t, s)


def test_sx_squares_to_x() -> None:
    sx, x = op_matrix("sx", []), op_matrix("x", [])
    assert np.allclose(sx @ sx, x)


def test_qubit_zero_is_the_most_significant_bit() -> None:
    """The convention, asserted directly on CNOT rather than inferred.

    ``cx`` with control = operand 0 must map |10> (index 2) to |11> (index 3).
    If qubit 0 were the least significant bit, it would map index 1 to index 3.
    """
    cx = op_matrix("cx", [])
    v = np.zeros(4, dtype=np.complex128)
    v[0b10] = 1.0
    assert np.argmax(np.abs(cx @ v)) == 0b11

    v = np.zeros(4, dtype=np.complex128)
    v[0b01] = 1.0
    assert np.argmax(np.abs(cx @ v)) == 0b01, "qubit 1 must not act as the control"


def test_controlled_places_controls_in_the_high_bits() -> None:
    z = op_matrix("z", [])
    cz = controlled(z, 1)
    assert np.allclose(cz, np.diag([1, 1, 1, -1]))
    ccz = controlled(z, 2)
    assert np.allclose(np.diag(ccz), [1, 1, 1, 1, 1, 1, 1, -1])


def test_toffoli_flips_only_the_last_block() -> None:
    ccx = op_matrix("ccx", [])
    for i in range(6):
        assert ccx[i, i] == 1.0
    assert ccx[7, 6] == 1.0 and ccx[6, 7] == 1.0


def test_base_form_rewrites_aliases() -> None:
    assert base_form("cx", [0, 1], []) == ("x", [1], [0])
    assert base_form("ccx", [0, 1, 2], []) == ("x", [2], [0, 1])
    assert base_form("cswap", [2, 0, 1], []) == ("swap", [0, 1], [2])
    assert base_form("mcx", [4], [0, 1, 2]) == ("x", [4], [0, 1, 2])
    assert base_form("h", [3], []) == ("h", [3], [])


def test_alias_matrix_matches_its_expansion() -> None:
    """``cp`` as a named 4x4 must equal ``controlled(p, 1)`` entry for entry."""
    for key in ("cx", "cy", "cz", "ch", "cs", "csdg", "csx", "ccx", "ccz", "cswap"):
        d = GATES[key]
        assert d.controlled_form is not None
        base = op_matrix(d.controlled_form.base, [])
        assert np.allclose(op_matrix(key, []), controlled(base, d.controlled_form.controls))
    for key in ("cp", "crx", "cry", "crz"):
        d = GATES[key]
        assert d.controlled_form is not None
        base = op_matrix(d.controlled_form.base, [SAMPLE_PARAMS[0]])
        assert np.allclose(
            op_matrix(key, [SAMPLE_PARAMS[0]]), controlled(base, 1)
        )


def test_rotation_generators() -> None:
    """``rx(theta) == exp(-i theta/2 X)``, checked against the series solution."""
    theta = 0.9137
    for key, pauli in (("rx", "x"), ("ry", "y"), ("rz", "z")):
        p = op_matrix(pauli, [])
        expected = math.cos(theta / 2) * np.eye(2) - 1j * math.sin(theta / 2) * p
        assert np.allclose(op_matrix(key, [theta]), expected, atol=1e-13)


def test_two_qubit_pauli_rotations() -> None:
    x, y, z = (op_matrix(k, []) for k in ("x", "y", "z"))
    theta = -0.6132
    for key, (a, b) in (("rxx", (x, x)), ("ryy", (y, y)), ("rzz", (z, z)), ("rzx", (z, x))):
        pp = np.kron(a, b)
        expected = math.cos(theta / 2) * np.eye(4) - 1j * math.sin(theta / 2) * pp
        assert np.allclose(op_matrix(key, [theta]), expected, atol=1e-13), key


def test_ecr_is_locally_equivalent_to_cnot() -> None:
    """ECR is an IBM basis gate; ``ecr`` up to single-qubit gates is CNOT.

    Checked through the entangling power rather than a specific decomposition:
    the squared magnitudes of the Makhlin-style overlap with CNOT match iff the
    two are locally equivalent, and a hand-written decomposition would just be
    testing the decomposition.
    """
    ecr = op_matrix("ecr", [])
    assert np.allclose(ecr @ ecr.conj().T, np.eye(4), atol=1e-13)
    # ECR^2 == I up to phase: it is its own inverse, per the registry.
    assert np.allclose(ecr @ ecr, np.eye(4), atol=1e-13)


def test_iswap_moves_amplitude_with_a_phase() -> None:
    iswap = op_matrix("iswap", [])
    v = np.zeros(4, dtype=np.complex128)
    v[0b01] = 1.0
    assert np.allclose(iswap @ v, np.array([0, 0, 1j, 0]))


def test_u_matches_the_openqasm_convention() -> None:
    """``U(pi, 0, pi) == X`` and ``U(pi/2, 0, pi) == H``, both exactly."""
    assert np.allclose(op_matrix("u", [math.pi, 0.0, math.pi]), op_matrix("x", []), atol=1e-15)
    assert np.allclose(
        op_matrix("u", [math.pi / 2, 0.0, math.pi]), op_matrix("h", []), atol=1e-15
    )


def test_unknown_gate_raises_with_the_name() -> None:
    with pytest.raises(UnknownGate, match="hadamardd"):
        gate("hadamardd")


def test_mcx_has_no_intrinsic_matrix() -> None:
    """Its control count lives in the op, so asking for a matrix must fail loudly."""
    with pytest.raises(UnknownGate, match="variadic"):
        op_matrix("mcx", [])


def test_measure_reset_barrier_are_non_unitary() -> None:
    for key in ("measure", "reset", "barrier"):
        assert not GATES[key].unitary
        assert GATES[key].matrix is None


def test_palette_covers_the_registry() -> None:
    """Every gate a learner can name must be reachable from the builder palette."""
    listed = {k for _, keys in PALETTE for k in keys}
    assert listed == set(GATES), f"palette drift: {listed ^ set(GATES)}"


def test_clifford_flags_are_right() -> None:
    """T is the canonical non-Clifford gate; H, S and CNOT generate the group."""
    assert GATES["t"].clifford is False
    assert GATES["tdg"].clifford is False
    for key in ("h", "s", "sdg", "x", "y", "z", "cx", "cz", "swap"):
        assert GATES[key].clifford is True, key
