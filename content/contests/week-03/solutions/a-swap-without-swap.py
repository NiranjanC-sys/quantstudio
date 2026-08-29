"""Week 3, Problem A: SWAP Without SWAP. Reference solution.

Three CNOTs, alternating direction. Each one adds the source register into the
target modulo 2, and after three additions the two registers have exchanged
contents, which is the quantum version of the classical XOR swap trick.
"""

from __future__ import annotations


def solve() -> dict:
    """Return the circuit IR (version 1) implementing SWAP on qubits 0 and 1."""
    return {
        "version": 1,
        "name": "swap-without-swap",
        "qubits": 2,
        "clbits": 0,
        "ops": [
            {"id": "cx1", "gate": "x", "targets": [1], "controls": [0]},
            {"id": "cx2", "gate": "x", "targets": [0], "controls": [1]},
            {"id": "cx3", "gate": "x", "targets": [1], "controls": [0]},
        ],
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
