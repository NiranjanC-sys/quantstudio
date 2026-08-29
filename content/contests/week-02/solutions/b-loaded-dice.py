"""Week 2, Problem B: Loaded Dice. Reference solution.

A two-level amplitude tree. The first Ry sets the marginal of qubit 0, and the
uniformly controlled Ry on qubit 1 sets the two conditional distributions at
once: Ry(alpha), CNOT, Ry(beta), CNOT applies Ry(alpha + beta) when qubit 0 is 0
and Ry(alpha - beta) when it is 1, so solving the two-by-two linear system in
alpha and beta costs two CNOTs rather than four.
"""

from __future__ import annotations

import math

TARGET = (0.1, 0.2, 0.3, 0.4)

#: Marginal of qubit 0: P(0) = 0.1 + 0.2 = 0.3.
THETA_0 = 2.0 * math.acos(math.sqrt(0.3))

#: Conditional angle in the qubit-0 = 0 branch: P(01 | 0) = 0.2 / 0.3.
THETA_A = 2.0 * math.acos(math.sqrt(1.0 / 3.0))

#: Conditional angle in the qubit-0 = 1 branch: P(11 | 1) = 0.4 / 0.7.
THETA_B = 2.0 * math.acos(math.sqrt(3.0 / 7.0))

ALPHA = (THETA_A + THETA_B) / 2.0
BETA = (THETA_A - THETA_B) / 2.0


def solve() -> dict:
    """Return the circuit IR (version 1) preparing the loaded distribution."""
    return {
        "version": 1,
        "name": "loaded-dice",
        "qubits": 2,
        "clbits": 0,
        "ops": [
            {"id": "marginal", "gate": "ry", "targets": [0], "params": [THETA_0]},
            {"id": "mean", "gate": "ry", "targets": [1], "params": [ALPHA]},
            {"id": "cx1", "gate": "x", "targets": [1], "controls": [0]},
            {"id": "diff", "gate": "ry", "targets": [1], "params": [BETA]},
            {"id": "cx2", "gate": "x", "targets": [1], "controls": [0]},
        ],
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
