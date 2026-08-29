"""Week 3, Problem C: CNOT From iSWAP. Reference solution.

iSWAP is a maximally entangling gate, so two of them are enough for a CNOT, and
one is provably not: iSWAP sits at the same point of the Weyl chamber as SWAP
along one axis and needs a partner to cancel the exchange it performs.

The five-op form below was found by an exhaustive search over the Clifford-plus-
SX single-qubit layers, which is why it is so short: one Hadamard between the two
iSWAPs, then S-dagger and SX to fix the local frames.
"""

from __future__ import annotations


def solve() -> dict:
    """Return the circuit IR (version 1) for CNOT with control 0 and target 1."""
    return {
        "version": 1,
        "name": "cnot-from-iswap",
        "qubits": 2,
        "clbits": 0,
        "ops": [
            {"id": "is1", "gate": "iswap", "targets": [0, 1]},
            {"id": "mid", "gate": "h", "targets": [0]},
            {"id": "is2", "gate": "iswap", "targets": [0, 1]},
            {"id": "fix0", "gate": "sdg", "targets": [0]},
            {"id": "fix1", "gate": "sx", "targets": [1]},
        ],
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
