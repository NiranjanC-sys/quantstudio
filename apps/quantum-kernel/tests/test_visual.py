"""The visual payloads: correct physics, and shapes the frontend can rely on."""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.ir import Circuit, Op
from app.visual import (
    HEATMAP_MAX_DIM,
    VISUAL_MAX_QUBITS,
    VisualError,
    bloch_traces,
    build_visual,
    concurrence,
    density_heatmap,
    entanglement_graph,
    evolve_by_moment,
    mutual_information,
    qsphere,
    timeline,
    von_neumann_entropy,
)
from tests.conftest import bell, ghz, op, statevector, w_state


# --------------------------------------------------------------------------
# Evolution and Bloch traces
# --------------------------------------------------------------------------


def test_evolution_has_one_frame_per_moment_plus_the_start() -> None:
    states, _ = evolve_by_moment(bell())
    assert len(states) == 3  # |00>, after H, after CNOT
    assert np.allclose(states[0], [1, 0, 0, 0])
    assert np.allclose(states[-1], statevector(bell()))


def test_bloch_trace_starts_at_the_north_pole() -> None:
    states, _ = evolve_by_moment(bell())
    traces = bloch_traces(states, 2)
    assert len(traces) == 2
    for trace in traces:
        first = trace.points[0]
        assert (first.x, first.y, first.z) == (0.0, 0.0, 1.0)


def test_hadamard_moves_the_bloch_vector_to_the_x_axis() -> None:
    circuit = Circuit(qubits=1, ops=[op("h", [0])])
    states, _ = evolve_by_moment(circuit)
    final = bloch_traces(states, 1)[0].final
    assert abs(final.x - 1.0) < 1e-12
    assert abs(final.y) < 1e-12 and abs(final.z) < 1e-12
    assert abs(final.purity - 1.0) < 1e-12


def test_entangled_qubits_have_a_short_bloch_vector() -> None:
    """A maximally entangled qubit sits at the centre of its own sphere."""
    states, _ = evolve_by_moment(bell())
    for trace in bloch_traces(states, 2):
        assert trace.final.purity < 1e-12
        assert trace.to_dict()["mixedness"] > 0.999


def test_bloch_trace_records_the_whole_path() -> None:
    circuit = Circuit(qubits=1, ops=[op("h", [0]), op("s", [0]), op("h", [0])])
    states, _ = evolve_by_moment(circuit)
    trace = bloch_traces(states, 1)[0]
    assert len(trace.points) == 4
    xs = [round(p.x, 6) for p in trace.points]
    assert len(set(xs)) > 1, "the arrow must actually move"


def test_measurement_is_deferred_and_says_so() -> None:
    circuit = Circuit(
        qubits=1, clbits=1, ops=[op("h", [0]), op("measure", [0], cbits=[0])]
    )
    states, warnings = evolve_by_moment(circuit)
    assert any("deferred" in w for w in warnings)
    assert abs(abs(states[-1][0]) - 1 / math.sqrt(2)) < 1e-12


def test_oversized_circuit_is_refused() -> None:
    circuit = Circuit(
        qubits=VISUAL_MAX_QUBITS + 1,
        ops=[op("h", [q]) for q in range(VISUAL_MAX_QUBITS + 1)],
    )
    with pytest.raises(VisualError, match="capped at"):
        evolve_by_moment(circuit)


# --------------------------------------------------------------------------
# Q-sphere
# --------------------------------------------------------------------------


def test_qsphere_drops_empty_basis_states() -> None:
    points = qsphere(statevector(bell()), 2)
    assert {p.label for p in points} == {"00", "11"}


def test_qsphere_places_weight_zero_at_the_north_pole() -> None:
    points = qsphere(statevector(ghz(3)), 3)
    by_label = {p.label: p for p in points}
    assert by_label["000"].z == 1.0
    assert by_label["111"].z == -1.0
    assert by_label["000"].hamming_weight == 0


