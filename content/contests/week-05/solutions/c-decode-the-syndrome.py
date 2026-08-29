"""Week 5, Problem C: Decode The Syndrome. Reference solution.

The fault is in superposition, so the correction has to be a circuit, not an if
statement. Extract the two parities onto ancillas 3 and 4, then apply the lookup
table 10 -> X on qubit 0, 11 -> X on qubit 1, 01 -> X on qubit 2 as three
Toffolis, X-conjugating the ancillas to select the two syndromes that contain a
zero. Every branch of the superposition is corrected at once.
"""

from __future__ import annotations

import math

THETA = math.pi / 4.0

DATA = (0, 1, 2)
ANCILLA = (3, 4)
FAULT = (5, 6)


def _noise() -> list[dict]:
    """The fault model, exactly as printed in the statement."""
    return [
        {"id": "n0", "gate": "h", "targets": [5]},
        {"id": "n1", "gate": "h", "targets": [6]},
        {"id": "n2", "gate": "x", "targets": [6]},
        {"id": "n3", "gate": "x", "targets": [0], "controls": [5, 6]},
        {"id": "n4", "gate": "x", "targets": [6]},
        {"id": "n5", "gate": "x", "targets": [1], "controls": [5, 6]},
        {"id": "n6", "gate": "x", "targets": [5]},
        {"id": "n7", "gate": "x", "targets": [2], "controls": [5, 6]},
        {"id": "n8", "gate": "x", "targets": [5]},
    ]


def solve() -> dict:
    """Return the circuit IR (version 1): encode, fault, extract, correct."""
    ops: list[dict] = [
        {"id": "prep", "gate": "ry", "targets": [0], "params": [THETA]},
        {"id": "spread1", "gate": "x", "targets": [1], "controls": [0]},
        {"id": "spread2", "gate": "x", "targets": [2], "controls": [0]},
    ]
    ops += _noise()
    ops += [
        {"id": "s0a", "gate": "x", "targets": [3], "controls": [0]},
        {"id": "s0b", "gate": "x", "targets": [3], "controls": [1]},
        {"id": "s1a", "gate": "x", "targets": [4], "controls": [1]},
        {"id": "s1b", "gate": "x", "targets": [4], "controls": [2]},
    ]
    ops += [
        {"id": "c11", "gate": "x", "targets": [1], "controls": [3, 4]},
        {"id": "c10a", "gate": "x", "targets": [4]},
        {"id": "c10b", "gate": "x", "targets": [0], "controls": [3, 4]},
        {"id": "c10c", "gate": "x", "targets": [4]},
        {"id": "c01a", "gate": "x", "targets": [3]},
        {"id": "c01b", "gate": "x", "targets": [2], "controls": [3, 4]},
        {"id": "c01c", "gate": "x", "targets": [3]},
    ]
    return {
        "version": 1,
        "name": "decode-the-syndrome",
        "qubits": 7,
        "clbits": 0,
        "ops": ops,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
