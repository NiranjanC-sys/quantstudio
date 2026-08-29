"""Week 2, Problem A: GHZ In Log Depth. Reference solution.

A chain of CNOTs costs depth n. Doubling the number of entangled qubits at every
layer costs depth 1 + ceil(log2 n): qubit 0 seeds the superposition, then each
already-entangled qubit copies its value onto a fresh one, two copies at a time.
"""

from __future__ import annotations


def solve() -> dict:
    """Return the circuit IR (version 1) for a depth-3 four-qubit GHZ state."""
    return {
        "version": 1,
        "name": "ghz-in-log-depth",
        "qubits": 4,
        "clbits": 0,
        "ops": [
            {"id": "seed", "gate": "h", "targets": [0]},
            {"id": "fan1", "gate": "x", "targets": [1], "controls": [0]},
            {"id": "fan2", "gate": "x", "targets": [2], "controls": [0]},
            {"id": "fan3", "gate": "x", "targets": [3], "controls": [1]},
        ],
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
