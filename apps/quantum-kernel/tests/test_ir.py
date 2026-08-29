"""The IR contract: validation, layering, metrics, canonical form and hashing."""

from __future__ import annotations

import json
import math

import pytest

from app.ir import (
    Circuit,
    ClassicalCondition,
    IRError,
    Op,
    Symbol,
    canonical_string,
    canonicalise,
    circuit_hash,
    empty_circuit,
    equivalent_by_structure,
    free_symbols,
    gate_set,
    has_symbols,
    inverse,
    js_number_to_string,
    layerize,
    metrics,
    moments,
    normalise_op,
    resolve_params,
    round_angle,
    validate,
    validate_or_raise,
)
from tests.conftest import bell, ghz, op

#: The exact JSON from the API contract. Parsing this is the compatibility test.
CONTRACT_JSON = {
    "version": 1,
    "name": "bell",
    "qubits": 2,
    "clbits": 2,
    "ops": [
        {"id": "a", "gate": "h", "targets": [0]},
        {"id": "b", "gate": "x", "targets": [1], "controls": [0]},
        {"id": "c", "gate": "measure", "targets": [0], "cbits": [0]},
    ],
}


def test_the_documented_contract_json_parses() -> None:
    circuit = Circuit.model_validate(CONTRACT_JSON)
    assert circuit.qubits == 2 and circuit.clbits == 2
    assert [o.id for o in circuit.ops] == ["a", "b", "c"]
    assert circuit.ops[1].controls == [0] and circuit.ops[1].targets == [1]
    assert circuit.ops[1].qubits == [0, 1], "controls come first in operand order"
    assert not validate(circuit) or all(i.severity != "error" for i in validate(circuit))


def test_round_trips_through_json() -> None:
    circuit = Circuit.model_validate(CONTRACT_JSON)
    again = Circuit.model_validate(json.loads(circuit.model_dump_json()))
    assert canonical_string(again) == canonical_string(circuit)


def test_missing_ids_are_filled_in() -> None:
    circuit = Circuit(qubits=1, ops=[op("h", [0]), op("x", [0])])
    assert [o.id for o in circuit.ops] == ["op0", "op1"]


def test_duplicate_ids_are_replaced() -> None:
    circuit = Circuit(
        qubits=1, ops=[Op(id="same", gate="h", targets=[0]), Op(id="same", gate="x", targets=[0])]
    )
    assert len({o.id for o in circuit.ops}) == 2


def test_unknown_extra_fields_are_rejected() -> None:
    with pytest.raises(Exception):
        Circuit.model_validate({"version": 1, "qubits": 1, "ops": [], "colour": "red"})


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------


def test_out_of_range_qubit_is_an_error() -> None:
    circuit = Circuit(qubits=2, ops=[op("h", [5])])
    issues = [i for i in validate(circuit) if i.severity == "error"]
    assert issues and "out of range" in issues[0].message


def test_repeated_qubit_is_an_error() -> None:
    circuit = Circuit(qubits=2, ops=[op("cx", [1, 1])])
    assert any("same qubit twice" in i.message for i in validate(circuit))


def test_wrong_arity_is_an_error() -> None:
    circuit = Circuit(qubits=2, ops=[op("cx", [0])])
    assert any("expects 2 target" in i.message for i in validate(circuit))


def test_wrong_parameter_count_is_an_error() -> None:
    circuit = Circuit(qubits=1, ops=[op("rx", [0])])
    assert any("expects 1 parameter" in i.message for i in validate(circuit))


def test_measure_needs_a_classical_bit() -> None:
    circuit = Circuit(qubits=1, clbits=0, ops=[op("measure", [0])])
    assert any("classical bit" in i.message for i in validate(circuit))


def test_unused_qubit_is_only_a_warning() -> None:
    circuit = Circuit(qubits=3, ops=[op("h", [0])])
    issues = validate(circuit)
    assert all(i.severity == "warning" for i in issues)
    validate_or_raise(circuit)  # must not raise


