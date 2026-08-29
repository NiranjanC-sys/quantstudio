"""Noise channels: valid Kraus sets, correct physics, and engines that agree."""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.backends.base import SimOptions
from app.backends.density import DensityBackend, apply_channel, purity, zero_density
from app.ir import Circuit, Op
from app.noise import (
    DEVICE_NAMES,
    NoiseError,
    NoiseModel,
    amplitude_damping,
    compose_kraus,
    depolarizing_1q,
    depolarizing_2q,
    device_model,
    kraus_is_trace_preserving,
    phase_damping,
    readout_confusion,
    thermal_relaxation,
)
from tests.conftest import bell, op

CHANNELS = {
    "depolarizing_1q": lambda p: depolarizing_1q(p),
    "amplitude_damping": lambda p: amplitude_damping(p),
    "phase_damping": lambda p: phase_damping(p),
}


@pytest.mark.parametrize("name", sorted(CHANNELS))
@pytest.mark.parametrize("p", [0.0, 0.01, 0.25, 0.5, 1.0])
def test_channels_are_trace_preserving(name: str, p: float) -> None:
    assert kraus_is_trace_preserving(CHANNELS[name](p))


@pytest.mark.parametrize("p", [0.0, 0.05, 0.5, 1.0])
def test_two_qubit_depolarising_is_trace_preserving(p: float) -> None:
    assert kraus_is_trace_preserving(depolarizing_2q(p))


@pytest.mark.parametrize("p", [-0.1, 1.5])
def test_out_of_range_probabilities_are_rejected(p: float) -> None:
    with pytest.raises(NoiseError):
        depolarizing_1q(p)


def test_depolarising_moves_toward_the_maximally_mixed_state() -> None:
    """``rho -> (1-p) rho + p I/2``, the Qiskit convention, checked directly."""
    rho = np.array([[1.0, 0.0], [0.0, 0.0]], dtype=np.complex128)
    for p in (0.0, 0.1, 0.5, 1.0):
        out = apply_channel(rho, 1, [0], depolarizing_1q(p))
        expected = (1 - p) * rho + p * np.eye(2) / 2
        assert np.allclose(out, expected, atol=1e-12), f"p={p}"


def test_full_depolarising_erases_everything() -> None:
    rho = np.array([[0.5, 0.5], [0.5, 0.5]], dtype=np.complex128)
    out = apply_channel(rho, 1, [0], depolarizing_1q(1.0))
    assert np.allclose(out, np.eye(2) / 2, atol=1e-12)


def test_amplitude_damping_decays_toward_ground() -> None:
    excited = np.array([[0.0, 0.0], [0.0, 1.0]], dtype=np.complex128)
    out = apply_channel(excited, 1, [0], amplitude_damping(0.3))
    assert abs(out[1, 1].real - 0.7) < 1e-12
    assert abs(out[0, 0].real - 0.3) < 1e-12


def test_amplitude_damping_at_one_reaches_the_ground_state() -> None:
    excited = np.array([[0.0, 0.0], [0.0, 1.0]], dtype=np.complex128)
    out = apply_channel(excited, 1, [0], amplitude_damping(1.0))
    assert np.allclose(out, np.array([[1.0, 0.0], [0.0, 0.0]]), atol=1e-12)


def test_phase_damping_kills_coherence_but_not_population() -> None:
    plus = np.array([[0.5, 0.5], [0.5, 0.5]], dtype=np.complex128)
    out = apply_channel(plus, 1, [0], phase_damping(0.36))
    assert abs(out[0, 0].real - 0.5) < 1e-12, "populations must not move"
    assert abs(abs(out[0, 1]) - 0.5 * math.sqrt(1 - 0.36)) < 1e-12


def test_thermal_relaxation_decays_coherence_at_exactly_t2() -> None:
    """The composed channel must shrink off-diagonals by ``exp(-t/T2)``.

    This is the number a lesson quotes, and it is the one that goes wrong if
    the pure-dephasing time is derived incorrectly from T1 and T2.
    """
    t1, t2, t = 120_000.0, 90_000.0, 300.0
    plus = np.array([[0.5, 0.5], [0.5, 0.5]], dtype=np.complex128)
    out = apply_channel(plus, 1, [0], thermal_relaxation(t1, t2, t))
    assert abs(abs(out[0, 1]) - 0.5 * math.exp(-t / t2)) < 1e-12


def test_thermal_relaxation_decays_population_at_exactly_t1() -> None:
    t1, t2, t = 120_000.0, 90_000.0, 5_000.0
    excited = np.array([[0.0, 0.0], [0.0, 1.0]], dtype=np.complex128)
    out = apply_channel(excited, 1, [0], thermal_relaxation(t1, t2, t))
    assert abs(out[1, 1].real - math.exp(-t / t1)) < 1e-12


def test_t2_above_twice_t1_is_refused() -> None:
    """No such qubit exists; clamping silently would teach a falsehood."""
    with pytest.raises(NoiseError, match="no such qubit"):
        thermal_relaxation(100.0, 250.0, 10.0)
    with pytest.raises(ValueError):
        NoiseModel(t1=100.0, t2=250.0)


def test_t2_exactly_twice_t1_is_pure_amplitude_damping() -> None:
    ks = thermal_relaxation(100.0, 200.0, 10.0)
    assert len(ks) == 2
    assert kraus_is_trace_preserving(ks)


