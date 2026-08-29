"""Week 3, Problem D: Three CNOTs For The Canonical Gate. Reference solution.

The target is exp(-i(a XX + b YY + c ZZ)/2) with a = pi/3, b = pi/4, c = pi/5.
All three interaction coefficients are non-zero, so the Weyl chamber puts it in
the generic class: three CNOTs are necessary and sufficient.

This is the Vatan and Williams circuit. Writing the target as
exp(i(A XX + B YY + C ZZ)) with A = a/2, B = b/2, C = c/2, the three rotation
angles are 2C - pi/2 on qubit 0, pi/2 - 2A on qubit 1 and 2B - pi/2 on qubit 1,
wrapped in two fixed Rz(pi/2) frame changes.
"""

from __future__ import annotations

import math

PI = math.pi

A_XX = PI / 3.0
B_YY = PI / 4.0
C_ZZ = PI / 5.0

_A = A_XX / 2.0
_B = B_YY / 2.0
_C = C_ZZ / 2.0


def solve() -> dict:
    """Return the circuit IR (version 1) for the canonical two-qubit gate."""
    return {
        "version": 1,
        "name": "three-cnot-canonical",
        "qubits": 2,
        "clbits": 0,
        "ops": [
            {"id": "frame0", "gate": "rz", "targets": [1], "params": [-PI / 2.0]},
            {"id": "cx1", "gate": "x", "targets": [0], "controls": [1]},
            {"id": "zz", "gate": "rz", "targets": [0], "params": [2.0 * _C - PI / 2.0]},
            {"id": "xx", "gate": "ry", "targets": [1], "params": [PI / 2.0 - 2.0 * _A]},
            {"id": "cx2", "gate": "x", "targets": [1], "controls": [0]},
            {"id": "yy", "gate": "ry", "targets": [1], "params": [2.0 * _B - PI / 2.0]},
            {"id": "cx3", "gate": "x", "targets": [0], "controls": [1]},
            {"id": "frame1", "gate": "rz", "targets": [0], "params": [PI / 2.0]},
        ],
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