def test_validate_or_raise_carries_the_op_id() -> None:
    circuit = Circuit(qubits=1, ops=[Op(id="bad", gate="h", targets=[9])])
    with pytest.raises(IRError) as excinfo:
        validate_or_raise(circuit)
    assert excinfo.value.op_id == "bad"


def test_condition_value_must_fit_its_bits() -> None:
    circuit = Circuit(
        qubits=1,
        clbits=1,
        ops=[op("x", [0], condition=ClassicalCondition(bits=[0], value=3))],
    )
    assert any("does not fit" in i.message for i in validate(circuit))


# --------------------------------------------------------------------------
# Layering
# --------------------------------------------------------------------------


def test_independent_gates_share_a_layer() -> None:
    circuit = Circuit(qubits=3, ops=[op("h", [0]), op("h", [1]), op("h", [2])])
    assert layerize(circuit) == [0, 0, 0]
    assert len(moments(circuit)) == 1


def test_dependent_gates_stack() -> None:
    circuit = Circuit(qubits=2, ops=[op("h", [0]), op("cx", [0, 1]), op("h", [1])])
    assert layerize(circuit) == [0, 1, 2]


def test_barrier_fences_the_full_width() -> None:
    circuit = Circuit(
        qubits=2, ops=[op("h", [0]), op("barrier", [0, 1]), op("h", [1])]
    )
    layers = layerize(circuit)
    assert layers[2] > layers[0], "a barrier must stop the second h joining layer 0"


def test_measurement_orders_on_the_classical_bit() -> None:
    circuit = Circuit(
        qubits=2,
        clbits=1,
        ops=[op("measure", [0], cbits=[0]), op("measure", [1], cbits=[0])],
    )
    assert layerize(circuit) == [0, 1], "two writes to one clbit cannot share a layer"


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------


def test_metrics_of_a_bell_pair() -> None:
    m = metrics(bell())
    assert m.size == 2 and m.depth == 2
    assert m.two_qubit_gates == 1 and m.single_qubit_gates == 1
    assert m.clifford is True and m.t_count == 0
    assert m.active_qubits == 2


def test_t_count_and_clifford_flag() -> None:
    circuit = Circuit(qubits=1, ops=[op("h", [0]), op("t", [0]), op("tdg", [0])])
    m = metrics(circuit)
    assert m.t_count == 2 and m.clifford is False


def test_barriers_do_not_count_as_gates() -> None:
    circuit = Circuit(qubits=1, ops=[op("h", [0]), op("barrier", [0])])
    m = metrics(circuit)
    assert m.size == 1 and m.depth == 1
    assert m.gate_counts["barrier"] == 1


def test_metrics_dict_is_camel_case_for_typescript() -> None:
    body = metrics(bell()).to_dict()
    assert "twoQubitGates" in body and "tCount" in body and "gateCounts" in body


# --------------------------------------------------------------------------
# Canonical form and hashing
# --------------------------------------------------------------------------


def test_commuting_reorder_hashes_the_same() -> None:
    """The cache collision is the feature: thousands of learners run this circuit."""
    a = Circuit(qubits=2, ops=[op("h", [0]), op("x", [1])])
    b = Circuit(qubits=2, ops=[op("x", [1]), op("h", [0])])
    assert circuit_hash(a) == circuit_hash(b)
    assert equivalent_by_structure(a, b)


def test_dependent_reorder_hashes_differently() -> None:
    a = Circuit(qubits=1, ops=[op("h", [0]), op("t", [0])])
    b = Circuit(qubits=1, ops=[op("t", [0]), op("h", [0])])
    assert circuit_hash(a) != circuit_hash(b)


def test_controlled_alias_and_explicit_control_agree() -> None:
    alias = Circuit(qubits=2, ops=[op("cx", [0, 1])])
    explicit = Circuit(qubits=2, ops=[op("x", [1], controls=[0])])
    assert circuit_hash(alias) == circuit_hash(explicit)


def test_barriers_do_not_affect_the_hash() -> None:
    a = Circuit(qubits=1, ops=[op("h", [0])])
    b = Circuit(qubits=1, ops=[op("h", [0]), op("barrier", [0])])
    assert circuit_hash(a) == circuit_hash(b)


