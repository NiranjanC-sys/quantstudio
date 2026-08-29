"""Noise channels and device models.

Two consumers, two representations:

* the **density-matrix** engine (``app/backends/density.py``) wants Kraus
  operator sets, because ``rho -> sum_k K_k rho K_k^dagger`` is exact in one
  pass;
* the **statevector** engine (``app/backends/native.py``) wants a trajectory
  unravelling, because carrying a 2^n x 2^n object for n > 14 is impossible and
  sampling which Kraus branch fired is exact in the many-shot limit.

Both are derived from the same channel definitions below, so a lesson that
compares "the fast noisy simulation" with "the exact one" is comparing two
views of one model rather than two models.

Convention for the depolarising parameter ``p``: the channel is
``rho -> (1-p) rho + p * I/2^k``, i.e. ``p`` is the probability the state is
replaced by the maximally mixed state, which is the convention Qiskit's
``depolarizing_error`` uses. The Pauli-twirl form therefore carries
``p * 4^k/(4^k - 1) / 4^k`` on each non-identity Pauli.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Literal, Sequence

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.gates import Matrix, _I2, _X, _Y, _Z

KrausSet = list[Matrix]

_PAULIS: tuple[Matrix, ...] = (_I2, _X, _Y, _Z)
_PAULI_NAMES = ("I", "X", "Y", "Z")


class NoiseError(ValueError):
    """A physically impossible noise specification, e.g. T2 > 2*T1."""


# --------------------------------------------------------------------------
# Channels
# --------------------------------------------------------------------------


def depolarizing_1q(p: float) -> KrausSet:
    """``rho -> (1-p) rho + p I/2``. ``p`` in [0, 1]."""
    if not 0.0 <= p <= 1.0:
        raise NoiseError(f"depolarising probability {p} outside [0, 1]")
    if p == 0.0:
        return [_I2.copy()]
    # (1-p) rho + p I/2 == (1 - 3p/4) rho + (p/4)(X rho X + Y rho Y + Z rho Z)
    return [
        math.sqrt(1.0 - 3.0 * p / 4.0) * _I2,
        math.sqrt(p / 4.0) * _X,
        math.sqrt(p / 4.0) * _Y,
        math.sqrt(p / 4.0) * _Z,
    ]


def depolarizing_2q(p: float) -> KrausSet:
    """``rho -> (1-p) rho + p I/4`` on a qubit pair, as 16 Kraus operators."""
    if not 0.0 <= p <= 1.0:
        raise NoiseError(f"depolarising probability {p} outside [0, 1]")
    if p == 0.0:
        return [np.eye(4, dtype=np.complex128)]
    out: KrausSet = []
    for i, a in enumerate(_PAULIS):
        for j, b in enumerate(_PAULIS):
            weight = (1.0 - 15.0 * p / 16.0) if (i == 0 and j == 0) else (p / 16.0)
            out.append(math.sqrt(weight) * np.kron(a, b))
    return out


def amplitude_damping(gamma: float) -> KrausSet:
    """Energy decay toward |0>. ``gamma`` is the probability of a |1> -> |0> jump."""
    if not 0.0 <= gamma <= 1.0:
        raise NoiseError(f"amplitude damping gamma {gamma} outside [0, 1]")
    k0 = np.array([[1.0, 0.0], [0.0, math.sqrt(1.0 - gamma)]], dtype=np.complex128)
    k1 = np.array([[0.0, math.sqrt(gamma)], [0.0, 0.0]], dtype=np.complex128)
    return [k0, k1]


def phase_damping(lam: float) -> KrausSet:
    """Loss of coherence with no loss of energy. Off-diagonals shrink by sqrt(1-lam)."""
    if not 0.0 <= lam <= 1.0:
        raise NoiseError(f"phase damping lambda {lam} outside [0, 1]")
    k0 = np.array([[1.0, 0.0], [0.0, math.sqrt(1.0 - lam)]], dtype=np.complex128)
    k1 = np.array([[0.0, 0.0], [0.0, math.sqrt(lam)]], dtype=np.complex128)
    return [k0, k1]


def compose_kraus(second: KrausSet, first: KrausSet) -> KrausSet:
    """Kraus set of ``second . first`` (``first`` acts on the state first)."""
    return [a @ b for a in second for b in first]


def thermal_relaxation(t1: float, t2: float, gate_time: float) -> KrausSet:
    """Amplitude damping (T1) followed by pure dephasing (T2), in matching units.

    Physics, so the numbers mean something: T1 sets the energy-decay rate, so
    ``gamma = 1 - exp(-t/T1)``. T2 is the *total* coherence time, and amplitude
    damping already contributes ``exp(-t/2T1)`` to the off-diagonal decay, so
    the pure-dephasing time satisfies ``1/T_phi = 1/T2 - 1/(2 T1)``. That
    requires ``T2 <= 2 T1``; a device claiming otherwise is unphysical and we
    say so rather than silently clamping.

    The composed channel decays off-diagonals by exactly ``exp(-t/T2)``, which
    ``tests/test_noise.py`` checks numerically.
    """
    if t1 <= 0 or t2 <= 0:
        raise NoiseError("T1 and T2 must be positive")
    if t2 > 2.0 * t1:
        raise NoiseError(f"T2 ({t2}) exceeds 2*T1 ({2 * t1}); no such qubit exists")
    if gate_time < 0:
        raise NoiseError("gate time must be non-negative")
    gamma = 1.0 - math.exp(-gate_time / t1)
    inv_t_phi = 1.0 / t2 - 1.0 / (2.0 * t1)
    if inv_t_phi <= 0:
        # T2 == 2*T1 exactly: amplitude damping alone accounts for all dephasing.
        return amplitude_damping(gamma)
    lam = 1.0 - math.exp(-2.0 * gate_time * inv_t_phi)
    return compose_kraus(phase_damping(lam), amplitude_damping(gamma))


def readout_confusion(p01: float, p10: float | None = None) -> Matrix:
    """The 2x2 confusion matrix ``M[reported, true]`` of a readout channel.

    ``p01`` is P(report 1 | true 0); ``p10`` defaults to it. Asymmetric readout
    is the norm on superconducting hardware -- decay during the measurement
    window makes 1 -> 0 the likelier error -- so both are exposed.
    """
    a = float(p01)
    b = float(p01 if p10 is None else p10)
    for v in (a, b):
        if not 0.0 <= v <= 1.0:
            raise NoiseError(f"readout probability {v} outside [0, 1]")
    return np.array([[1.0 - a, b], [a, 1.0 - b]], dtype=np.float64)


def kraus_is_trace_preserving(ks: KrausSet, tol: float = 1e-10) -> bool:
    """``sum_k K_k^dagger K_k == I``: the defining property of a valid channel."""
    d = ks[0].shape[0]
    acc = np.zeros((d, d), dtype=np.complex128)
    for k in ks:
        acc += k.conj().T @ k
    return bool(np.allclose(acc, np.eye(d), atol=tol))


# --------------------------------------------------------------------------
# The wire model
# --------------------------------------------------------------------------


class NoiseModel(BaseModel):
    """The noise a request asks for, in the JSON the gateway forwards.

    Every field is optional and defaults to noiseless, so ``{}`` is a valid,
    meaningful noise model and the noisy and noiseless code paths are the same
    code path.
    """

    model_config = ConfigDict(extra="forbid")

    #: Depolarising probability applied after every 1-qubit gate.
    depolarizing1: float = Field(default=0.0, ge=0.0, le=1.0)
    #: Depolarising probability applied after every 2-qubit gate.
    depolarizing2: float = Field(default=0.0, ge=0.0, le=1.0)
    #: Amplitude damping applied to every qubit an op touches.
    amplitude_damping: float = Field(default=0.0, ge=0.0, le=1.0)
    #: Phase damping applied to every qubit an op touches.
    phase_damping: float = Field(default=0.0, ge=0.0, le=1.0)
    #: Probability a measurement reports the wrong bit.
    readout: float = Field(default=0.0, ge=0.0, le=1.0)
    #: Asymmetric readout: P(report 0 | true 1). Defaults to ``readout``.
    readout_10: float | None = Field(default=None, ge=0.0, le=1.0)

    #: Relaxation, in consistent units (nanoseconds by convention).
    t1: float | None = Field(default=None, gt=0.0)
    t2: float | None = Field(default=None, gt=0.0)
    gate_time_1q: float = Field(default=35.0, ge=0.0)
    gate_time_2q: float = Field(default=300.0, ge=0.0)

    #: Name of a built-in device model whose rates seed the fields above.
    device: str | None = None

    @model_validator(mode="after")
    def _check_relaxation(self) -> "NoiseModel":
        if (self.t1 is None) != (self.t2 is None):
            raise ValueError("t1 and t2 must be given together")
        if self.t1 is not None and self.t2 is not None and self.t2 > 2 * self.t1:
            raise ValueError(f"T2 ({self.t2}) exceeds 2*T1 ({2 * self.t1})")
        return self

    @property
    def active(self) -> bool:
        """True when this model actually perturbs anything."""
        return bool(
            self.depolarizing1
            or self.depolarizing2
            or self.amplitude_damping
            or self.phase_damping
            or self.readout
            or self.readout_10
            or self.t1 is not None
        )

    def one_qubit_kraus(self, gate_time: float | None = None) -> KrausSet:
        """The composed 1-qubit channel applied after a 1-qubit gate."""
        t = self.gate_time_1q if gate_time is None else gate_time
        ks: KrausSet = [_I2.copy()]
        if self.depolarizing1:
            ks = compose_kraus(depolarizing_1q(self.depolarizing1), ks)
        if self.t1 is not None and self.t2 is not None:
            ks = compose_kraus(thermal_relaxation(self.t1, self.t2, t), ks)
        else:
            if self.amplitude_damping:
                ks = compose_kraus(amplitude_damping(self.amplitude_damping), ks)
            if self.phase_damping:
                ks = compose_kraus(phase_damping(self.phase_damping), ks)
        return ks

    def two_qubit_kraus(self) -> KrausSet:
        """The 2-qubit depolarising channel applied after a 2-qubit gate."""
        return depolarizing_2q(self.depolarizing2) if self.depolarizing2 else [
            np.eye(4, dtype=np.complex128)
        ]

    def relaxation_kraus_2q(self) -> KrausSet:
        """The per-qubit relaxation channel for the longer 2-qubit gate time."""
        if self.t1 is None or self.t2 is None:
            ks: KrausSet = [_I2.copy()]
            if self.amplitude_damping:
                ks = compose_kraus(amplitude_damping(self.amplitude_damping), ks)
            if self.phase_damping:
                ks = compose_kraus(phase_damping(self.phase_damping), ks)
            return ks
        return thermal_relaxation(self.t1, self.t2, self.gate_time_2q)

    def confusion(self) -> Matrix:
        return readout_confusion(self.readout, self.readout_10)


# --------------------------------------------------------------------------
# Device models
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class DeviceModel:
    """A plausible superconducting device: topology plus calibration numbers.

    The rates are not scraped from a real backend -- we ship no vendor data --
    but they sit in the ranges published for IBM Falcon/Eagle-class hardware in
    2024: 1q error ~2e-4, 2q error ~6e-3 to 1.5e-2, readout ~1-3%, T1/T2 in the
    100-300 us band. They are generated deterministically from the device name,
    so a lesson that quotes "qubit 3's T1 is 142 us" stays true forever.
    """

    name: str
    num_qubits: int
    #: Undirected edges, each listed once with ``a < b``.
    coupling_map: tuple[tuple[int, int], ...]
    basis_gates: tuple[str, ...]
    #: Per qubit, in nanoseconds.
    t1: tuple[float, ...]
    t2: tuple[float, ...]
    #: Per qubit.
    error_1q: tuple[float, ...]
    readout_error: tuple[float, ...]
    #: Per undirected edge, keyed by ``(a, b)`` with ``a < b``.
    error_2q: dict[tuple[int, int], float]
    gate_time_1q: float
    gate_time_2q: float

    def neighbours(self, q: int) -> list[int]:
        out = [b for a, b in self.coupling_map if a == q]
        out += [a for a, b in self.coupling_map if b == q]
        return sorted(out)

    def noise_model(self, qubit: int = 0) -> NoiseModel:
        """A single-qubit-calibration NoiseModel, for the uniform-noise engines.

        The statevector engine applies one uniform channel to every qubit; this
        picks the calibration of ``qubit`` as the representative. The
        density-matrix engine can use the per-qubit numbers directly.
        """
        edges = list(self.error_2q.values())
        return NoiseModel(
            depolarizing1=self.error_1q[qubit],
            depolarizing2=(sum(edges) / len(edges)) if edges else 0.0,
            readout=self.readout_error[qubit],
            t1=self.t1[qubit],
            t2=self.t2[qubit],
            gate_time_1q=self.gate_time_1q,
            gate_time_2q=self.gate_time_2q,
            device=self.name,
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "numQubits": self.num_qubits,
            "couplingMap": [list(e) for e in self.coupling_map],
            "basisGates": list(self.basis_gates),
            "t1Ns": list(self.t1),
            "t2Ns": list(self.t2),
            "error1q": list(self.error_1q),
            "error2q": {f"{a}_{b}": v for (a, b), v in sorted(self.error_2q.items())},
            "readoutError": list(self.readout_error),
            "gateTime1qNs": self.gate_time_1q,
            "gateTime2qNs": self.gate_time_2q,
        }


def _linear(n: int) -> tuple[tuple[int, int], ...]:
    return tuple((i, i + 1) for i in range(n - 1))


def _grid(rows: int, cols: int) -> tuple[tuple[int, int], ...]:
    edges: list[tuple[int, int]] = []
    for r in range(rows):
        for c in range(cols):
            q = r * cols + c
            if c + 1 < cols:
                edges.append((q, q + 1))
            if r + 1 < rows:
                edges.append((q, q + cols))
    return tuple(sorted(edges))


def _all_to_all(n: int) -> tuple[tuple[int, int], ...]:
    return tuple((a, b) for a in range(n) for b in range(a + 1, n))


# IBM Falcon r5.11 (Nairobi / Lagos / Perth) heavy-hex sub-lattice.
_FALCON_7 = ((0, 1), (1, 2), (1, 3), (3, 5), (4, 5), (5, 6))

# IBM Falcon r5.11H (27 qubits, e.g. Mumbai / Kolkata) heavy-hex lattice.
_FALCON_27 = (
    (0, 1), (1, 2), (1, 4), (2, 3), (3, 5), (4, 7), (5, 8), (6, 7), (7, 10),
    (8, 9), (8, 11), (10, 12), (11, 14), (12, 13), (12, 15), (13, 14), (14, 16),
    (15, 18), (16, 19), (17, 18), (18, 21), (19, 20), (19, 22), (21, 23),
    (22, 25), (23, 24), (24, 25), (25, 26),
)

_TOPOLOGIES: dict[str, tuple[int, tuple[tuple[int, int], ...], tuple[str, ...]]] = {
    "linear_5": (5, _linear(5), ("rz", "sx", "x", "cx")),
    "ibm_falcon_7": (7, _FALCON_7, ("rz", "sx", "x", "cx")),
    "ibm_falcon_27": (27, _FALCON_27, ("rz", "sx", "x", "cx")),
    "ibm_eagle_16": (16, _grid(4, 4), ("rz", "sx", "x", "ecr")),
    "ionq_11": (11, _all_to_all(11), ("rx", "ry", "rzz")),
}

DEVICE_NAMES: tuple[str, ...] = tuple(_TOPOLOGIES)


def device_model(name: str) -> DeviceModel:
    """Return a named device model, or raise ``KeyError`` listing the valid names."""
    if name not in _TOPOLOGIES:
        raise KeyError(f"unknown device {name!r}; known devices: {', '.join(DEVICE_NAMES)}")
    n, coupling, basis = _TOPOLOGIES[name]
    # Seeded by the name so calibration numbers are stable across processes,
    # deploys and documentation.
    rng = np.random.default_rng(_name_seed(name))

    t1 = tuple(float(v) for v in rng.uniform(90_000.0, 280_000.0, n))          # ns
    # T2 is drawn as a fraction of the physical ceiling 2*T1 so it is always legal.
    t2 = tuple(float(a * b) for a, b in zip(t1, rng.uniform(0.55, 1.85, n)))
    err1 = tuple(float(v) for v in rng.uniform(1.1e-4, 4.5e-4, n))
    readout = tuple(float(v) for v in rng.uniform(6.0e-3, 3.2e-2, n))
    err2 = {
        (a, b): float(v)
        for (a, b), v in zip(coupling, rng.uniform(5.0e-3, 1.6e-2, len(coupling)))
    }
    gate_1q = 35.0 if name != "ionq_11" else 20_000.0
    gate_2q = 300.0 if name != "ionq_11" else 200_000.0
    if name == "ionq_11":
        # Trapped ions: far longer coherence, far slower gates.
        t1 = tuple(v * 400.0 for v in t1)
        t2 = tuple(v * 400.0 for v in t2)
    return DeviceModel(
        name=name,
        num_qubits=n,
        coupling_map=coupling,
        basis_gates=basis,
        t1=t1,
        t2=t2,
        error_1q=err1,
        readout_error=readout,
        error_2q=err2,
        gate_time_1q=gate_1q,
        gate_time_2q=gate_2q,
    )


def _name_seed(name: str) -> int:
    """A stable 32-bit seed from a device name (``hash()`` is salted per process)."""
    h = 0x811C9DC5
    for ch in name:
        h = ((h ^ ord(ch)) * 0x01000193) & 0xFFFFFFFF
    return h


__all__ = [
    "DEVICE_NAMES",
    "DeviceModel",
    "KrausSet",
    "NoiseError",
    "NoiseModel",
    "amplitude_damping",
    "compose_kraus",
    "depolarizing_1q",
    "depolarizing_2q",
    "device_model",
    "kraus_is_trace_preserving",
    "phase_damping",
    "readout_confusion",
    "thermal_relaxation",
]