def test_qsphere_points_lie_on_the_unit_sphere() -> None:
    points = qsphere(statevector(w_state()), 3)
    for p in points:
        assert abs(math.sqrt(p.x**2 + p.y**2 + p.z**2) - 1.0) < 1e-12


def test_qsphere_spreads_equal_weight_states_in_longitude() -> None:
    points = [p for p in qsphere(statevector(w_state()), 3) if p.hamming_weight == 1]
    assert len(points) == 3
    longitudes = sorted(round(math.atan2(p.y, p.x), 6) for p in points)
    assert len(set(longitudes)) == 3, "states of equal weight must not overlap"


def test_qsphere_phase_is_relative_so_global_phase_is_invisible() -> None:
    psi = statevector(bell())
    a = qsphere(psi, 2)
    b = qsphere(psi * np.exp(1j * 0.7), 2)
    for pa, pb in zip(a, b):
        assert abs(pa.phase - pb.phase) < 1e-12


def test_qsphere_records_a_relative_phase() -> None:
    """``h`` then ``z`` puts pi of relative phase on |1>, and it must show."""
    circuit = Circuit(qubits=1, ops=[op("h", [0]), op("z", [0])])
    points = {p.label: p for p in qsphere(statevector(circuit), 1)}
    assert abs(abs(points["1"].phase) - math.pi) < 1e-12
    assert abs(points["0"].phase) < 1e-12


# --------------------------------------------------------------------------
# Density heatmap
# --------------------------------------------------------------------------


def test_density_heatmap_of_a_pure_state() -> None:
    psi = statevector(bell())
    heat = density_heatmap(np.outer(psi, psi.conj()), 2)
    assert heat.dim == 4
    assert abs(heat.trace - 1.0) < 1e-12
    assert abs(heat.purity - 1.0) < 1e-12
    assert heat.entropy < 1e-9
    assert heat.labels == ["00", "01", "10", "11"]
    assert abs(heat.magnitude[0][3] - 0.5) < 1e-12, "the Bell coherence must be present"


def test_density_heatmap_phase_of_a_real_state_is_flat() -> None:
    psi = statevector(bell())
    heat = density_heatmap(np.outer(psi, psi.conj()), 2)
    assert all(abs(v) < 1e-12 for row in heat.phase for v in row)


def test_maximally_mixed_state_has_full_entropy() -> None:
    rho = np.eye(4, dtype=np.complex128) / 4
    heat = density_heatmap(rho, 2)
    assert abs(heat.entropy - 2.0) < 1e-12
    assert abs(heat.purity - 0.25) < 1e-12


def test_heatmap_is_capped() -> None:
    n = 8  # 256 x 256, above the 128 cap
    rho = np.eye(1 << n, dtype=np.complex128) / (1 << n)
    with pytest.raises(VisualError, match="capped"):
        density_heatmap(rho, n)


def test_von_neumann_entropy_clips_negative_eigenvalues() -> None:
    """A numerically-derived rho routinely has -1e-17 eigenvalues; log of that
    is nan, and a nan in a JSON payload breaks the whole instrument."""
    rho = np.array([[1.0, 0.0], [0.0, -1e-17]], dtype=np.complex128)
    assert von_neumann_entropy(rho) == 0.0


# --------------------------------------------------------------------------
# Entanglement
# --------------------------------------------------------------------------


def test_concurrence_of_a_bell_state_is_one() -> None:
    psi = statevector(bell())
    rho = np.outer(psi, psi.conj())
    assert abs(concurrence(rho) - 1.0) < 1e-9


def test_concurrence_of_a_product_state_is_zero() -> None:
    psi = np.zeros(4, dtype=np.complex128)
    psi[0] = 1.0
    assert concurrence(np.outer(psi, psi.conj())) < 1e-12


