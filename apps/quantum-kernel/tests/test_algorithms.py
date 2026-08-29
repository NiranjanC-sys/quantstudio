"""The textbook algorithms, asserted on exact amplitudes rather than on shots.

These are the tests that would catch an endianness regression, and they are
written so that a convention flip produces an obviously wrong answer -- a
Bernstein-Vazirani secret that comes back reversed, a W state whose excitation
sits on the wrong qubit -- rather than a marginally different probability.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.backends.base import make_rng, reduced_density_from_state
from app.backends.native import circuit_unitary, run_once
from app.ir import metrics
from tests.conftest import (
    S2,
    bernstein_vazirani,
    bell,
    deutsch_jozsa,
    dft_matrix,
    ghz,
    grover,
    grover_optimal_iterations,
    marginal,
    probabilities,
    qft,
    simon,
    statevector,
    teleportation,
    w_state,
)


# --------------------------------------------------------------------------
# Entangled states, exactly
# --------------------------------------------------------------------------


def test_bell_amplitudes_are_exact() -> None:
    psi = statevector(bell())
    expected = np.array([S2, 0.0, 0.0, S2], dtype=np.complex128)
    assert np.allclose(psi, expected, atol=1e-15)
    # And not the other Bell state: |01> and |10> must be exactly zero.
    assert psi[0b01] == 0.0 and psi[0b10] == 0.0


@pytest.mark.parametrize("n", [2, 3, 4, 5, 6])
def test_ghz_amplitudes_are_exact(n: int) -> None:
    psi = statevector(ghz(n))
    assert abs(psi[0] - S2) < 1e-14
    assert abs(psi[-1] - S2) < 1e-14
    interior = np.delete(psi, [0, psi.size - 1])
    assert np.max(np.abs(interior)) == 0.0, "GHZ has no amplitude between the poles"


def test_w_state_amplitudes_are_exact() -> None:
    """One excitation, shared equally. Index 4 is |100>, 2 is |010>, 1 is |001>."""
    psi = statevector(w_state())
    third = 1.0 / math.sqrt(3.0)
    for index in (0b100, 0b010, 0b001):
        assert abs(abs(psi[index]) - third) < 1e-14, f"index {index:03b}"
    for index in (0b000, 0b011, 0b101, 0b110, 0b111):
        assert abs(psi[index]) < 1e-14, f"index {index:03b} should be empty"
    assert abs(np.vdot(psi, psi).real - 1.0) < 1e-14


def test_w_state_is_not_ghz() -> None:
    """Tracing out one qubit leaves a W state mixed but still entangled, while
    a GHZ state falls apart into a classical mixture. If the builder ever
    produced GHZ by accident this is what would notice."""
    psi_w = statevector(w_state())
    rho_w = reduced_density_from_state(psi_w, 3, [1, 2])
    psi_g = statevector(ghz(3))
    rho_g = reduced_density_from_state(psi_g, 3, [1, 2])
    from app.visual import concurrence

    assert concurrence(rho_w) > 0.6
    assert concurrence(rho_g) < 1e-12


# --------------------------------------------------------------------------
# QFT
# --------------------------------------------------------------------------


@pytest.mark.parametrize("n", [1, 2, 3, 4, 5])
def test_qft_equals_the_dft_matrix(n: int) -> None:
    """Exactly equal -- not up to a global phase, not transposed, not conjugated.

    This is the single strongest statement of the endian convention in the
    suite: the textbook circuit only produces ``F`` itself when qubit 0 is the
    most significant bit and the final swaps are present.
    """
    u = circuit_unitary(qft(n))
    f = dft_matrix(n)
    assert np.allclose(u, f, atol=1e-12), f"max error {np.abs(u - f).max():.3e}"


@pytest.mark.parametrize("n", [2, 3, 4])
def test_qft_without_swaps_is_the_bit_reversed_dft(n: int) -> None:
    """Dropping the final swaps reverses the output qubit order, and nothing else.

    Worth pinning because "my QFT is wrong" is nearly always this, and a test
    that says so names the bug for the next person.
    """
    u = circuit_unitary(qft(n, with_swaps=False))
    f = dft_matrix(n)
    reversal = np.zeros((1 << n, 1 << n))
    for i in range(1 << n):
        j = int(format(i, f"0{n}b")[::-1], 2)
        reversal[j, i] = 1.0
    assert np.allclose(reversal @ u, f, atol=1e-12)


def test_qft_of_a_basis_state_is_a_uniform_phase_ramp() -> None:
    n, j = 3, 5
    u = circuit_unitary(qft(n))
    out = u[:, j]
    assert np.allclose(np.abs(out), 1.0 / math.sqrt(1 << n), atol=1e-12)
    phases = np.angle(out[1:] / out[:-1])
    assert np.allclose(phases, phases[0], atol=1e-12), "phase increments must be constant"


def test_qft_inverse_round_trips() -> None:
    n = 3
    u = circuit_unitary(qft(n))
    assert np.allclose(u.conj().T @ u, np.eye(1 << n), atol=1e-13)


# --------------------------------------------------------------------------
# Grover
# --------------------------------------------------------------------------


def test_grover_optimal_iteration_count_uses_the_floor() -> None:
    assert grover_optimal_iterations(3) == 2
    assert grover_optimal_iterations(2) == 1
    assert grover_optimal_iterations(4) == 3
    # The floor and the round disagree from n = 5; the floor never overshoots.
    assert grover_optimal_iterations(5) == 4


@pytest.mark.parametrize("marked", [0b000, 0b101, 0b110, 0b111])
def test_grover_three_qubits_finds_the_marked_state(marked: int) -> None:
    """Two iterations on n = 3 gives p = 0.9453125, the exact analytic value.

    ``sin^2(5 theta)`` with ``sin theta = 1/sqrt(8)`` is 0.945312..., and the
    simulation reproduces it to machine precision because every gate involved
    is exact in binary.
    """
    iterations = grover_optimal_iterations(3)
    assert iterations == 2
    probs = probabilities(grover(3, marked, iterations))
    assert int(np.argmax(probs)) == marked
    assert abs(probs[marked] - 0.9453125) < 1e-12, f"got {probs[marked]:.9f}"


def test_grover_matches_the_amplitude_amplification_formula() -> None:
    """``p_k = sin^2((2k+1) theta)`` for every k, including past the peak.

    Checking k = 3 matters: it is the one that demonstrates *why* the iteration
    count is a floor and not "as many as you like".
    """
    theta = math.asin(1.0 / math.sqrt(8.0))
    for k in range(5):
        probs = probabilities(grover(3, 0b101, k))
        expected = math.sin((2 * k + 1) * theta) ** 2
        assert abs(probs[0b101] - expected) < 1e-12, f"k={k}"
    over = probabilities(grover(3, 0b101, 3))
    assert over[0b101] < 0.5, "three iterations must overshoot and lose amplitude"


def test_grover_leaves_the_unmarked_states_equal() -> None:
    probs = probabilities(grover(3, 0b011, 2))
    others = [p for i, p in enumerate(probs) if i != 0b011]
    assert max(others) - min(others) < 1e-12


# --------------------------------------------------------------------------
# Teleportation
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "theta,phi,lam",
    [
        (0.0, 0.0, 0.0),
        (math.pi, 0.0, 0.0),
        (0.7, 1.3, -0.45),
        (2.4, -2.1, 0.9),
        (math.pi / 2, math.pi / 4, 0.0),
    ],
)
def test_teleportation_reproduces_an_arbitrary_input(
    theta: float, phi: float, lam: float
) -> None:
    """Qubit 2 ends in exactly the state qubit 0 started in, on every branch.

    Run as real trajectories with real collapse, not with deferred
    measurement: the corrections are conditioned on measurement outcomes, so
    deferring them would test a different circuit. Twenty-four seeds is far
    more than enough to visit all four ``(c0, c1)`` branches, and the test
    asserts that it did -- otherwise a broken correction on a rare branch would
    slip through.
    """
    circuit = teleportation(theta, phi, lam)
    psi = np.array(
        [math.cos(theta / 2), np.exp(1j * phi) * math.sin(theta / 2)],
        dtype=np.complex128,
    )
    expected = np.outer(psi, psi.conj())

    branches = set()
    for seed in range(24):
        state, clbits = run_once(circuit, None, make_rng(seed), None)
        branches.add(tuple(clbits))
        rho = reduced_density_from_state(state, 3, [2])
        assert np.allclose(rho, expected, atol=1e-12), f"seed {seed}, branch {clbits}"
    assert branches == {(0, 0), (0, 1), (1, 0), (1, 1)}, (
        f"only visited {sorted(branches)}; the test did not exercise every correction"
    )


def test_teleportation_destroys_the_original() -> None:
    """No-cloning, observed: qubit 0 is left in a computational basis state."""
    circuit = teleportation(0.7, 1.3, -0.45)
    state, _ = run_once(circuit, None, make_rng(5), None)
    rho0 = reduced_density_from_state(state, 3, [0])
    purity = float(np.real(np.trace(rho0 @ rho0)))
    assert abs(purity - 1.0) < 1e-12
    assert abs(rho0[0, 1]) < 1e-12, "qubit 0 must retain no coherence from the input"


# --------------------------------------------------------------------------
# Oracle algorithms
# --------------------------------------------------------------------------


@pytest.mark.parametrize("n", [1, 2, 3, 4])
@pytest.mark.parametrize("kind", ["constant_zero", "constant_one", "balanced"])
def test_deutsch_jozsa(n: int, kind: str) -> None:
    """Constant means all-zeros with certainty; balanced means never all-zeros."""
    circuit = deutsch_jozsa(n, kind)
    probs = probabilities(circuit)
    inputs = marginal(probs, n + 1, list(range(n)))
    if kind.startswith("constant"):
        assert abs(inputs[0] - 1.0) < 1e-12
    else:
        assert inputs[0] < 1e-12, "a balanced oracle can never yield all zeros"
        assert abs(inputs.sum() - 1.0) < 1e-12


def test_deutsch_jozsa_uses_one_oracle_query() -> None:
    """The whole point of the algorithm: a classical solver needs 2^(n-1)+1."""
    circuit = deutsch_jozsa(3, "balanced")
    assert metrics(circuit).two_qubit_gates == 3  # one oracle, three CNOTs in it


@pytest.mark.parametrize("n", [1, 2, 3, 4, 5])
def test_bernstein_vazirani_recovers_every_secret(n: int) -> None:
    """Every secret, not a sample: 2^n is small and exhaustive is stronger."""
    for secret in range(1 << n):
        probs = probabilities(bernstein_vazirani(secret, n))
        inputs = marginal(probs, n + 1, list(range(n)))
        recovered = int(np.argmax(inputs))
        assert abs(inputs[recovered] - 1.0) < 1e-12
        assert recovered == secret, (
            f"expected {secret:0{n}b}, got {recovered:0{n}b} -- "
            f"a reversal here means the endian convention broke"
        )


def test_bernstein_vazirani_is_not_symmetric_under_reversal() -> None:
    """Pin a secret whose bit-reversal differs, so a silent flip cannot pass."""
    n, secret = 4, 0b1000
    probs = probabilities(bernstein_vazirani(secret, n))
    inputs = marginal(probs, n + 1, list(range(n)))
    assert int(np.argmax(inputs)) == 0b1000
    assert inputs[0b0001] < 1e-12


@pytest.mark.parametrize("n,secret", [(2, 0b11), (2, 0b10), (3, 0b110), (3, 0b101), (3, 0b011)])
def test_simon_outputs_are_orthogonal_to_the_period(n: int, secret: int) -> None:
    """Every surviving input string ``y`` satisfies ``y . s == 0`` over GF(2),
    and there are exactly ``2^(n-1)`` of them -- a full basis of the orthogonal
    complement, which is what makes ``n-1`` runs enough to solve for ``s``."""
    probs = probabilities(simon(secret, n))
    survivors = {i >> n for i, p in enumerate(probs) if p > 1e-12}
    assert survivors, "interference cannot cancel everything"
    for y in survivors:
        assert bin(y & secret).count("1") % 2 == 0, (
            f"y={y:0{n}b} is not orthogonal to s={secret:0{n}b}"
        )
    assert len(survivors) == 1 << (n - 1)


def test_simon_solves_for_the_period_by_linear_algebra() -> None:
    """Gaussian elimination over GF(2) on the survivors recovers ``s`` uniquely."""
    n, secret = 3, 0b110
    probs = probabilities(simon(secret, n))
    rows = [y for y in {i >> n for i, p in enumerate(probs) if p > 1e-12} if y]
    # Any non-zero t consistent with every equation must be the secret.
    solutions = [
        t
        for t in range(1, 1 << n)
        if all(bin(y & t).count("1") % 2 == 0 for y in rows)
    ]
    assert solutions == [secret]


def test_simon_rejects_a_zero_period() -> None:
    with pytest.raises(ValueError, match="non-zero"):
        simon(0, 3)
