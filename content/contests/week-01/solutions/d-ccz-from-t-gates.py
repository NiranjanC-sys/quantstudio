"""Week 1, Problem D: CCZ From T Gates. Reference solution.

The standard seven-T, six-CNOT construction. CCZ is diagonal, so it is a sum of
phases on the parities of the three qubits; each CNOT computes one parity into
qubit 2 and each T or T-dagger rotates it by pi/4. The final CNOT pair with T on
qubit 0 and T-dagger on qubit 1 cancels the leftover one-qubit and two-qubit
phase terms.
"""

from __future__ import annotations


def solve() -> dict:
    """Return the circuit IR (version 1) for CCZ on qubits 0, 1 and 2."""
    return {
        "version": 1,
        "name": "ccz-from-t-gates",
        "qubits": 3,
        "clbits": 0,
        "ops": [
            {"id": "cx1", "gate": "x", "targets": [2], "controls": [1]},
            {"id": "t1", "gate": "tdg", "targets": [2]},
            {"id": "cx2", "gate": "x", "targets": [2], "controls": [0]},
            {"id": "t2", "gate": "t", "targets": [2]},
            {"id": "cx3", "gate": "x", "targets": [2], "controls": [1]},
            {"id": "t3", "gate": "tdg", "targets": [2]},
            {"id": "cx4", "gate": "x", "targets": [2], "controls": [0]},
            {"id": "t4", "gate": "t", "targets": [1]},
            {"id": "t5", "gate": "t", "targets": [2]},
            {"id": "cx5", "gate": "x", "targets": [1], "controls": [0]},
            {"id": "t6", "gate": "t", "targets": [0]},
            {"id": "t7", "gate": "tdg", "targets": [1]},
            {"id": "cx6", "gate": "x", "targets": [1], "controls": [0]},
        ],
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
