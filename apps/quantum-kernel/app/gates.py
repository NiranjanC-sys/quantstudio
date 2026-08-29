"""The gate matrix registry, in NumPy.

CONVENTION, stated once and never violated: **qubit 0 is the MOST significant
bit of a basis index**. For ``n`` qubits, basis state index ``i`` assigns qubit
``q`` the value ``(i >> (n - 1 - q)) & 1``. A two-qubit state ``|q0 q1>`` reads
left to right, matching Nielsen & Chuang, Cirq, PennyLane and the TypeScript
engine in ``packages/qir``.

Qiskit is the odd one out: its basis index puts qubit 0 in the *least*
significant position. ``app/codegen.py`` reverses qubit indices at the Qiskit
boundary, which -- as proven in ``tests/test_cross_backend.py`` -- makes the
amplitude arrays line up index-for-index with no post-hoc reversal of the
vector itself.

Multi-qubit matrices below are therefore written with the FIRST operand as the
most significant bit. ``controlled()`` places controls *above* the base gate's
operands for the same reason: in ``ccx`` the two controls are operands 0 and 1,
so they occupy the two most significant bits and the matrix is block-diagonal
with the base gate in the last block.

This file is a line-for-line port of ``packages/qir/src/gates.ts``; the numeric
tests in ``tests/test_gates.py`` pin the entries that matter.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Literal, Sequence

import numpy as np

Matrix = np.ndarray  # complex128, square, C-contiguous

GateCategory = Literal[
    "pauli",
    "hadamard",
    "phase",
    "rotation",
    "universal",
    "two-qubit",
    "multi",
    "nonunitary",
]

S2 = 1.0 / math.sqrt(2.0)


def _m(rows: Sequence[Sequence[complex]]) -> Matrix:
    """Build a C-contiguous complex128 matrix from nested rows."""
    return np.array(rows, dtype=np.complex128)


def controlled(base: Matrix, num_controls: int) -> Matrix:
    """Add ``num_controls`` positive controls as the MOST significant operands.

    The result is block diagonal: identity on every basis state where at least
    one control is |0>, and ``base`` on the final block where all controls are
    |1>. Because qubit 0 is the most significant bit, "controls first in the
    operand list" and "controls in the high bits" are the same statement.
    """
    if num_controls <= 0:
        return base
    d = base.shape[0]
    dim = d << num_controls
    out = np.eye(dim, dtype=np.complex128)
    out[dim - d :, dim - d :] = base
    return out


def _rot(theta: float, kind: Literal["x", "y", "z"]) -> Matrix:
    """exp(-i*theta/2 * P) for P in {X, Y, Z}."""
    c = math.cos(theta / 2.0)
    s = math.sin(theta / 2.0)
    if kind == "x":
        return _m([[c, -1j * s], [-1j * s, c]])
    if kind == "y":
        return _m([[c, -s], [s, c]])
    return _m(
        [
            [complex(math.cos(-theta / 2.0), math.sin(-theta / 2.0)), 0.0],
            [0.0, complex(math.cos(theta / 2.0), math.sin(theta / 2.0))],
        ]
    )


def _u_mat(theta: float, phi: float, lam: float) -> Matrix:
    """The OpenQASM 3 / Qiskit ``U(theta, phi, lambda)`` convention."""
    c = math.cos(theta / 2.0)
    s = math.sin(theta / 2.0)
    return _m(
        [
            [c, -complex(math.cos(lam), math.sin(lam)) * s],
            [
                complex(math.cos(phi), math.sin(phi)) * s,
                complex(math.cos(phi + lam), math.sin(phi + lam)) * c,
            ],
        ]
    )


def _pauli_rot2(theta: float, pp: Literal["xx", "yy", "zz", "zx"]) -> Matrix:
    """exp(-i*theta/2 * A tensor B) for the two-qubit Pauli products we support.

    Written out explicitly rather than via ``expm`` so that the entries are
    exact trigonometric values and the port from TypeScript is auditable.
    """
    c = math.cos(theta / 2.0)
    s = math.sin(theta / 2.0)
    m = np.zeros((4, 4), dtype=np.complex128)
    for i in range(4):
        m[i, i] = c
    if pp == "xx":
        m[0, 3] = m[1, 2] = m[2, 1] = m[3, 0] = -1j * s
    elif pp == "yy":
        m[0, 3] = m[3, 0] = 1j * s
        m[1, 2] = m[2, 1] = -1j * s
    elif pp == "zz":
        m[0, 0] = m[3, 3] = complex(c, -s)
        m[1, 1] = m[2, 2] = complex(c, s)
    else:  # "zx": exp(-i theta/2 Z tensor X)
        m[0, 1] = m[1, 0] = -1j * s
        m[2, 3] = m[3, 2] = 1j * s
    return m


def _perm(n: int, mapping: Sequence[int]) -> Matrix:
    """Permutation matrix where ``mapping[col]`` is the row carrying the 1."""
    m = np.zeros((n, n), dtype=np.complex128)
    for col, row in enumerate(mapping):
        m[row, col] = 1.0
    return m


@dataclass(frozen=True)
class ControlledForm:
    """How a controlled alias rewrites into a base gate plus implicit controls.

    ``controls == -1`` means "variadic": the op carries its own control list
    (this is ``mcx``), so the number cannot be baked into the definition.
    """

    base: str
    controls: int


@dataclass(frozen=True)
class InverseForm:
    gate: str
    params: Callable[[Sequence[float]], list[float]] | None = None


@dataclass(frozen=True)
class GateDef:
    key: str
    name: str
    glyph: str
    #: Qubits the *definition* acts on. Controls carried by an Op are extra.
    arity: int
    param_names: tuple[str, ...]
    category: GateCategory
    #: Preserves the Pauli group under conjugation.
    clifford: bool
    description: str
    matrix: Callable[[Sequence[float]], Matrix] | None = None
    controlled_form: ControlledForm | None = None
    inverse: InverseForm | None = None
    #: Native OpenQASM 3 name when it differs from ``key``.
    qasm_name: str | None = None

    @property
    def unitary(self) -> bool:
        return self.category != "nonunitary"


def _const(mat: Matrix) -> Callable[[Sequence[float]], Matrix]:
    """Wrap a constant matrix as a parameterless matrix factory."""
    frozen = mat.copy()
    frozen.setflags(write=False)

    def factory(_p: Sequence[float]) -> Matrix:
        return frozen

    return factory


_I2 = _m([[1, 0], [0, 1]])
_X = _m([[0, 1], [1, 0]])
_Y = _m([[0, -1j], [1j, 0]])
_Z = _m([[1, 0], [0, -1]])
_H = _m([[S2, S2], [S2, -S2]])
_S = _m([[1, 0], [0, 1j]])
_SDG = _m([[1, 0], [0, -1j]])
_T = _m([[1, 0], [0, complex(S2, S2)]])
_TDG = _m([[1, 0], [0, complex(S2, -S2)]])
_SX = _m([[complex(0.5, 0.5), complex(0.5, -0.5)], [complex(0.5, -0.5), complex(0.5, 0.5)]])
_SXDG = _m([[complex(0.5, -0.5), complex(0.5, 0.5)], [complex(0.5, 0.5), complex(0.5, -0.5)]])
_SWAP = _perm(4, [0, 2, 1, 3])
_ISWAP = _m([[1, 0, 0, 0], [0, 0, 1j, 0], [0, 1j, 0, 0], [0, 0, 0, 1]])
_ECR = _m(
    [
        [0, 0, S2, 1j * S2],
        [0, 0, 1j * S2, S2],
        [S2, -1j * S2, 0, 0],
        [-1j * S2, S2, 0, 0],
    ]
)
_CX = _perm(4, [0, 1, 3, 2])
_CZ = np.diag(np.array([1, 1, 1, -1], dtype=np.complex128))
_CCX = _perm(8, [0, 1, 2, 3, 4, 5, 7, 6])
_CSWAP = _perm(8, [0, 1, 2, 3, 4, 6, 5, 7])


def _neg0(p: Sequence[float]) -> list[float]:
    return [-p[0]]


GATES: dict[str, GateDef] = {}


def _reg(g: GateDef) -> None:
    GATES[g.key] = g


# ---- single qubit, non-parametric ---------------------------------------
_reg(GateDef("id", "Identity", "I", 1, (), "pauli", True,
             "Does nothing. Useful as an explicit delay.",
             matrix=_const(_I2), inverse=InverseForm("id")))
_reg(GateDef("x", "Pauli X", "X", 1, (), "pauli", True,
             "Bit flip. A pi rotation about the x axis of the Bloch sphere.",
             matrix=_const(_X), inverse=InverseForm("x")))
_reg(GateDef("y", "Pauli Y", "Y", 1, (), "pauli", True,
             "Bit and phase flip together. A pi rotation about y.",
             matrix=_const(_Y), inverse=InverseForm("y")))
_reg(GateDef("z", "Pauli Z", "Z", 1, (), "pauli", True,
             "Phase flip. Leaves |0> alone and negates |1>.",
             matrix=_const(_Z), inverse=InverseForm("z")))
_reg(GateDef("h", "Hadamard", "H", 1, (), "hadamard", True,
             "Maps the computational basis to the x basis. The source of superposition.",
             matrix=_const(_H), inverse=InverseForm("h")))
_reg(GateDef("s", "S", "S", 1, (), "phase", True,
             "Quarter turn about z. Square root of Z.",
             matrix=_const(_S), inverse=InverseForm("sdg")))
_reg(GateDef("sdg", "S dagger", "S†", 1, (), "phase", True,
             "Inverse of S.",
             matrix=_const(_SDG), inverse=InverseForm("s")))
_reg(GateDef("t", "T", "T", 1, (), "phase", False,
             "Eighth turn about z. The non-Clifford gate that makes universality "
             "possible, and the expensive one under error correction.",
             matrix=_const(_T), inverse=InverseForm("tdg")))
_reg(GateDef("tdg", "T dagger", "T†", 1, (), "phase", False,
             "Inverse of T.",
             matrix=_const(_TDG), inverse=InverseForm("t")))
_reg(GateDef("sx", "Square root of X", "√X", 1, (), "rotation", True,
             "Half turn about x. A native basis gate on IBM superconducting hardware.",
             matrix=_const(_SX), inverse=InverseForm("sxdg")))
_reg(GateDef("sxdg", "Inverse root X", "√X†", 1, (), "rotation", True,
             "Inverse of the square root of X.",
             matrix=_const(_SXDG), inverse=InverseForm("sx")))

# ---- single qubit, parametric -------------------------------------------
_reg(GateDef("rx", "Rx", "Rx", 1, ("theta",), "rotation", False,
             "Rotation by theta about the x axis.",
             matrix=lambda p: _rot(p[0], "x"), inverse=InverseForm("rx", _neg0)))
_reg(GateDef("ry", "Ry", "Ry", 1, ("theta",), "rotation", False,
             "Rotation by theta about the y axis.",
             matrix=lambda p: _rot(p[0], "y"), inverse=InverseForm("ry", _neg0)))
_reg(GateDef("rz", "Rz", "Rz", 1, ("theta",), "rotation", False,
             "Rotation by theta about z. On real hardware this is often free, done "
             "in software by shifting a phase.",
             matrix=lambda p: _rot(p[0], "z"), inverse=InverseForm("rz", _neg0)))
_reg(GateDef("p", "Phase", "P", 1, ("lambda",), "phase", False,
             "Adds a relative phase to |1>. Rz up to a global phase.",
             matrix=lambda p: _m([[1, 0], [0, complex(math.cos(p[0]), math.sin(p[0]))]]),
             inverse=InverseForm("p", _neg0), qasm_name="p"))
_reg(GateDef("u", "General unitary", "U", 1, ("theta", "phi", "lambda"), "universal", False,
             "Any single-qubit unitary, up to a global phase.",
             matrix=lambda p: _u_mat(p[0], p[1], p[2]),
             inverse=InverseForm("u", lambda p: [-p[0], -p[2], -p[1]]),
             qasm_name="U"))

# ---- two qubit, non-controlled ------------------------------------------
_reg(GateDef("swap", "Swap", "SWAP", 2, (), "two-qubit", True,
             "Exchanges two qubits. Costs three CNOTs, which is why routing is expensive.",
             matrix=_const(_SWAP), inverse=InverseForm("swap")))
_reg(GateDef("iswap", "iSwap", "iSWAP", 2, (), "two-qubit", False,
             "Swap with an i phase on the exchanged amplitudes. Native on some "
             "superconducting devices.",
             matrix=_const(_ISWAP)))
_reg(GateDef("rxx", "Rxx", "Rxx", 2, ("theta",), "two-qubit", False,
             "exp(-i theta/2 X(x)X). The native two-qubit interaction on trapped-ion hardware.",
             matrix=lambda p: _pauli_rot2(p[0], "xx"), inverse=InverseForm("rxx", _neg0)))
_reg(GateDef("ryy", "Ryy", "Ryy", 2, ("theta",), "two-qubit", False,
             "exp(-i theta/2 Y(x)Y).",
             matrix=lambda p: _pauli_rot2(p[0], "yy"), inverse=InverseForm("ryy", _neg0)))
_reg(GateDef("rzz", "Rzz", "Rzz", 2, ("theta",), "two-qubit", False,
             "exp(-i theta/2 Z(x)Z). The workhorse of QAOA cost layers.",
             matrix=lambda p: _pauli_rot2(p[0], "zz"), inverse=InverseForm("rzz", _neg0)))
_reg(GateDef("rzx", "Rzx", "Rzx", 2, ("theta",), "two-qubit", False,
             "exp(-i theta/2 Z(x)X). The cross-resonance interaction underneath IBM "
             "two-qubit gates.",
             matrix=lambda p: _pauli_rot2(p[0], "zx"), inverse=InverseForm("rzx", _neg0)))
_reg(GateDef("ecr", "Echoed cross-resonance", "ECR", 2, (), "two-qubit", True,
             "An IBM hardware basis gate. Locally equivalent to CNOT.",
             matrix=_const(_ECR), inverse=InverseForm("ecr")))

# ---- controlled aliases -------------------------------------------------
_reg(GateDef("cx", "CNOT", "X", 2, (), "two-qubit", True,
             "Flips the target when the control is |1>. Together with single-qubit "
             "gates it is universal.",
             matrix=_const(_CX), controlled_form=ControlledForm("x", 1),
             inverse=InverseForm("cx")))
_reg(GateDef("cy", "Controlled Y", "Y", 2, (), "two-qubit", True,
             "Y on the target, conditioned on the control.",
             matrix=_const(controlled(_Y, 1)), controlled_form=ControlledForm("y", 1),
             inverse=InverseForm("cy")))
_reg(GateDef("cz", "Controlled Z", "Z", 2, (), "two-qubit", True,
             "Negates the |11> amplitude. Symmetric in its two qubits.",
             matrix=_const(_CZ), controlled_form=ControlledForm("z", 1),
             inverse=InverseForm("cz")))
_reg(GateDef("ch", "Controlled H", "H", 2, (), "two-qubit", False,
             "Hadamard on the target, conditioned on the control.",
             matrix=_const(controlled(_H, 1)), controlled_form=ControlledForm("h", 1),
             inverse=InverseForm("ch")))
_reg(GateDef("cs", "Controlled S", "S", 2, (), "two-qubit", False,
             "S on the target, conditioned on the control.",
             matrix=_const(controlled(_S, 1)), controlled_form=ControlledForm("s", 1),
             inverse=InverseForm("csdg")))
_reg(GateDef("csdg", "Controlled S dagger", "S†", 2, (), "two-qubit", False,
             "Inverse controlled S.",
             matrix=_const(controlled(_SDG, 1)), controlled_form=ControlledForm("sdg", 1),
             inverse=InverseForm("cs")))
_reg(GateDef("csx", "Controlled root X", "√X", 2, (), "two-qubit", False,
             "Square root of X on the target, conditioned on the control.",
             matrix=_const(controlled(_SX, 1)), controlled_form=ControlledForm("sx", 1)))
_reg(GateDef("cp", "Controlled phase", "P", 2, ("lambda",), "two-qubit", False,
             "The building block of the quantum Fourier transform.",
             matrix=lambda p: controlled(
                 _m([[1, 0], [0, complex(math.cos(p[0]), math.sin(p[0]))]]), 1),
             controlled_form=ControlledForm("p", 1), inverse=InverseForm("cp", _neg0)))
_reg(GateDef("crx", "Controlled Rx", "Rx", 2, ("theta",), "two-qubit", False,
             "Rx on the target, conditioned on the control.",
             matrix=lambda p: controlled(_rot(p[0], "x"), 1),
             controlled_form=ControlledForm("rx", 1), inverse=InverseForm("crx", _neg0)))
_reg(GateDef("cry", "Controlled Ry", "Ry", 2, ("theta",), "two-qubit", False,
             "Ry on the target, conditioned on the control. Common in amplitude encoding.",
             matrix=lambda p: controlled(_rot(p[0], "y"), 1),
             controlled_form=ControlledForm("ry", 1), inverse=InverseForm("cry", _neg0)))
_reg(GateDef("crz", "Controlled Rz", "Rz", 2, ("theta",), "two-qubit", False,
             "Rz on the target, conditioned on the control.",
             matrix=lambda p: controlled(_rot(p[0], "z"), 1),
             controlled_form=ControlledForm("rz", 1), inverse=InverseForm("crz", _neg0)))
_reg(GateDef("cu", "Controlled U", "U", 2, ("theta", "phi", "lambda"), "two-qubit", False,
             "An arbitrary single-qubit unitary, conditioned on the control.",
             matrix=lambda p: controlled(_u_mat(p[0], p[1], p[2]), 1),
             controlled_form=ControlledForm("u", 1)))
_reg(GateDef("ccx", "Toffoli", "X", 3, (), "multi", False,
             "Universal for classical reversible computation. Costs six CNOTs to decompose.",
             matrix=_const(_CCX), controlled_form=ControlledForm("x", 2),
             inverse=InverseForm("ccx")))
_reg(GateDef("ccz", "CCZ", "Z", 3, (), "multi", False,
             "Negates only the |111> amplitude.",
             matrix=_const(controlled(_Z, 2)), controlled_form=ControlledForm("z", 2),
             inverse=InverseForm("ccz")))
_reg(GateDef("cswap", "Fredkin", "SWAP", 3, (), "multi", False,
             "Swaps two qubits when the control is set. Used in the swap test.",
             matrix=_const(_CSWAP), controlled_form=ControlledForm("swap", 1),
             inverse=InverseForm("cswap")))
_reg(GateDef("mcx", "Multi-controlled X", "X", 1, (), "multi", False,
             "X with any number of controls. The controls live in the op, not the definition.",
             controlled_form=ControlledForm("x", -1), inverse=InverseForm("mcx")))

# ---- non-unitary --------------------------------------------------------
_reg(GateDef("measure", "Measure", "M", 1, (), "nonunitary", False,
             "Projective measurement in the computational basis, recording the "
             "outcome in a classical bit."))
_reg(GateDef("reset", "Reset", "|0>", 1, (), "nonunitary", False,
             "Forces the qubit to |0>. Physically a measurement plus a conditional flip."))
_reg(GateDef("barrier", "Barrier", "‖", 1, (), "nonunitary", True,
             "A compiler fence. No physical effect; stops optimisation across it."))

GATE_KEYS: tuple[str, ...] = tuple(GATES.keys())

#: Gates whose square is the identity, so two adjacent copies cancel.
SELF_INVERSE: frozenset[str] = frozenset(
    {"id", "x", "y", "z", "h", "cx", "cy", "cz", "ch", "swap", "ccx", "ccz", "cswap", "ecr", "mcx"}
)


class UnknownGate(KeyError):
    """Raised when an IR op names a gate that is not in the registry."""


def gate(key: str) -> GateDef:
    """Look up a gate definition, failing loudly on a typo."""
    try:
        return GATES[key]
    except KeyError:
        raise UnknownGate(f"unknown gate {key!r}") from None


def is_unitary_gate(key: str) -> bool:
    return key in GATES and GATES[key].category != "nonunitary"


def base_form(gate_key: str, targets: Sequence[int], controls: Sequence[int]
              ) -> tuple[str, list[int], list[int]]:
    """Rewrite a controlled alias into ``(base gate, targets, controls)``.

    ``cx q0,q1`` becomes ``("x", [q1], [q0])``; ``ccx a,b,c`` becomes
    ``("x", [c], [a, b])``; ``mcx`` keeps whatever control list the op carries.
    One code path for cx, ccx and mcx alike is worth the indirection.
    """
    d = GATES.get(gate_key)
    if d is None or d.controlled_form is None:
        return gate_key, list(targets), list(controls)
    nc = d.controlled_form.controls
    if nc < 0:
        return d.controlled_form.base, list(targets), list(controls)
    merged = list(controls) + list(targets[:nc])
    return d.controlled_form.base, list(targets[nc:]), sorted(merged)


def op_matrix(gate_key: str, params: Sequence[float]) -> Matrix:
    """The matrix of a gate as declared, i.e. *including* its alias controls.

    ``op_matrix("cx", [])`` is 4x4. For ``mcx`` the control count is not known
    from the key alone, so this raises; use :func:`base_form` and apply the
    base matrix with explicit controls instead.
    """
    d = gate(gate_key)
    if d.matrix is None:
        raise UnknownGate(
            f"gate {gate_key!r} has no intrinsic matrix "
            f"({'variadic controls' if d.controlled_form else 'non-unitary'})"
        )
    return d.matrix(tuple(params))


def is_unitary_matrix(m: Matrix, tol: float = 1e-12) -> bool:
    """True when ``m @ m.conj().T`` is the identity to within ``tol``."""
    d = m.shape[0]
    return bool(np.allclose(m @ m.conj().T, np.eye(d), atol=tol))


#: Gates grouped for the builder's palette, in teaching order.
PALETTE: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Pauli", ("x", "y", "z", "id")),
    ("Superposition", ("h", "sx", "sxdg")),
    ("Phase", ("s", "sdg", "t", "tdg", "p")),
    ("Rotation", ("rx", "ry", "rz", "u")),
    ("Controlled", ("cx", "cy", "cz", "ch", "cp", "crx", "cry", "crz", "cu", "cs", "csdg", "csx")),
    ("Two qubit", ("swap", "iswap", "rxx", "ryy", "rzz", "rzx", "ecr")),
    ("Three qubit", ("ccx", "ccz", "cswap", "mcx")),
    ("Non unitary", ("measure", "reset", "barrier")),
)
