"""Week 4, Problem C: The Exact Fourier Transform. Reference solution.

Three Hadamards, three controlled phases and the swap that nobody remembers.
Without the final SWAP the circuit computes the transform with its output bits
reversed, which is a different unitary, not a different convention.
"""

from __future__ import annotations

import math

PI = math.pi


def solve() -> dict:
    """Return the circuit IR (version 1) for the three-qubit QFT."""
    return {
        "version": 1,
        "name": "fourier-transform-exact",
        "qubits": 3,
        "clbits": 0,
        "ops": [
            {"id": "h0", "gate": "h", "targets": [0]},
            {"id": "r01", "gate": "cp", "targets": [0, 1], "params": [PI / 2.0]},
            {"id": "r02", "gate": "cp", "targets": [0, 2], "params": [PI / 4.0]},
            {"id": "h1", "gate": "h", "targets": [1]},
            {"id": "r12", "gate": "cp", "targets": [1, 2], "params": [PI / 2.0]},
            {"id": "h2", "gate": "h", "targets": [2]},
            {"id": "rev", "gate": "swap", "targets": [0, 2]},
        ],
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
