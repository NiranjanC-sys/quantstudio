"""Shared fixtures and the textbook circuits the algorithm tests assert on.

Every builder here writes the IR the way a lesson would, under the project
convention that **qubit 0 is the most significant bit of a basis index**. That
matters most in :func:`qft`: the textbook circuit (Hadamard on the most
significant qubit first, controlled phases from the less significant ones, a
final reversal) produces the DFT matrix *exactly* under this convention, with no
transposition and no conjugation, which is the whole reason the convention was
chosen.
"""

from __future__ import annotations

import math
from typing import Iterable, Sequence

import numpy as np
import pytest

from app import backends as registry
from app.backends.base import SimOptions
from app.ir import Circuit, ClassicalCondition, Op

S2 = 1.0 / math.sqrt(2.0)


# --------------------------------------------------------------------------
# Construction helpers
# --------------------------------------------------------------------------


def op(
    gate: str,
    targets: Sequence[int],
    params: Sequence[float] | None = None,
    controls: Sequence[int] | None = None,
    cbits: Sequence[int] | None = None,
    condition: ClassicalCondition | None = None,
) -> Op:
    return Op(
        gate=gate,
        targets=list(targets),
        params=[float(p) for p in (params or [])],
        controls=list(controls or []),
        cbits=list(cbits or []),
        condition=condition,
    )


def statevector(circuit: Circuit, backend: str = "native", **options: object) -> np.ndarray:
    """Exact final amplitudes, measurements deferred."""
    opts = SimOptions(shots=0, return_bloch=False, max_qubits=32, **options)  # type: ignore[arg-type]
    result = registry.get(backend).run(circuit, opts)
    assert result.statevector is not None
    return result.statevector


def probabilities(circuit: Circuit, backend: str = "native", **options: object) -> np.ndarray:
    opts = SimOptions(shots=0, return_bloch=False, max_qubits=32, **options)  # type: ignore[arg-type]
    return registry.get(backend).run(circuit, opts).probabilities


def marginal(probs: np.ndarray, n: int, keep: Sequence[int]) -> np.ndarray:
    """Marginal distribution over ``keep``, in big-endian order within ``keep``."""
    keep = list(keep)
    out = np.zeros(1 << len(keep), dtype=np.float64)
    for i, p in enumerate(probs):
        idx = 0
        for pos, q in enumerate(keep):
            bit = (i >> (n - 1 - q)) & 1
            idx |= bit << (len(keep) - 1 - pos)
        out[idx] += p
    return out


# --------------------------------------------------------------------------
# The canonical circuits
# --------------------------------------------------------------------------


def bell() -> Circuit:
    """``(|00> + |11>)/sqrt(2)``."""
    return Circuit(
        qubits=2,
        clbits=2,
        name="bell",
        ops=[op("h", [0]), op("x", [1], controls=[0])],
    )


def ghz(n: int = 3) -> Circuit:
    """``(|0...0> + |1...1>)/sqrt(2)``, built as a CNOT ladder."""
    ops = [op("h", [0])]
    ops += [op("cx", [q, q + 1]) for q in range(n - 1)]
    return Circuit(qubits=n, name=f"ghz{n}", ops=ops)


def w_state() -> Circuit:
    """``(|100> + |010> + |001>)/sqrt(3)``.

    Built by moving one excitation down the register with controlled rotations:
    the first sends 2/3 of the amplitude from qubit 0 to qubit 1, the second
    splits what arrived evenly between qubits 1 and 2. Each ``cry`` is followed
    by a ``cx`` that clears the qubit the excitation just left, which is what
    keeps the state a single-excitation superposition rather than a product.
    """
    theta = 2.0 * math.asin(math.sqrt(2.0 / 3.0))
    return Circuit(
        qubits=3,
        name="w",
        ops=[
            op("x", [0]),
            op("cry", [0, 1], [theta]),
            op("cx", [1, 0]),
            op("cry", [1, 2], [math.pi / 2.0]),
            op("cx", [2, 1]),
        ],
    )


