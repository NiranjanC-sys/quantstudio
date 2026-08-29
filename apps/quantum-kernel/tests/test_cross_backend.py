"""Every engine must agree, to 1e-9, on the amplitudes of the same circuit.

This is the test that keeps five independent implementations honest. It is also
the only place the endian translation at the Qiskit boundary is proved end to
end: Qiskit puts qubit 0 in the *least* significant bit, ``app/codegen.to_qiskit``
reverses wire indices to compensate, and if that reversal were wrong the
amplitude arrays would disagree by a bit-reversal permutation -- which shows up
here as a large error, not a subtle one.

A backend whose SDK is not installed is **skipped, never failed**: a pod built
without the heavy wheels is a supported configuration and the native NumPy
engine is the only one the service promises.
"""

from __future__ import annotations

import math
import random

import numpy as np
import pytest

from app import backends as registry
from app.backends.base import SimOptions
from app.ir import Circuit, Op
from tests.conftest import bell, ghz, qft, require_backend, statevector, w_state

#: Everything every adapter can express. Gates absent from an SDK's own library
#: fall back to a matrix gate built from our registry, which is exact by
#: construction and still runs on that SDK's simulator.
ONE_QUBIT = ("id", "x", "y", "z", "h", "s", "sdg", "t", "tdg", "sx", "sxdg")
ONE_QUBIT_PARAM = ("rx", "ry", "rz", "p")
TWO_QUBIT = ("cx", "cy", "cz", "ch", "swap", "iswap", "cs", "csdg", "csx", "ecr")
TWO_QUBIT_PARAM = ("rxx", "ryy", "rzz", "rzx", "cp", "crx", "cry", "crz")
THREE_QUBIT = ("ccx", "ccz", "cswap")

#: The agreement the service promises. Observed error on this ensemble is ~4e-16.
TOLERANCE = 1e-9

#: Backends that return an exact statevector.
PURE_BACKENDS = ("aer", "cirq", "pennylane")


def random_circuit(n: int, depth: int, rng: random.Random) -> Circuit:
    ops: list[Op] = []
    for _ in range(depth):
        arity = rng.choice([1, 1, 2, 3])
        if arity == 1:
            key = rng.choice(ONE_QUBIT + ONE_QUBIT_PARAM)
            params = [rng.uniform(-math.pi, math.pi)] if key in ONE_QUBIT_PARAM else []
            if rng.random() < 0.15:
                key, params = "u", [rng.uniform(-3.0, 3.0) for _ in range(3)]
            ops.append(Op(gate=key, targets=[rng.randrange(n)], params=params))
        elif arity == 2 and n >= 2:
            a, b = rng.sample(range(n), 2)
            key = rng.choice(TWO_QUBIT + TWO_QUBIT_PARAM)
            params = [rng.uniform(-math.pi, math.pi)] if key in TWO_QUBIT_PARAM else []
            ops.append(Op(gate=key, targets=[a, b], params=params))
        elif n >= 3:
            ops.append(Op(gate=rng.choice(THREE_QUBIT), targets=rng.sample(range(n), 3)))
    return Circuit(qubits=n, name="random", ops=ops)


@pytest.mark.parametrize("name", PURE_BACKENDS)
@pytest.mark.parametrize("trial", range(6))
def test_random_circuits_agree_with_native(name: str, trial: int) -> None:
    require_backend(name)
    circuit = random_circuit(4, 16, random.Random(trial))
    reference = statevector(circuit, "native")
    actual = statevector(circuit, name)
    error = float(np.abs(actual - reference).max())
    assert error < TOLERANCE, (
        f"{name} disagrees with native by {error:.3e} on trial {trial}"
    )


@pytest.mark.parametrize("name", PURE_BACKENDS)
def test_five_qubit_circuit_agrees(name: str) -> None:
    require_backend(name)
    circuit = random_circuit(5, 24, random.Random(99))
    error = float(np.abs(statevector(circuit, name) - statevector(circuit, "native")).max())
    assert error < TOLERANCE


