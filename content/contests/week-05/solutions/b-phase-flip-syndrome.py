"""Week 5, Problem B: Phase-Flip Syndrome. Reference solution.

The phase-flip code is the bit-flip code read in the X basis, and its syndrome
extraction is the same trick read the same way: rotate the data into the Z basis
with three Hadamards, copy the two adjacent parities onto the ancillas with four
CNOTs, then rotate back. A Z error on qubit 1 anticommutes with both stabilisers
X0 X1 and X1 X2, so the ancillas come out holding 11.
"""

from __future__ import annotations

import math

THETA = math.pi / 4.0

DATA = (0, 1, 2)


def solve() -> dict:
    """Return the circuit IR (version 1): encode, error, syndrome extraction."""
    ops: list[dict] = [
        {"id": "prep", "gate": "ry", "targets": [0], "params": [THETA]},
        {"id": "spread1", "gate": "x", "targets": [1], "controls": [0]},
        {"id": "spread2", "gate": "x", "targets": [2], "controls": [0]},
    ]
    ops += [{"id": f"enc{q}", "gate": "h", "targets": [q]} for q in DATA]
    ops += [{"id": "fault", "gate": "z", "targets": [1]}]
    ops += [{"id": f"rot{q}", "gate": "h", "targets": [q]} for q in DATA]
    ops += [
        {"id": "s0a", "gate": "x", "targets": [3], "controls": [0]},
        {"id": "s0b", "gate": "x", "targets": [3], "controls": [1]},
        {"id": "s1a", "gate": "x", "targets": [4], "controls": [1]},
        {"id": "s1b", "gate": "x", "targets": [4], "controls": [2]},
    ]
    ops += [{"id": f"back{q}", "gate": "h", "targets": [q]} for q in DATA]
    return {
        "version": 1,
        "name": "phase-flip-syndrome",
        "qubits": 5,
        "clbits": 0,
        "ops": ops,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
