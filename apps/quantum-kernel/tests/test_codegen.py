"""Dialect translation: QASM3 round-trips, and every emitted source is exact."""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.backends.native import circuit_unitary, equal_up_to_global_phase
from app.codegen import (
    DIALECTS,
    eval_angle,
    from_qasm3,
    to_cirq_source,
    to_pennylane_source,
    to_qasm3,
    to_qiskit_source,
    to_source,
)
from app.gates import GATES
from app.ir import Circuit, ClassicalCondition, IRError, Op, circuit_hash
from tests.conftest import bell, ghz, op, qft, require_backend


def test_qasm3_round_trips_a_bell_pair() -> None:
    text = to_qasm3(bell())
    back = from_qasm3(text)
    assert back.qubits == 2
    assert circuit_hash(back) == circuit_hash(bell())


@pytest.mark.parametrize("n", [2, 3, 4])
def test_qasm3_round_trips_the_qft(n: int) -> None:
    circuit = qft(n)
    back = from_qasm3(to_qasm3(circuit))
    assert equal_up_to_global_phase(circuit_unitary(back), circuit_unitary(circuit), 1e-10)


def test_qasm3_round_trips_every_unitary_gate() -> None:
    """One circuit per gate, so a broken definition names itself."""
    for key, d in GATES.items():
        if d.category == "nonunitary" or key == "mcx":
            continue
        n = max(3, d.arity)
        params = [0.31 * (i + 1) for i in range(len(d.param_names))]
        circuit = Circuit(
            qubits=n, ops=[Op(gate=key, targets=list(range(d.arity)), params=params)]
        )
        back = from_qasm3(to_qasm3(circuit))
        assert equal_up_to_global_phase(
            circuit_unitary(back), circuit_unitary(circuit), 1e-9
        ), f"{key} did not survive the QASM3 round trip"


def test_qasm_custom_definitions_are_exact() -> None:
    """The gates ``stdgates.inc`` lacks are defined in the preamble, exactly.

    Exactness matters: an ``rzz`` defined only up to a global phase becomes
    wrong the moment a lesson controls it.
    """
    for key in ("sxdg", "cs", "csdg", "csx", "ccz", "rzz", "rxx", "ryy", "rzx", "iswap", "ecr"):
        d = GATES[key]
        params = [0.41 * (i + 1) for i in range(len(d.param_names))]
        circuit = Circuit(
            qubits=d.arity, ops=[Op(gate=key, targets=list(range(d.arity)), params=params)]
        )
        back = from_qasm3(to_qasm3(circuit))
        a, b = circuit_unitary(circuit), circuit_unitary(back)
        assert equal_up_to_global_phase(a, b, 1e-9), f"{key} drifted"


def test_qasm3_emits_measurement_and_conditions() -> None:
    circuit = Circuit(
        qubits=1,
        clbits=1,
        ops=[
            op("measure", [0], cbits=[0]),
            op("x", [0], condition=ClassicalCondition(bits=[0], value=1)),
        ],
    )
    text = to_qasm3(circuit)
    assert "c[0] = measure q[0];" in text
    assert "if (c[0] == 1)" in text
    back = from_qasm3(text)
    assert back.ops[1].condition is not None
    assert back.ops[1].condition.bits == [0] and back.ops[1].condition.value == 1


def test_qasm2_spellings_are_accepted() -> None:
    """A decade of tutorials taught ``qreg``/``creg``/``measure ->``."""
    text = """
    OPENQASM 2.0;
    include "qelib1.inc";
    qreg q[2];
    creg c[2];
    h q[0];
    cx q[0],q[1];
    measure q[0] -> c[0];
    """
    circuit = from_qasm3(text)
    assert circuit.qubits == 2 and circuit.clbits == 2
    assert [o.gate for o in circuit.ops] == ["h", "cx", "measure"]


def test_qasm_comments_are_stripped() -> None:
    text = """
    OPENQASM 3.0;
    include "stdgates.inc";
    qubit[1] q;   // a trailing comment
    /* and a
       block comment */
    h q[0];
    """
    assert [o.gate for o in from_qasm3(text).ops] == ["h"]


def test_qasm_without_qubits_is_rejected() -> None:
    with pytest.raises(IRError, match="no qubits"):
        from_qasm3('OPENQASM 3.0;\ninclude "stdgates.inc";\n')


