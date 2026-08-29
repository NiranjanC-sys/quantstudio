"""Week 1, Problem B: Three-Qubit W State. Reference solution.

The cascade moves one excitation down the register. Start with the excitation
on qubit 0, split off a 1/sqrt(3) share with a controlled Ry, hand the rest to
qubit 1 with a CNOT, then split that remainder in half and hand it to qubit 2.
Four two-qubit gates, no ancilla, no Toffoli.
"""

from __future__ import annotations

import math

#: 2*arccos(1/sqrt(3)). Leaves 1/sqrt(3) of the amplitude on qubit 0.
THETA_1 = 2.0 * math.acos(1.0 / math.sqrt(3.0))

#: A half-and-half split of what is left.
THETA_2 = math.pi / 2.0


def solve() -> dict:
    """Return the circuit IR (version 1) for the three-qubit W state."""
    return {
        "version": 1,
        "name": "w-state-cascade",
        "qubits": 3,
        "clbits": 0,
        "ops": [
            {"id": "seed", "gate": "x", "targets": [0]},
            {"id": "split1", "gate": "ry", "targets": [1], "controls": [0], "params": [THETA_1]},
            {"id": "move1", "gate": "x", "targets": [0], "controls": [1]},
            {"id": "split2", "gate": "ry", "targets": [2], "controls": [1], "params": [THETA_2]},
            {"id": "move2", "gate": "x", "targets": [1], "controls": [2]},
        ],
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