def test_name_and_metadata_do_not_affect_the_hash() -> None:
    a = Circuit(qubits=1, name="one", ops=[op("h", [0])], metadata={"x": 1})
    b = Circuit(qubits=1, name="two", ops=[op("h", [0])])
    assert circuit_hash(a) == circuit_hash(b)


def test_angle_noise_below_the_precision_collides() -> None:
    a = Circuit(qubits=1, ops=[op("rx", [0], [0.5])])
    b = Circuit(qubits=1, ops=[op("rx", [0], [0.5 + 1e-14])])
    assert circuit_hash(a) == circuit_hash(b)


def test_meaningfully_different_angles_do_not_collide() -> None:
    a = Circuit(qubits=1, ops=[op("rx", [0], [0.5])])
    b = Circuit(qubits=1, ops=[op("rx", [0], [0.5001])])
    assert circuit_hash(a) != circuit_hash(b)


def test_hash_is_sixteen_hex_characters() -> None:
    h = circuit_hash(bell())
    assert len(h) == 16 and all(c in "0123456789abcdef" for c in h)


def test_hash_is_stable_across_calls() -> None:
    assert circuit_hash(ghz(4)) == circuit_hash(ghz(4))


def test_round_angle_folds_into_the_principal_branch() -> None:
    assert abs(round_angle(3 * math.pi) - math.pi) < 1e-12
    assert round_angle(0.0) == 0.0
    assert abs(round_angle(2 * math.pi)) < 1e-12


@pytest.mark.parametrize(
    "value,expected",
    [
        (0.0, "0"),
        (1.0, "1"),
        (-1.5, "-1.5"),
        (100.0, "100"),
        (1e21, "1e+21"),
        (1e-7, "1e-7"),
        (0.000001, "0.000001"),
    ],
)
def test_js_number_formatting_matches_javascript(value: float, expected: str) -> None:
    """The canonical string has to be byte-identical to the TypeScript engine's."""
    assert js_number_to_string(value) == expected


def test_normalise_op_expands_aliases() -> None:
    out = normalise_op(op("ccx", [0, 1, 2]))
    assert out.gate == "x" and out.controls == [0, 1] and out.targets == [2]


# --------------------------------------------------------------------------
# Symbols and inversion
# --------------------------------------------------------------------------


def test_symbolic_parameters_round_trip() -> None:
    circuit = Circuit(
        qubits=1, ops=[Op(gate="rx", targets=[0], params=[Symbol(symbol="theta")])]
    )
    assert has_symbols(circuit) and free_symbols(circuit) == ["theta"]
    assert resolve_params(circuit.ops[0].params, {"theta": 0.25}) == [0.25]


def test_unbound_symbol_raises() -> None:
    with pytest.raises(IRError, match="unbound parameter"):
        resolve_params([Symbol(symbol="theta")], {})


def test_inverse_reverses_and_daggers() -> None:
    circuit = Circuit(qubits=1, ops=[op("t", [0]), op("rx", [0], [0.3])])
    inv = inverse(circuit)
    assert [o.gate for o in inv.ops] == ["rx", "tdg"], (
        "the inverse runs backwards and daggers each gate"
    )
    assert inv.ops[0].params == [-0.3]


def test_inverse_undoes_the_circuit() -> None:
    from app.backends.native import circuit_unitary
    import numpy as np

    circuit = Circuit(
        qubits=2, ops=[op("h", [0]), op("cx", [0, 1]), op("rz", [1], [0.7]), op("s", [0])]
    )
    combined = Circuit(qubits=2, ops=[*circuit.ops, *inverse(circuit).ops])
    assert np.allclose(circuit_unitary(combined), np.eye(4), atol=1e-12)


def test_inverse_rejects_a_measurement() -> None:
    circuit = Circuit(qubits=1, clbits=1, ops=[op("measure", [0], cbits=[0])])
    with pytest.raises(IRError, match="no defined inverse"):
        inverse(circuit)


def test_gate_set_and_empty_circuit() -> None:
    assert gate_set(bell()) == {"h", "x"}
    e = empty_circuit(3)
    assert e.qubits == 3 and e.clbits == 3 and e.ops == []