def test_qasm_unknown_gate_is_rejected() -> None:
    with pytest.raises(IRError, match="unknown gate"):
        from_qasm3("qubit[1] q;\nfrobnicate q[0];")


# --------------------------------------------------------------------------
# The angle expression evaluator
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "expr,expected",
    [
        ("pi", math.pi),
        ("-pi/2", -math.pi / 2),
        ("2*pi/3", 2 * math.pi / 3),
        ("0.5", 0.5),
        ("sqrt(2)", math.sqrt(2)),
        ("sin(0)", 0.0),
        ("pi ** 2", math.pi**2),
    ],
)
def test_eval_angle(expr: str, expected: float) -> None:
    assert abs(eval_angle(expr) - expected) < 1e-12


@pytest.mark.parametrize(
    "expr", ["__import__('os').system('id')", "open('/etc/passwd')", "x + 1", "lambda: 1"]
)
def test_eval_angle_refuses_anything_that_is_not_arithmetic(expr: str) -> None:
    """QASM arrives from learners; an expression parser that can call code is
    a remote-code-execution hole no matter what runs it."""
    with pytest.raises((IRError, SyntaxError, ValueError)):
        eval_angle(expr)


# --------------------------------------------------------------------------
# Source generation
# --------------------------------------------------------------------------


@pytest.mark.parametrize("dialect", DIALECTS)
def test_every_dialect_emits_something_for_a_bell_pair(dialect: str) -> None:
    text = to_source(bell(), dialect)
    assert text.strip()
    assert text.endswith("\n")


def test_to_source_rejects_an_unknown_dialect() -> None:
    with pytest.raises(IRError, match="unknown dialect"):
        to_source(bell(), "brainfuck")


def test_qiskit_source_documents_the_wire_reversal() -> None:
    text = to_qiskit_source(bell())
    assert "N - 1 - q" in text, "the endian translation must be visible in the source"
    assert "MOST significant" in text


def test_cirq_and_pennylane_sources_do_not_reverse() -> None:
    for text in (to_cirq_source(bell()), to_pennylane_source(bell())):
        assert "N - 1 - q" not in text


def test_generated_qiskit_source_runs_and_agrees() -> None:
    """Execute the emitted source and compare against our own simulator."""
    require_backend("aer")
    from app.codegen import from_qiskit

    circuit = ghz(3)
    namespace: dict[str, object] = {}
    exec(compile(to_qiskit_source(circuit), "<qiskit-source>", "exec"), namespace)  # noqa: S102
    qc = namespace["qc"]
    rebuilt = from_qiskit(qc)
    assert equal_up_to_global_phase(
        circuit_unitary(rebuilt), circuit_unitary(circuit), 1e-10
    )


def test_generated_cirq_source_runs_and_agrees() -> None:
    require_backend("cirq")
    import cirq

    circuit = ghz(3)
    namespace: dict[str, object] = {}
    exec(compile(to_cirq_source(circuit), "<cirq-source>", "exec"), namespace)  # noqa: S102
    built = namespace["circuit"]
    qubits = cirq.LineQubit.range(3)
    psi = cirq.Simulator(dtype=np.complex128).simulate(
        built, qubit_order=qubits
    ).final_state_vector
    from tests.conftest import statevector

    assert np.abs(np.asarray(psi) - statevector(circuit)).max() < 1e-9


def test_generated_pennylane_source_runs_and_agrees() -> None:
    require_backend("pennylane")
    circuit = ghz(3)
    namespace: dict[str, object] = {}
    exec(compile(to_pennylane_source(circuit), "<pl-source>", "exec"), namespace)  # noqa: S102
    psi = np.asarray(namespace["circuit"]()).ravel()  # type: ignore[operator]
    from tests.conftest import statevector

    assert np.abs(psi - statevector(circuit)).max() < 1e-9


def test_qiskit_translation_refuses_a_classical_condition() -> None:
    """Better an explicit refusal than a silently different circuit."""
    require_backend("aer")
    from app.codegen import to_qiskit

    circuit = Circuit(
        qubits=1,
        clbits=1,
        ops=[op("x", [0], condition=ClassicalCondition(bits=[0], value=1))],
    )
    with pytest.raises(IRError, match="classical conditions"):
        to_qiskit(circuit)