def qft(n: int, with_swaps: bool = True) -> Circuit:
    """The textbook QFT. Equals the DFT matrix exactly under our convention."""
    ops: list[Op] = []
    for j in range(n):
        ops.append(op("h", [j]))
        for k in range(j + 1, n):
            ops.append(op("cp", [k, j], [math.pi / 2 ** (k - j)]))
    if with_swaps:
        for i in range(n // 2):
            ops.append(op("swap", [i, n - 1 - i]))
    return Circuit(qubits=n, name=f"qft{n}", ops=ops)


def dft_matrix(n: int) -> np.ndarray:
    """``F[k][j] = exp(2 pi i j k / N) / sqrt(N)``."""
    dim = 1 << n
    j, k = np.meshgrid(np.arange(dim), np.arange(dim))
    return np.exp(2j * np.pi * j * k / dim) / math.sqrt(dim)


def grover(n: int, marked: int, iterations: int) -> Circuit:
    """Grover search over ``n`` qubits for one marked basis state.

    The oracle is a phase flip built from X gates around a ``ccz``; the
    diffusion operator is the same trick conjugated by Hadamards. Only ``n = 3``
    is exercised, which is why ``ccz`` is hard-coded rather than generalised to
    ``mcx``.
    """
    if n != 3:
        raise ValueError("this teaching implementation is written for n = 3")
    bits = [int(b) for b in format(marked, f"0{n}b")]
    ops = [op("h", [q]) for q in range(n)]
    for _ in range(iterations):
        for q, b in enumerate(bits):
            if b == 0:
                ops.append(op("x", [q]))
        ops.append(op("ccz", [0, 1, 2]))
        for q, b in enumerate(bits):
            if b == 0:
                ops.append(op("x", [q]))
        ops += [op("h", [q]) for q in range(n)]
        ops += [op("x", [q]) for q in range(n)]
        ops.append(op("ccz", [0, 1, 2]))
        ops += [op("x", [q]) for q in range(n)]
        ops += [op("h", [q]) for q in range(n)]
    return Circuit(qubits=n, name="grover", ops=ops)


def grover_optimal_iterations(n: int) -> int:
    """``floor(pi/4 * sqrt(N))`` -- 2 for n = 3, giving p ~ 0.945.

    Note the floor. The often-quoted ``round`` gives 2 here as well, but for
    n = 5 it gives 5 where the floor gives 4, and the floor is the value that
    never overshoots the first amplitude peak.
    """
    return math.floor(math.pi / 4.0 * math.sqrt(1 << n))


def teleportation(theta: float, phi: float, lam: float) -> Circuit:
    """Teleport ``U(theta, phi, lambda)|0>`` from qubit 0 to qubit 2.

    Uses real mid-circuit measurement and real classical conditions -- not the
    deferred-measurement rewrite -- because reproducing the input on *every*
    branch is the property worth testing.
    """
    return Circuit(
        qubits=3,
        clbits=2,
        name="teleport",
        ops=[
            op("u", [0], [theta, phi, lam]),
            op("h", [1]),
            op("cx", [1, 2]),
            op("cx", [0, 1]),
            op("h", [0]),
            op("measure", [0], cbits=[0]),
            op("measure", [1], cbits=[1]),
            op("x", [2], condition=ClassicalCondition(bits=[1], value=1)),
            op("z", [2], condition=ClassicalCondition(bits=[0], value=1)),
        ],
    )


def deutsch_jozsa(n: int, kind: str) -> Circuit:
    """Deutsch-Jozsa over ``n`` input qubits plus one phase-kickback ancilla."""
    ops = [op("x", [n])] + [op("h", [q]) for q in range(n + 1)]
    if kind == "balanced":
        ops += [op("cx", [q, n]) for q in range(n)]
    elif kind == "constant_one":
        ops.append(op("x", [n]))
    elif kind != "constant_zero":
        raise ValueError(f"unknown oracle kind {kind!r}")
    ops += [op("h", [q]) for q in range(n)]
    return Circuit(qubits=n + 1, clbits=n, name=f"dj-{kind}", ops=ops)


def bernstein_vazirani(secret: int, n: int) -> Circuit:
    """Recover ``secret`` in one query. Bit ``q`` of the secret is ``s >> (n-1-q)``."""
    ops = [op("x", [n])] + [op("h", [q]) for q in range(n + 1)]
    ops += [op("cx", [q, n]) for q in range(n) if (secret >> (n - 1 - q)) & 1]
    ops += [op("h", [q]) for q in range(n)]
    return Circuit(qubits=n + 1, clbits=n, name="bv", ops=ops)


def simon(secret: int, n: int) -> Circuit:
    """Simon's algorithm on ``2n`` qubits for a period ``secret != 0``.

    The oracle copies the input to the output register, then adds ``secret``
    to the output whenever the input's leading secret-bit is set. That makes
    ``f`` exactly two-to-one with ``f(x) == f(x ^ secret)``, so every input
    string that survives interference is orthogonal to the secret over GF(2).
    """
    if secret == 0:
        raise ValueError("Simon's promise requires a non-zero period")
    ops = [op("h", [q]) for q in range(n)]
    ops += [op("cx", [q, n + q]) for q in range(n)]
    lead = next(q for q in range(n) if (secret >> (n - 1 - q)) & 1)
    ops += [op("cx", [lead, n + q]) for q in range(n) if (secret >> (n - 1 - q)) & 1]
    ops += [op("h", [q]) for q in range(n)]
    return Circuit(qubits=2 * n, name="simon", ops=ops)


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


@pytest.fixture(scope="session")
def available_backends() -> list[str]:
    """Names of the backends this pod actually has. Never empty: native always is."""
    names = list(registry.available_names())
    assert "native" in names, "the native NumPy backend must always be available"
    return names


def require_backend(name: str) -> None:
    """Skip -- never fail -- when an optional SDK is missing.

    A pod built without the heavy wheels is a supported configuration, so a
    test that needs Cirq must skip there rather than turn the suite red.
    """
    if not registry.is_available(name):
        info = registry.get(name).info()
        pytest.skip(f"{name} is not installed: {info.detail}")


@pytest.fixture
def client():
    """A FastAPI test client with the app's lifespan actually run."""
    from fastapi.testclient import TestClient

    from app.main import CACHE, app

    CACHE.clear()
    with TestClient(app) as c:
        yield c
