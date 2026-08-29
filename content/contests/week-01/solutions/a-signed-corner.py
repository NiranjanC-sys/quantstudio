"""Week 1, Problem A: Signed Corner. Reference solution.

Two Hadamards spread the amplitude evenly over the four basis states, and a
single CZ puts the minus sign exactly where |11> lives, because CZ is the only
diagonal two-qubit Clifford whose phase depends on both qubits at once.
"""

from __future__ import annotations


def solve() -> dict:
    """Return the circuit IR (version 1) for the signed uniform state."""
    return {
        "version": 1,
        "name": "signed-corner",
        "qubits": 2,
        "clbits": 0,
        "ops": [
            {"id": "h0", "gate": "h", "targets": [0]},
            {"id": "h1", "gate": "h", "targets": [1]},
            {"id": "cz", "gate": "cz", "targets": [0, 1]},
        ],
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
