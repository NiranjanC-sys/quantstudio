"""Week 6, Problem B: The Fredkin Budget. Reference solution.

CSWAP(0; 1, 2) = CX(2 -> 1) CCX(0, 1 -> 2) CX(2 -> 1). The two outer CNOTs turn
the exchange into a single controlled flip, and the Toffoli in the middle is the
seven-T, six-CNOT circuit conjugated by Hadamards on its target. Eight two-qubit
gates in total, T-count seven, no gate touching three wires at once.
"""

from __future__ import annotations


def _ccz(target: int) -> list[dict]:
    """The standard seven-T CCZ on qubits 0, 1 and `target`."""
    t = target
    return [
        {"id": "z1", "gate": "x", "targets": [t], "controls": [1]},
        {"id": "z2", "gate": "tdg", "targets": [t]},
        {"id": "z3", "gate": "x", "targets": [t], "controls": [0]},
        {"id": "z4", "gate": "t", "targets": [t]},
        {"id": "z5", "gate": "x", "targets": [t], "controls": [1]},
        {"id": "z6", "gate": "tdg", "targets": [t]},
        {"id": "z7", "gate": "x", "targets": [t], "controls": [0]},
        {"id": "z8", "gate": "t", "targets": [1]},
        {"id": "z9", "gate": "t", "targets": [t]},
        {"id": "z10", "gate": "x", "targets": [1], "controls": [0]},
        {"id": "z11", "gate": "t", "targets": [0]},
        {"id": "z12", "gate": "tdg", "targets": [1]},
        {"id": "z13", "gate": "x", "targets": [1], "controls": [0]},
    ]


def solve() -> dict:
    """Return the circuit IR (version 1) for the controlled swap."""
    ops: list[dict] = [{"id": "fold", "gate": "x", "targets": [1], "controls": [2]}]
    ops += [{"id": "hin", "gate": "h", "targets": [2]}]
    ops += _ccz(2)
    ops += [{"id": "hout", "gate": "h", "targets": [2]}]
    ops += [{"id": "unfold", "gate": "x", "targets": [1], "controls": [2]}]
    return {
        "version": 1,
        "name": "fredkin-budget",
        "qubits": 3,
        "clbits": 0,
        "ops": ops,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