def test_density_backend_reproduces_the_native_distribution() -> None:
    """The density engine carries rho, so compare probabilities, not amplitudes."""
    circuit = random_circuit(4, 14, random.Random(7))
    reference = np.abs(statevector(circuit, "native")) ** 2
    result = registry.get("density").run(
        circuit, SimOptions(shots=0, return_bloch=False)
    )
    assert float(np.abs(result.probabilities - reference).max()) < TOLERANCE


def test_density_of_a_pure_state_is_the_outer_product() -> None:
    circuit = ghz(3)
    psi = statevector(circuit, "native")
    result = registry.get("density").run(circuit, SimOptions(shots=0, return_bloch=False))
    assert result.density_matrix is not None
    assert np.allclose(result.density_matrix, np.outer(psi, psi.conj()), atol=1e-13)
    assert abs(result.metadata["purity"] - 1.0) < 1e-12


@pytest.mark.parametrize("name", PURE_BACKENDS)
def test_named_states_agree_on_every_backend(name: str) -> None:
    """The three states a lesson actually shows, on every engine present."""
    require_backend(name)
    for circuit in (bell(), ghz(4), w_state(), qft(3)):
        error = float(
            np.abs(statevector(circuit, name) - statevector(circuit, "native")).max()
        )
        assert error < TOLERANCE, f"{name} disagrees on {circuit.name} by {error:.3e}"


def test_qiskit_wire_reversal_aligns_basis_indices() -> None:
    """The endian translation, isolated.

    ``x`` on our qubit 0 must put all amplitude on basis index ``0b100`` --
    the *most* significant bit -- in Aer's array as well as ours. If
    ``to_qiskit`` stopped reversing wires, Aer would return ``0b001`` instead,
    and the assertion names exactly that failure.
    """
    require_backend("aer")
    circuit = Circuit(qubits=3, ops=[Op(gate="x", targets=[0])])
    psi = statevector(circuit, "aer")
    assert int(np.argmax(np.abs(psi))) == 0b100, (
        "Aer's amplitude landed on the wrong bit: the Qiskit wire reversal is broken"
    )


def test_swap_is_not_elided_by_the_qiskit_transpiler() -> None:
    """A regression guard with real history.

    Qiskit's preset pass managers run ``ElidePermutations`` from optimisation
    level 1, which deletes SWAP gates and records the relabelling in the
    ``TranspileLayout`` instead. The saved statevector then comes back in
    physical-qubit order and every amplitude a SWAP moved is in the wrong
    place. ``app/backends/aer.py`` pins ``optimization_level=0`` because of
    this; that pin is what this test defends.
    """
    require_backend("aer")
    circuit = Circuit(
        qubits=2, ops=[Op(gate="x", targets=[0]), Op(gate="swap", targets=[0, 1])]
    )
    psi = statevector(circuit, "aer")
    assert int(np.argmax(np.abs(psi))) == 0b01, "the SWAP was elided, not simulated"


@pytest.mark.parametrize("name", PURE_BACKENDS)
def test_counts_agree_in_distribution(name: str) -> None:
    """Sampled counts from each backend land on the same support with the same
    approximate weights. Exactness is not available here -- these are samples --
    so the check is that no backend puts mass where another puts none."""
    require_backend(name)
    circuit = ghz(3)
    opts = SimOptions(shots=4096, seed=17, return_bloch=False)
    reference = registry.get("native").run(circuit, opts).counts or {}
    actual = registry.get(name).run(circuit, opts).counts or {}
    assert set(actual) == set(reference) == {"000", "111"}
    for key in reference:
        assert abs(actual[key] - reference[key]) / 4096 < 0.05


def test_unavailable_backend_reports_rather_than_raising() -> None:
    """``GET /v1/backends`` must describe every backend, present or not."""
    infos = {i.name: i for i in registry.infos()}
    assert set(infos) == set(registry.BACKEND_ORDER)
    assert infos["native"].available is True
    for info in infos.values():
        if not info.available:
            assert info.detail, f"{info.name} is unavailable but says nothing about why"


def test_resolve_falls_back_to_native_for_a_missing_backend() -> None:
    backend = registry.resolve("cirq")
    assert backend.name in ("cirq", "native")
    if not registry.is_available("cirq"):
        assert backend.name == "native"