def test_ghz_pairs_have_no_concurrence_but_full_mutual_information() -> None:
    """Monogamy of entanglement, visible.

    Any two qubits of a GHZ state have a *separable* reduced state -- zero
    concurrence -- yet one full bit of mutual information. Showing both is
    the reason the graph carries two measures instead of one.
    """
    psi = statevector(ghz(3))
    graph = entanglement_graph(psi, 3)
    assert len(graph.edges) == 3
    for edge in graph.edges:
        assert edge.concurrence < 1e-9
        assert abs(edge.mutual_information - 1.0) < 1e-9
    assert all(abs(e - 1.0) < 1e-9 for e in graph.node_entropy)
    assert graph.separable is False


def test_w_state_pairs_are_pairwise_entangled() -> None:
    psi = statevector(w_state())
    graph = entanglement_graph(psi, 3)
    assert len(graph.edges) == 3
    for edge in graph.edges:
        assert edge.concurrence > 0.6, "W states keep pairwise entanglement"


def test_product_state_draws_no_edges() -> None:
    circuit = Circuit(qubits=3, ops=[op("h", [0]), op("x", [1]), op("t", [2])])
    graph = entanglement_graph(statevector(circuit), 3)
    assert graph.edges == []
    assert graph.separable is True


def test_mutual_information_of_a_bell_pair_is_two_bits() -> None:
    psi = statevector(bell())
    assert abs(mutual_information(psi, 2, 0, 1) - 2.0) < 1e-9


# --------------------------------------------------------------------------
# Timeline and the whole payload
# --------------------------------------------------------------------------


def test_timeline_labels_each_moment_with_its_ops() -> None:
    circuit = bell()
    states, _ = evolve_by_moment(circuit)
    frames = timeline(circuit, states)
    assert len(frames) == 3
    assert frames[0].op_ids == [] and frames[0].gates == []
    assert frames[1].gates == ["h"]
    assert frames[2].gates == ["x"]
    assert all(abs(sum(f.probabilities) - 1.0) < 1e-12 for f in frames)


def test_timeline_entanglement_curve_rises_at_the_cnot() -> None:
    circuit = bell()
    states, _ = evolve_by_moment(circuit)
    frames = timeline(circuit, states)
    assert frames[0].entanglement < 1e-12
    assert frames[1].entanglement < 1e-12, "a Hadamard alone entangles nothing"
    assert abs(frames[2].entanglement - 2.0) < 1e-9


def test_timeline_statevector_is_interleaved_re_im() -> None:
    circuit = bell()
    states, _ = evolve_by_moment(circuit)
    frame = timeline(circuit, states)[-1]
    assert frame.statevector is not None
    assert len(frame.statevector) == 8  # 4 amplitudes x 2
    assert abs(frame.statevector[0] - 1 / math.sqrt(2)) < 1e-12
    assert frame.statevector[1] == 0.0


def test_build_visual_produces_every_payload() -> None:
    payload = build_visual(ghz(3)).to_dict()
    assert set(payload) == {
        "qubits", "depth", "bloch", "qsphere", "density", "timeline",
        "entanglement", "probabilities", "warnings",
    }
    assert payload["qubits"] == 3 and payload["depth"] == 3
    assert len(payload["bloch"]) == 3
    assert len(payload["timeline"]) == 4
    assert payload["density"]["dim"] == 8


def test_build_visual_is_json_safe() -> None:
    """A NumPy float in a payload is a 500 at serialisation time."""
    import json

    body = json.dumps(build_visual(w_state()).to_dict())
    assert "NaN" not in body and "Infinity" not in body


def test_build_visual_omits_a_heatmap_that_is_too_large() -> None:
    n = 8  # 256 x 256 exceeds HEATMAP_MAX_DIM
    circuit = Circuit(qubits=n, ops=[op("h", [q]) for q in range(n)])
    payload = build_visual(circuit)
    assert payload.density is None
    assert any("heatmap omitted" in w for w in payload.warnings)
    assert (1 << n) > HEATMAP_MAX_DIM
