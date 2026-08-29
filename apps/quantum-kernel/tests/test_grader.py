"""The autograder: every assertion kind, and the quality of what it says on failure.

A failing assertion's message is the whole pedagogical payload, so these tests
assert on the *text* as well as the verdict. "expected amplitude 0.7071 on |01>,
got 0.0000" is the contract; "False" is not.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.grader import (
    CountsContains,
    CustomPython,
    DistributionClose,
    GateSetSubset,
    GradeContext,
    GradeError,
    ResourceBound,
    StatevectorEquals,
    UnitaryEquals,
    check,
    chi_square_pvalue,
    format_amplitude,
    grade,
    parse_expected_state,
    total_variation_distance,
)
from app.ir import Circuit, Op
from tests.conftest import S2, bell, ghz, op

BELL_EXPECTED = {"00": [S2, 0.0], "11": [S2, 0.0]}


def only(circuit: Circuit, assertion) -> object:
    return grade(circuit, [assertion]).outcomes[0]


# --------------------------------------------------------------------------
# statevector_equals
# --------------------------------------------------------------------------


def test_statevector_equals_passes_on_the_right_state() -> None:
    outcome = only(bell(), StatevectorEquals(expected=BELL_EXPECTED))
    assert outcome.passed
    assert "match" in outcome.message


def test_statevector_equals_names_the_offending_amplitude() -> None:
    """The message is the contract, not just the verdict."""
    outcome = only(bell(), StatevectorEquals(expected={"01": [S2, 0.0], "10": [S2, 0.0]}))
    assert not outcome.passed
    assert "expected amplitude 0.7071 on |01>, got 0.0000" in outcome.message
    assert outcome.detail["mismatches"] == 4
    assert outcome.detail["worstLabel"] in {"00", "01", "10", "11"}


def test_statevector_equals_ignores_global_phase_by_default() -> None:
    outcome = only(
        bell(), StatevectorEquals(expected={"00": [0.0, S2], "11": [0.0, S2]})
    )
    assert outcome.passed, outcome.message


def test_statevector_equals_can_demand_the_exact_phase() -> None:
    outcome = only(
        bell(),
        StatevectorEquals(
            expected={"00": [0.0, S2], "11": [0.0, S2]}, up_to_global_phase=False
        ),
    )
    assert not outcome.passed
    assert "up to a global phase" in outcome.message
    assert outcome.detail.get("globalPhaseOnly") is True


def test_statevector_equals_accepts_a_dense_interleaved_array() -> None:
    outcome = only(
        bell(), StatevectorEquals(expected=[S2, 0.0, 0.0, 0.0, 0.0, 0.0, S2, 0.0])
    )
    assert outcome.passed


def test_statevector_equals_accepts_a_real_only_array() -> None:
    outcome = only(bell(), StatevectorEquals(expected=[S2, 0.0, 0.0, S2]))
    assert outcome.passed


def test_statevector_equals_respects_the_tolerance() -> None:
    nudged = {"00": [S2 + 1e-4, 0.0], "11": [S2, 0.0]}
    assert not only(bell(), StatevectorEquals(expected=nudged)).passed
    assert only(bell(), StatevectorEquals(expected=nudged, tolerance=1e-3)).passed


def test_statevector_equals_rejects_a_malformed_label() -> None:
    outcome = only(bell(), StatevectorEquals(expected={"0": [1.0, 0.0]}))
    assert not outcome.passed
    assert "misconfigured" in outcome.message
    assert "leftmost" in outcome.message, "the message must explain the convention"


def test_parse_expected_state_strips_ket_notation() -> None:
    vec = parse_expected_state({"|01>": [1.0, 0.0]}, 2)
    assert vec[1] == 1.0


def test_parse_expected_state_rejects_the_wrong_length() -> None:
    with pytest.raises(GradeError, match="needs"):
        parse_expected_state([1.0, 0.0, 0.0], 2)


# --------------------------------------------------------------------------
# unitary_equals
# --------------------------------------------------------------------------


def test_unitary_equals_passes_on_the_right_operator() -> None:
    from app.backends.native import circuit_unitary

    u = circuit_unitary(bell())
    expected = {"re": u.real.tolist(), "im": u.imag.tolist()}
    assert only(bell(), UnitaryEquals(expected=expected)).passed


def test_unitary_equals_names_the_offending_entry() -> None:
    identity = np.eye(4)
    outcome = only(
        bell(), UnitaryEquals(expected={"re": identity.tolist(), "im": (identity * 0).tolist()})
    )
    assert not outcome.passed
    assert "at row |" in outcome.message and "column |" in outcome.message
    assert outcome.detail["worstEntry"]


def test_unitary_equals_rejects_the_wrong_shape() -> None:
    outcome = only(bell(), UnitaryEquals(expected={"re": np.eye(2).tolist()}))
    assert not outcome.passed
    assert "misconfigured" in outcome.message


def test_unitary_equals_refuses_a_circuit_with_a_measurement() -> None:
    circuit = Circuit(qubits=1, clbits=1, ops=[op("measure", [0], cbits=[0])])
    outcome = only(circuit, UnitaryEquals(expected={"re": np.eye(2).tolist()}))
    assert not outcome.passed


# --------------------------------------------------------------------------
# distribution_close
# --------------------------------------------------------------------------


def test_distribution_close_passes_on_a_fair_bell_pair() -> None:
    circuit = Circuit(
        qubits=2,
        clbits=2,
        ops=[
            op("h", [0]),
            op("cx", [0, 1]),
            op("measure", [0], cbits=[0]),
            op("measure", [1], cbits=[1]),
        ],
    )
    outcome = only(
        circuit, DistributionClose(expected={"00": 0.5, "11": 0.5}, shots=4096, seed=11)
    )
    assert outcome.passed, outcome.message
    assert outcome.detail["tvd"] < 0.05
    assert outcome.detail["pValue"] > 0.01


def test_distribution_close_reports_both_measures_on_failure() -> None:
    circuit = Circuit(
        qubits=2,
        clbits=2,
        ops=[
            op("h", [0]),
            op("cx", [0, 1]),
            op("measure", [0], cbits=[0]),
            op("measure", [1], cbits=[1]),
        ],
    )
    outcome = only(
        circuit, DistributionClose(expected={"00": 0.9, "11": 0.1}, shots=4096, seed=11)
    )
    assert not outcome.passed
    assert "expected P(00) = 0.9000" in outcome.message
    assert "total variation distance" in outcome.message
    assert "chi-square" in outcome.message


def test_chi_square_catches_what_tvd_alone_would_miss() -> None:
    """A 52/48 split is within any sane TVD budget but statistically impossible
    at a million shots. Requiring both measures is what makes the grader
    reproducible for a contest and arguable for a marginal submission."""
    observed = {"0": 520_000, "1": 480_000}
    expected = {"0": 0.5, "1": 0.5}
    assert total_variation_distance({"0": 0.52, "1": 0.48}, expected) == pytest.approx(0.02)
    _, p, _ = chi_square_pvalue(observed, expected, 1_000_000)
    assert p < 1e-9, "at a million shots this is not sampling noise"
    _, p_small, _ = chi_square_pvalue({"0": 52, "1": 48}, expected, 100)
    assert p_small > 0.05, "at a hundred shots the same split is unremarkable"


def test_chi_square_pools_rare_categories() -> None:
    """Expected counts below five break the chi-square approximation."""
    observed = {"0": 999, "1": 1}
    stat, p, dof = chi_square_pvalue(observed, {"0": 0.999, "1": 0.001}, 1000)
    assert dof >= 0 and 0.0 <= p <= 1.0


def test_distribution_close_normalises_a_hand_written_target() -> None:
    circuit = Circuit(
        qubits=1, clbits=1, ops=[op("h", [0]), op("measure", [0], cbits=[0])]
    )
    outcome = only(
        circuit, DistributionClose(expected={"0": 1.0, "1": 1.0}, shots=2048, seed=2)
    )
    assert outcome.passed
    assert outcome.detail["renormalisedExpected"] is True


def test_distribution_close_rejects_an_all_zero_target() -> None:
    outcome = only(bell(), DistributionClose(expected={"00": 0.0}))
    assert not outcome.passed and "misconfigured" in outcome.message


# --------------------------------------------------------------------------
# counts_contains
# --------------------------------------------------------------------------


def test_counts_contains_passes_when_the_outcomes_appear() -> None:
    outcome = only(
        ghz(3), CountsContains(outcomes={"000": 0.4, "111": 0.4}, shots=2000, seed=3)
    )
    assert outcome.passed


def test_counts_contains_names_the_missing_outcome() -> None:
    outcome = only(
        ghz(3), CountsContains(outcomes={"010": 0.2}, shots=2000, seed=3)
    )
    assert not outcome.passed
    assert "expected outcome 010 in at least 20.0% of shots" in outcome.message


def test_counts_contains_enforces_forbidden_outcomes() -> None:
    outcome = only(
        ghz(3), CountsContains(forbidden={"000": 0.1}, shots=2000, seed=3)
    )
    assert not outcome.passed
    assert "should appear in at most" in outcome.message


# --------------------------------------------------------------------------
# resource_bound
# --------------------------------------------------------------------------


def test_resource_bound_passes_within_budget() -> None:
    outcome = only(bell(), ResourceBound(max_depth=2, max_two_qubit_gates=1, max_qubits=2))
    assert outcome.passed
    assert "within budget" in outcome.message


def test_resource_bound_reports_the_overage() -> None:
    outcome = only(ghz(4), ResourceBound(max_two_qubit_gates=1))
    assert not outcome.passed
    assert "expected at most 1 two-qubit gates, got 3 (2 over budget)" in outcome.message


def test_resource_bound_checks_every_dimension() -> None:
    circuit = Circuit(qubits=1, ops=[op("t", [0]), op("t", [0]), op("t", [0])])
    assert not only(circuit, ResourceBound(max_t_count=2)).passed
    assert only(circuit, ResourceBound(max_t_count=3)).passed
    assert not only(circuit, ResourceBound(max_size=2)).passed
    assert not only(circuit, ResourceBound(max_depth=2)).passed


def test_resource_bound_with_no_limits_is_a_content_bug() -> None:
    outcome = only(bell(), ResourceBound())
    assert not outcome.passed
    assert "misconfigured" in outcome.message


# --------------------------------------------------------------------------
# gate_set_subset
# --------------------------------------------------------------------------


def test_gate_set_subset_passes_and_names_what_was_used() -> None:
    outcome = only(bell(), GateSetSubset(allowed=["h", "x", "cx"]))
    assert outcome.passed and "h" in outcome.message


def test_gate_set_subset_names_the_disallowed_gate() -> None:
    outcome = only(bell(), GateSetSubset(allowed=["h"]))
    assert not outcome.passed
    assert "allows only {h}" in outcome.message and "uses x" in outcome.message
    assert outcome.detail["disallowed"] == ["x"]


def test_gate_set_subset_permits_structural_gates_by_default() -> None:
    circuit = Circuit(
        qubits=1, clbits=1, ops=[op("h", [0]), op("barrier", [0]), op("measure", [0], cbits=[0])]
    )
    assert only(circuit, GateSetSubset(allowed=["h"])).passed
    assert not only(circuit, GateSetSubset(allowed=["h"], allow_structural=False)).passed


def test_gate_set_subset_rejects_a_gate_that_does_not_exist() -> None:
    outcome = only(bell(), GateSetSubset(allowed=["hadamard"]))
    assert not outcome.passed and "do not exist" in outcome.message


# --------------------------------------------------------------------------
# custom_python
# --------------------------------------------------------------------------


def test_custom_python_sees_the_simulation_results() -> None:
    outcome = only(
        bell(),
        CustomPython(
            source=(
                "PASSED = abs(PROBABILITIES[0] - 0.5) < 1e-9 and N == 2\n"
                "MESSAGE = 'P(00) = %.4f' % PROBABILITIES[0]"
            )
        ),
    )
    assert outcome.passed, outcome.message
    assert outcome.message == "P(00) = 0.5000"


def test_custom_python_can_fail_with_its_own_message() -> None:
    outcome = only(
        bell(), CustomPython(source="PASSED = False\nMESSAGE = 'not entangled enough'")
    )
    assert not outcome.passed
    assert outcome.message == "not entangled enough"


def test_custom_python_receives_the_circuit_metrics() -> None:
    outcome = only(
        ghz(3),
        CustomPython(
            source="PASSED = METRICS['twoQubitGates'] == 2 and 'h' in GATES"
        ),
    )
    assert outcome.passed, outcome.message


def test_custom_python_runs_under_the_import_allowlist() -> None:
    """The check is learner-visible content, so it gets the learner's sandbox."""
    outcome = only(bell(), CustomPython(source="import os\nPASSED = True"))
    assert not outcome.passed
    assert "did not run" in outcome.message
    assert outcome.detail["sandboxStatus"] == "denied_import"


