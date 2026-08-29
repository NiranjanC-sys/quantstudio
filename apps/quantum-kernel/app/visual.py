"""Visualisation payloads: everything the frontend instruments draw.

The 3D instruments in ``apps/web`` -- the Bloch spheres, the Q-sphere, the
density heatmap, the evolution scrubber and the entanglement graph -- must never
do quantum linear algebra themselves. If they did, the browser engine
(``packages/qir``) and this kernel would each own half a physics model and they
would drift. So the kernel computes every derived quantity here and ships
numbers; the frontend owns geometry, colour and interaction only.

Everything obeys the project convention: **qubit 0 is the most significant bit**
of a basis index, so ``basis_label(i)[q]`` is qubit ``q``'s value and no payload
needs a reversal note.

**Measurements are deferred.** These payloads describe the *unitary* evolution
of a circuit: ``measure`` and ``barrier`` are skipped, so a learner scrubbing
through a circuit that ends in measurement sees the superposition they built
rather than one arbitrary collapsed branch. That is what makes the instruments
teach anything. ``reset`` is likewise skipped, and the payload says so in
``warnings``.

Payload sizes are bounded on purpose: a 12-qubit circuit of depth 40 already
carries 40 x 4096 complex amplitudes, so the timeline stores amplitudes only up
to :data:`TIMELINE_MAX_QUBITS` and falls back to probabilities beyond it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

import numpy as np

from app.backends.base import (
    BlochVector,
    bloch_from_rdm,
    bloch_vectors_from_density,
    bloch_vectors_from_state,
    basis_label,
    complex_matrix_payload,
    probabilities_from_density,
    probabilities_from_state,
    reduced_density_from_density,
    reduced_density_from_state,
)
from app.backends.native import apply_matrix, op_target_matrix, zero_state
from app.gates import GATES, _Y
from app.ir import Circuit, IRError, Op, moments, validate_or_raise

#: Above this the timeline ships probabilities only: 2**14 complex amplitudes
#: per moment is already a 4 MB JSON body at depth 16.
TIMELINE_MAX_QUBITS = 12

#: Hard ceiling for any visual payload. 2**16 amplitudes is the most a browser
#: instrument can draw meaningfully anyway.
VISUAL_MAX_QUBITS = 16

#: Density heatmaps are n x n grids of two floats; 128 x 128 is 32k numbers.
HEATMAP_MAX_DIM = 128

#: Basis states below this probability are dropped from the Q-sphere. They
#: would render as invisible points and they dominate the payload for a
#: circuit with a few hundred small amplitudes.
QSPHERE_MIN_PROBABILITY = 1e-12

#: Entanglement edges below this are treated as absent, so a numerically noisy
#: product state draws no edges at all rather than a full graph of 1e-17s.
ENTANGLEMENT_EPS = 1e-9

_YY = np.kron(_Y, _Y)


class VisualError(ValueError):
    """The circuit is too large, or too non-unitary, for a visual payload."""


# --------------------------------------------------------------------------
# Evolution: the state after each moment
# --------------------------------------------------------------------------


def _skip(op: Op) -> bool:
    """True for ops the visualiser deliberately ignores. See the module note."""
    return op.gate in ("barrier", "measure", "reset")


def evolve_by_moment(
    circuit: Circuit, bindings: dict[str, float] | None = None
) -> tuple[list[np.ndarray], list[str]]:
    """Statevectors ``[|0..0>, after moment 0, after moment 1, ...]``.

    The initial state is included, so the returned list has ``depth + 1``
    entries and index ``m`` is "the state a learner sees when the scrubber sits
    just before moment ``m``".
    """
    n = circuit.qubits
    if n > VISUAL_MAX_QUBITS:
        raise VisualError(
            f"visual payloads are capped at {VISUAL_MAX_QUBITS} qubits, got {n}; "
            f"the instruments cannot draw 2**{n} amplitudes"
        )
    validate_or_raise(circuit)
    warnings: list[str] = []
    if any(op.gate in ("measure", "reset") for op in circuit.ops):
        warnings.append(
            "measurement and reset are deferred: this timeline shows the unitary "
            "evolution, not one collapsed branch"
        )

    psi = zero_state(n)
    states = [psi.copy()]
    for layer in moments(circuit):
        for op in layer:
            if _skip(op):
                continue
            matrix, targets, controls = op_target_matrix(op, bindings)
            apply_matrix(psi, n, targets, controls, matrix)
        states.append(psi.copy())
    return states, warnings


# --------------------------------------------------------------------------
# Bloch spheres, with history
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class BlochTrace:
    """One qubit's Bloch vector at every moment boundary.

    ``points[m]`` is the vector after moment ``m - 1`` has run (so ``points[0]``
    is always the north pole), which is what lets the frontend draw the arrow's
    path across the sphere as the scrubber moves rather than teleporting it.
    """

    qubit: int
    points: list[BlochVector]

    @property
    def final(self) -> BlochVector:
        return self.points[-1]

    def to_dict(self) -> dict[str, Any]:
        return {
            "qubit": self.qubit,
            "points": [p.to_dict() for p in self.points],
            "final": self.final.to_dict(),
            #: 1 - |r| : how much of this qubit's state is *not* its own, i.e.
            #: how entangled it is with the rest of the register.
            "mixedness": float(max(0.0, 1.0 - self.final.purity)),
        }


def bloch_traces(states: Sequence[np.ndarray], n: int) -> list[BlochTrace]:
    """Per-qubit Bloch history from a list of statevectors."""
    per_moment = [bloch_vectors_from_state(psi, n) for psi in states]
    return [
        BlochTrace(qubit=q, points=[frame[q] for frame in per_moment]) for q in range(n)
    ]


# --------------------------------------------------------------------------
# Q-sphere
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class QSpherePoint:
    """One basis state, placed on the sphere by Hamming weight and phase.

    Latitude encodes Hamming weight -- |0...0> at the north pole, |1...1> at the
    south -- and longitude spreads the states of equal weight evenly. Radius is
    always 1: the *magnitude* is carried separately, because drawing amplitude
    as radius makes small amplitudes invisible, and drawing it as marker size
    and opacity (what the frontend does) does not.
    """

    index: int
    label: str
    probability: float
    magnitude: float
    phase: float
    hamming_weight: int
    x: float
    y: float
    z: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "label": self.label,
            "probability": self.probability,
            "magnitude": self.magnitude,
            "phase": self.phase,
            "hammingWeight": self.hamming_weight,
            "x": self.x,
            "y": self.y,
            "z": self.z,
        }


def qsphere(
    psi: np.ndarray, n: int, min_probability: float = QSPHERE_MIN_PROBABILITY
) -> list[QSpherePoint]:
    """Q-sphere points for a pure state, ordered by basis index.

    Points below ``min_probability`` are omitted. The phase is relative to the
    first non-negligible amplitude, so a state and its global-phase twin produce
    identical payloads -- otherwise the colour wheel would spin for a change
    that is physically nothing.
    """
    probs = probabilities_from_state(psi)
    keep = [i for i in range(psi.size) if probs[i] > min_probability]
    if not keep:
        return []
    reference = complex(psi[keep[0]])
    ref_phase = math.atan2(reference.imag, reference.real)

    by_weight: dict[int, list[int]] = {}
    for i in keep:
        by_weight.setdefault(int(bin(i).count("1")), []).append(i)

    out: list[QSpherePoint] = []
    for weight, indices in by_weight.items():
        # Latitude: weight 0 -> +z, weight n -> -z, linear in between.
        z = 1.0 - 2.0 * (weight / n) if n else 1.0
        radial = math.sqrt(max(0.0, 1.0 - z * z))
        count = len(indices)
        for rank, i in enumerate(sorted(indices)):
            longitude = 2.0 * math.pi * rank / count if count > 1 else 0.0
            amp = complex(psi[i])
            phase = math.atan2(amp.imag, amp.real) - ref_phase
            # Fold into (-pi, pi] so the frontend's colour wheel is single-valued.
            phase = (phase + math.pi) % (2.0 * math.pi) - math.pi
            out.append(
                QSpherePoint(
                    index=i,
                    label=basis_label(i, n),
                    probability=float(probs[i]),
                    magnitude=float(abs(amp)),
                    phase=float(phase),
                    hamming_weight=weight,
                    x=float(radial * math.cos(longitude)),
                    y=float(radial * math.sin(longitude)),
                    z=float(z),
                )
            )
    out.sort(key=lambda p: p.index)
    return out


# --------------------------------------------------------------------------
# Density-matrix heatmap
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class DensityHeatmap:
    """Magnitude and phase grids for a density matrix, plus its scalar summary."""

    dim: int
    magnitude: list[list[float]]
    phase: list[list[float]]
    labels: list[str]
    purity: float
    trace: float
    #: Von Neumann entropy in bits. 0 for a pure state.
    entropy: float
    max_magnitude: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "dim": self.dim,
            "magnitude": self.magnitude,
            "phase": self.phase,
            "labels": self.labels,
            "purity": self.purity,
            "trace": self.trace,
            "entropy": self.entropy,
            "maxMagnitude": self.max_magnitude,
        }


def density_heatmap(rho: np.ndarray, n: int) -> DensityHeatmap:
    """The heatmap payload: ``|rho_ij|`` and ``arg(rho_ij)`` as two grids.

    Split into magnitude and phase rather than shipping real and imaginary
    parts, because that is what the instrument draws: brightness from one,
    hue from the other. A real-valued density matrix then has a flat hue, which
    is the visual fact a learner should notice.
    """
    dim = int(rho.shape[0])
    if dim > HEATMAP_MAX_DIM:
        raise VisualError(
            f"density heatmap is capped at {HEATMAP_MAX_DIM}x{HEATMAP_MAX_DIM}, "
            f"got {dim}x{dim} ({n} qubits)"
        )
    mag = np.abs(rho)
    ang = np.angle(rho)
    # A zero entry has an arbitrary angle; report 0 so the hue field is smooth.
    ang = np.where(mag > 1e-15, ang, 0.0)
    return DensityHeatmap(
        dim=dim,
        magnitude=[[float(v) for v in row] for row in mag],
        phase=[[float(v) for v in row] for row in ang],
        labels=[basis_label(i, n) for i in range(dim)],
        purity=float(np.real(np.einsum("ij,ji->", rho, rho))),
        trace=float(np.real(np.trace(rho))),
        entropy=von_neumann_entropy(rho),
        max_magnitude=float(mag.max()) if dim else 0.0,
    )


def von_neumann_entropy(rho: np.ndarray) -> float:
    """``-Tr(rho log2 rho)`` in bits, computed from the eigenvalues.

    Eigenvalues of a numerically-derived density matrix routinely come out at
    -1e-17; clipping at zero before the logarithm is the difference between
    "0.0 bits" and "nan".
    """
    vals = np.linalg.eigvalsh(rho)
    vals = np.clip(np.real(vals), 0.0, 1.0)
    nz = vals[vals > 1e-12]
    if nz.size == 0:
        return 0.0
    return float(-np.sum(nz * np.log2(nz)))


# --------------------------------------------------------------------------
# Entanglement graph
# --------------------------------------------------------------------------


def concurrence(rho2: np.ndarray) -> float:
    """Wootters concurrence of a two-qubit state. 0 separable, 1 maximally entangled.

    ``C = max(0, l1 - l2 - l3 - l4)`` where ``l_i`` are the decreasing square
    roots of the eigenvalues of ``rho rho~`` with
    ``rho~ = (Y (x) Y) rho* (Y (x) Y)``. ``rho rho~`` is not Hermitian, so the
    eigenvalues come from the general solver and can carry a tiny imaginary
    part; the real part is taken after clipping, which is safe because the
    spectrum is provably real and non-negative.
    """
    if rho2.shape != (4, 4):
        raise ValueError("concurrence needs a two-qubit density matrix")
    rho_tilde = _YY @ rho2.conj() @ _YY
    vals = np.linalg.eigvals(rho2 @ rho_tilde)
    lam = np.sqrt(np.clip(np.real(vals), 0.0, None))
    lam = np.sort(lam)[::-1]
    return float(max(0.0, lam[0] - lam[1] - lam[2] - lam[3]))


def mutual_information(psi: np.ndarray, n: int, a: int, b: int) -> float:
    """``I(A:B) = S(A) + S(B) - S(AB)`` in bits, for two qubits of a pure state.

    Captures classical *and* quantum correlation, so it is nonzero where
    concurrence is not -- a GHZ state's qubit pairs have zero concurrence
    (their reduced state is separable) but one full bit of mutual information.
    Showing both is the point of the graph: a learner who sees a GHZ state draw
    edges under one measure and not the other has learned something true about
    monogamy of entanglement.
    """
    ra = reduced_density_from_state(psi, n, [a])
    rb = reduced_density_from_state(psi, n, [b])
    rab = reduced_density_from_state(psi, n, [a, b])
    return float(
        von_neumann_entropy(ra) + von_neumann_entropy(rb) - von_neumann_entropy(rab)
    )


@dataclass(frozen=True)
class EntanglementEdge:
    a: int
    b: int
    concurrence: float
    mutual_information: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "a": self.a,
            "b": self.b,
            "concurrence": self.concurrence,
            "mutualInformation": self.mutual_information,
        }


@dataclass(frozen=True)
class EntanglementGraph:
    qubits: int
    #: Single-qubit entanglement entropy S(rho_q), in bits. 1 is maximal.
    node_entropy: list[float]
    edges: list[EntanglementEdge]
    #: True when every node entropy is zero: the register is a product state.
    separable: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "qubits": self.qubits,
            "nodeEntropy": self.node_entropy,
            "edges": [e.to_dict() for e in self.edges],
            "separable": self.separable,
        }


def entanglement_graph(
    psi: np.ndarray, n: int, eps: float = ENTANGLEMENT_EPS
) -> EntanglementGraph:
    """Pairwise concurrence and mutual information over every qubit pair.

    O(n**2) partial traces, each O(2**n): fine up to
    :data:`VISUAL_MAX_QUBITS`, which is the only place this is called from.
    """
    node_entropy = [
        von_neumann_entropy(reduced_density_from_state(psi, n, [q])) for q in range(n)
    ]
    edges: list[EntanglementEdge] = []
    for a in range(n):
        for b in range(a + 1, n):
            rab = reduced_density_from_state(psi, n, [a, b])
            c = concurrence(rab)
            mi = float(
                von_neumann_entropy(reduced_density_from_state(psi, n, [a]))
                + von_neumann_entropy(reduced_density_from_state(psi, n, [b]))
                - von_neumann_entropy(rab)
            )
            if c > eps or abs(mi) > eps:
                edges.append(
                    EntanglementEdge(
                        a=a,
                        b=b,
                        concurrence=c if c > eps else 0.0,
                        mutual_information=mi if abs(mi) > eps else 0.0,
                    )
                )
    return EntanglementGraph(
        qubits=n,
        node_entropy=[e if e > eps else 0.0 for e in node_entropy],
        edges=edges,
        separable=all(e <= eps for e in node_entropy),
    )


# --------------------------------------------------------------------------
# The timeline
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class TimelineFrame:
    """One scrubber position: the state, and what produced it."""

    moment: int
    #: Op ids applied in the moment that *ends* at this frame. Empty at frame 0.
    op_ids: list[str]
    gates: list[str]
    probabilities: list[float]
    #: Interleaved re/im, or ``None`` above :data:`TIMELINE_MAX_QUBITS`.
    statevector: list[float] | None
    #: Total entanglement entropy across single qubits, in bits: a one-number
    #: summary the scrubber can plot as a curve under the circuit.
    entanglement: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "moment": self.moment,
            "opIds": self.op_ids,
            "gates": self.gates,
            "probabilities": self.probabilities,
            "statevector": self.statevector,
            "entanglement": self.entanglement,
        }


def _interleave(vec: np.ndarray) -> list[float]:
    flat = np.empty(vec.size * 2, dtype=np.float64)
    flat[0::2] = vec.real
    flat[1::2] = vec.imag
    return [float(v) for v in flat]


def timeline(
    circuit: Circuit,
    states: Sequence[np.ndarray],
    include_statevector: bool = True,
) -> list[TimelineFrame]:
    n = circuit.qubits
    layers = moments(circuit)
    frames: list[TimelineFrame] = []
    want_amplitudes = include_statevector and n <= TIMELINE_MAX_QUBITS
    for m, psi in enumerate(states):
        layer = layers[m - 1] if m > 0 else []
        ent = sum(
            von_neumann_entropy(reduced_density_from_state(psi, n, [q]))
            for q in range(n)
        )
        frames.append(
            TimelineFrame(
                moment=m,
                op_ids=[op.id for op in layer],
                gates=[op.gate for op in layer],
                probabilities=[float(p) for p in probabilities_from_state(psi)],
                statevector=_interleave(psi) if want_amplitudes else None,
                entanglement=float(ent),
            )
        )
    return frames


# --------------------------------------------------------------------------
# The whole payload
# --------------------------------------------------------------------------


@dataclass
class VisualPayload:
    """Everything the instruments need for one circuit, in one response."""

    qubits: int
    depth: int
    bloch: list[BlochTrace]
    qsphere: list[QSpherePoint]
    density: DensityHeatmap | None
    timeline: list[TimelineFrame]
    entanglement: EntanglementGraph
    probabilities: list[float]
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "qubits": self.qubits,
            "depth": self.depth,
            "bloch": [b.to_dict() for b in self.bloch],
            "qsphere": [p.to_dict() for p in self.qsphere],
            "density": self.density.to_dict() if self.density else None,
            "timeline": [f.to_dict() for f in self.timeline],
            "entanglement": self.entanglement.to_dict(),
            "probabilities": self.probabilities,
            "warnings": self.warnings,
        }


def build_visual(
    circuit: Circuit,
    bindings: dict[str, float] | None = None,
    *,
    include_timeline: bool = True,
    include_density: bool = True,
    include_statevector: bool = True,
) -> VisualPayload:
    """Compute every visual payload for a circuit in a single evolution pass.

    One pass, not five: the Bloch traces, the timeline and the final-state
    payloads all derive from the same list of per-moment statevectors, so
    building them together costs one circuit evolution rather than three.
    """
    n = circuit.qubits
    states, warnings = evolve_by_moment(circuit, bindings)
    final = states[-1]

    density: DensityHeatmap | None = None
    if include_density:
        dim = 1 << n
        if dim <= HEATMAP_MAX_DIM:
            density = density_heatmap(np.outer(final, final.conj()), n)
        else:
            warnings.append(
                f"density heatmap omitted: {dim}x{dim} exceeds the "
                f"{HEATMAP_MAX_DIM}x{HEATMAP_MAX_DIM} payload cap"
            )

    frames = timeline(circuit, states, include_statevector) if include_timeline else []
    if include_timeline and include_statevector and n > TIMELINE_MAX_QUBITS:
        warnings.append(
            f"timeline carries probabilities only above {TIMELINE_MAX_QUBITS} qubits"
        )

    return VisualPayload(
        qubits=n,
        depth=len(states) - 1,
        bloch=bloch_traces(states, n),
        qsphere=qsphere(final, n),
        density=density,
        timeline=frames,
        entanglement=entanglement_graph(final, n),
        probabilities=[float(p) for p in probabilities_from_state(final)],
        warnings=warnings,
    )


__all__ = [
    "ENTANGLEMENT_EPS",
    "HEATMAP_MAX_DIM",
    "QSPHERE_MIN_PROBABILITY",
    "TIMELINE_MAX_QUBITS",
    "VISUAL_MAX_QUBITS",
    "BlochTrace",
    "DensityHeatmap",
    "EntanglementEdge",
    "EntanglementGraph",
    "QSpherePoint",
    "TimelineFrame",
    "VisualError",
    "VisualPayload",
    "bloch_traces",
    "build_visual",
    "concurrence",
    "density_heatmap",
    "entanglement_graph",
    "evolve_by_moment",
    "mutual_information",
    "qsphere",
    "timeline",
    "von_neumann_entropy",
]