def test_t1_and_t2_must_be_given_together() -> None:
    with pytest.raises(ValueError, match="together"):
        NoiseModel(t1=100.0)


def test_composed_kraus_is_still_a_channel() -> None:
    composed = compose_kraus(phase_damping(0.2), amplitude_damping(0.1))
    assert kraus_is_trace_preserving(composed)
    assert len(composed) == 4


def test_readout_confusion_columns_sum_to_one() -> None:
    m = readout_confusion(0.02, 0.05)
    assert np.allclose(m.sum(axis=0), [1.0, 1.0])


def test_noise_model_active_flag() -> None:
    assert NoiseModel().active is False
    assert NoiseModel(depolarizing1=0.01).active is True
    assert NoiseModel(readout=0.01).active is True
    assert NoiseModel(t1=100.0, t2=100.0).active is True


def test_empty_noise_model_is_a_valid_noiseless_model() -> None:
    """``{}`` must mean noiseless, so the two code paths stay one code path."""
    model = NoiseModel()
    assert len(model.one_qubit_kraus()) == 1
    assert model.active is False


# --------------------------------------------------------------------------
# Noise in the engines
# --------------------------------------------------------------------------


def test_noise_reduces_purity_on_the_density_engine() -> None:
    circuit = bell()
    clean = DensityBackend().run(circuit, SimOptions(shots=0))
    noisy = DensityBackend().run(
        circuit, SimOptions(shots=0, noise=NoiseModel(depolarizing1=0.1, depolarizing2=0.1))
    )
    assert abs(clean.metadata["purity"] - 1.0) < 1e-12
    assert noisy.metadata["purity"] < 0.95


def test_density_matrix_stays_a_valid_state_under_noise() -> None:
    result = DensityBackend().run(
        bell(),
        SimOptions(shots=0, noise=NoiseModel(depolarizing1=0.2, amplitude_damping=0.1)),
    )
    rho = result.density_matrix
    assert rho is not None
    assert abs(np.real(np.trace(rho)) - 1.0) < 1e-12
    assert np.allclose(rho, rho.conj().T, atol=1e-12), "rho must be Hermitian"
    eigenvalues = np.linalg.eigvalsh(rho)
    assert eigenvalues.min() > -1e-12, "rho must be positive semi-definite"
    assert abs(result.probabilities.sum() - 1.0) < 1e-12


def test_trajectory_average_converges_to_the_exact_density_result() -> None:
    """The statevector engine unravels the channel; the density engine is exact.

    They are two views of one model, so many trajectories must approach the
    exact answer. 4000 trajectories on a 2-qubit circuit gets within a few
    percent, which is the honest tolerance for a Monte Carlo estimate.
    """
    from app.backends.native import NativeBackend

    noise = NoiseModel(depolarizing1=0.08, depolarizing2=0.08)
    exact = DensityBackend().run(bell(), SimOptions(shots=0, noise=noise))
    sampled = NativeBackend().run(
        bell(), SimOptions(shots=4000, seed=4, noise=noise, max_trajectories=4000)
    )
    assert sampled.stochastic is True
    assert np.abs(sampled.probabilities - exact.probabilities).max() < 0.03


def test_noise_is_capped_at_fourteen_qubits_on_the_density_engine() -> None:
    from app.backends.base import AdmissionError

    circuit = Circuit(qubits=15, ops=[op("h", [q]) for q in range(15)])
    with pytest.raises(AdmissionError, match="capped at 14"):
        DensityBackend().run(circuit, SimOptions(shots=0))


# --------------------------------------------------------------------------
# Device models
# --------------------------------------------------------------------------


@pytest.mark.parametrize("name", DEVICE_NAMES)
def test_device_calibrations_are_physical(name: str) -> None:
    model = device_model(name)
    assert model.num_qubits >= 5
    for q in range(model.num_qubits):
        assert model.t2[q] <= 2 * model.t1[q] + 1e-6, f"{name} qubit {q} has T2 > 2*T1"
        assert 0.0 < model.error_1q[q] < 0.01
        assert 0.0 < model.readout_error[q] < 0.1
    for (a, b), err in model.error_2q.items():
        assert a < b, "edges are listed once, low index first"
        assert 0.0 < err < 0.05


@pytest.mark.parametrize("name", DEVICE_NAMES)
def test_device_models_are_deterministic(name: str) -> None:
    """A lesson quoting "qubit 3's T1 is 142 us" must stay true forever."""
    assert device_model(name).t1 == device_model(name).t1


@pytest.mark.parametrize("name", DEVICE_NAMES)
def test_device_noise_model_is_valid(name: str) -> None:
    model = device_model(name).noise_model(0)
    assert model.active
    assert kraus_is_trace_preserving(model.one_qubit_kraus())


def test_unknown_device_lists_the_known_ones() -> None:
    with pytest.raises(KeyError) as excinfo:
        device_model("ibm_imaginary")
    assert "known devices" in str(excinfo.value)


def test_coupling_map_is_connected() -> None:
    for name in DEVICE_NAMES:
        model = device_model(name)
        seen = {0}
        frontier = [0]
        while frontier:
            q = frontier.pop()
            for nb in model.neighbours(q):
                if nb not in seen:
                    seen.add(nb)
                    frontier.append(nb)
        assert len(seen) == model.num_qubits, f"{name} is not connected"