def test_custom_python_may_use_numpy() -> None:
    outcome = only(
        bell(),
        CustomPython(source="import numpy as np\nPASSED = bool(np.isclose(sum(PROBABILITIES), 1.0))"),
    )
    assert outcome.passed, outcome.message


def test_custom_python_that_never_sets_passed_fails_clearly() -> None:
    outcome = only(bell(), CustomPython(source="x = 1"))
    assert not outcome.passed


# --------------------------------------------------------------------------
# The report
# --------------------------------------------------------------------------


def test_every_assertion_runs_even_after_one_fails() -> None:
    """A learner deserves the full list of what is wrong, not the first item."""
    report = grade(
        bell(),
        [
            StatevectorEquals(expected=BELL_EXPECTED),
            GateSetSubset(allowed=["h"]),
            ResourceBound(max_depth=2),
        ],
    )
    assert [o.passed for o in report.outcomes] == [True, False, True]
    assert report.passed is False
    assert report.score == 2.0 and report.max_score == 3.0
    assert report.fraction == pytest.approx(2 / 3)


def test_points_are_weighted() -> None:
    report = grade(
        bell(),
        [
            StatevectorEquals(expected=BELL_EXPECTED, points=3.0),
            GateSetSubset(allowed=["h"], points=7.0),
        ],
    )
    assert report.score == 3.0 and report.max_score == 10.0


