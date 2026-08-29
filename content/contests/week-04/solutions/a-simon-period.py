"""Week 4, Problem A: Simon's Period. Reference solution.

f(x0 x1 x2) = (x0 XOR x1, x2) is two-to-one with period s = 110, and it is built
from three CNOTs: two into the first output qubit and one into the second. One
Hadamard sandwich later, every measurement of the query register returns a string
z with z . s = 0 mod 2, drawn uniformly from those four strings.
"""

from __future__ import annotations

QUERY = (0, 1, 2)
OUTPUT = (3, 4)


def solve() -> dict:
    """Return the circuit IR (version 1) for one Simon run on three query bits."""
    ops: list[dict] = [{"id": f"h{q}", "gate": "h", "targets": [q]} for q in QUERY]
    ops += [
        {"id": "o0", "gate": "x", "targets": [3], "controls": [0]},
        {"id": "o1", "gate": "x", "targets": [3], "controls": [1]},
        {"id": "o2", "gate": "x", "targets": [4], "controls": [2]},
    ]
    ops += [{"id": f"g{q}", "gate": "h", "targets": [q]} for q in QUERY]
    return {
        "version": 1,
        "name": "simon-period",
        "qubits": 5,
        "clbits": 0,
        "ops": ops,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
