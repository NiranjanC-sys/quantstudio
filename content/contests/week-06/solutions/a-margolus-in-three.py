"""Week 6, Problem A: Margolus In Three. Reference solution.

Four Ry(pi/4) rotations split by three CNOTs. Each CNOT flips the sign of the
half-rotation that follows it, so the four quarter-turns add up to a full X on
the target only when both controls are 1, and cancel otherwise. The price of
dropping from six CNOTs to three is one sign: the amplitude of |011> comes back
negated, which is invisible when the gate is uncomputed later in the same
circuit.
"""

from __future__ import annotations

import math

QUARTER = math.pi / 4.0


def solve() -> dict:
    """Return the circuit IR (version 1) for the relative-phase Toffoli."""
    return {
        "version": 1,
        "name": "margolus-in-three",
        "qubits": 3,
        "clbits": 0,
        "ops": [
            {"id": "r1", "gate": "ry", "targets": [2], "params": [QUARTER]},
            {"id": "cx1", "gate": "x", "targets": [2], "controls": [0]},
            {"id": "r2", "gate": "ry", "targets": [2], "params": [QUARTER]},
            {"id": "cx2", "gate": "x", "targets": [2], "controls": [1]},
            {"id": "r3", "gate": "ry", "targets": [2], "params": [-QUARTER]},
            {"id": "cx3", "gate": "x", "targets": [2], "controls": [0]},
            {"id": "r4", "gate": "ry", "targets": [2], "params": [-QUARTER]},
        ],
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