def test_hint_is_revealed_only_on_failure() -> None:
    passing = only(bell(), StatevectorEquals(expected=BELL_EXPECTED, hint="secret"))
    failing = only(bell(), GateSetSubset(allowed=["h"], hint="try only h and cx"))
    assert "hint" not in passing.to_dict()
    assert failing.to_dict()["hint"] == "try only h and cx"


def test_invalid_circuit_fails_the_whole_report_once() -> None:
    circuit = Circuit(qubits=1, ops=[Op(gate="h", targets=[7])])
    report = grade(circuit, [StatevectorEquals(expected=[1.0, 0.0])])
    assert report.passed is False and report.score == 0.0
    assert "not valid" in report.outcomes[0].message


def test_report_is_json_safe_and_camel_case() -> None:
    import json

    body = grade(bell(), [StatevectorEquals(expected=BELL_EXPECTED)]).to_dict()
    assert set(body) >= {"passed", "score", "maxScore", "fraction", "assertions", "metrics"}
    json.dumps(body)


def test_context_simulates_once_for_many_assertions() -> None:
    """Three statevector assertions must not cost three simulations."""
    calls = {"n": 0}
    from app.backends.native import NativeBackend

    class Counting(NativeBackend):
        def run(self, circuit, options):  # type: ignore[override]
            calls["n"] += 1
            return super().run(circuit, options)

    grade(
        bell(),
        [StatevectorEquals(expected=BELL_EXPECTED) for _ in range(3)],
        backend=Counting(),
    )
    assert calls["n"] == 1


def test_format_amplitude_reads_like_a_lesson() -> None:
    assert format_amplitude(complex(0.7071067, 0.0)) == "0.7071"
    assert format_amplitude(complex(0.0, -1.0)) == "-1.0000i"
    assert format_amplitude(complex(0.5, 0.5)) == "0.5000+0.5000i"


def test_distribution_failure_message_is_deterministic() -> None:
    """Two equally-wrong outcomes must always name the same one.

    ``max`` over a set returns the first maximal element in iteration order,
    and set iteration order depends on ``PYTHONHASHSEED``. A contest that
    reruns a seeded submission has to produce the identical message.
    """
    circuit = Circuit(
        qubits=1, clbits=1, ops=[op("h", [0]), op("measure", [0], cbits=[0])]
    )
    messages = {
        grade(
            circuit,
            [DistributionClose(expected={"0": 0.9, "1": 0.1}, shots=1024, seed=5)],
        ).outcomes[0].message
        for _ in range(3)
    }
    assert len(messages) == 1
