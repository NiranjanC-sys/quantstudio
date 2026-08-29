"""Week 1, Problem C: Majority Phase Oracle. Reference solution.

MAJ(a, b, c) = ab XOR bc XOR ca on the parity that matters here: the number of
pairs set to 1 is 0, 1 or 3, so (-1)^MAJ factorises into three independent
pairwise signs. Three CZ gates, one per pair, and no Toffoli anywhere.
"""

from __future__ import annotations


def solve() -> dict:
    """Return the circuit IR (version 1): Hadamard layer, then the oracle."""
    return {
        "version": 1,
        "name": "majority-phase-oracle",
        "qubits": 3,
        "clbits": 0,
        "ops": [
            {"id": "h0", "gate": "h", "targets": [0]},
            {"id": "h1", "gate": "h", "targets": [1]},
            {"id": "h2", "gate": "h", "targets": [2]},
            {"id": "p01", "gate": "cz", "targets": [0, 1]},
            {"id": "p12", "gate": "cz", "targets": [1, 2]},
            {"id": "p02", "gate": "cz", "targets": [0, 2]},
        ],
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
