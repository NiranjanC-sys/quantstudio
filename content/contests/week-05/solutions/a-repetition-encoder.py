"""Week 5, Problem A: The Repetition Encoder. Reference solution.

Ry(pi/4) prepares cos(pi/8)|0> + sin(pi/8)|1> on qubit 0, and two CNOTs spread
that single amplitude pair across the codewords |000> and |111>. Nothing is
copied: the CNOTs entangle, and the no-cloning theorem is untouched.
"""

from __future__ import annotations

import math

#: Ry(pi/4) gives cos(pi/8) on |0> and sin(pi/8) on |1>.
THETA = math.pi / 4.0


def solve() -> dict:
    """Return the circuit IR (version 1) for the encoded logical state."""
    return {
        "version": 1,
        "name": "repetition-encoder",
        "qubits": 3,
        "clbits": 0,
        "ops": [
            {"id": "prep", "gate": "ry", "targets": [0], "params": [THETA]},
            {"id": "spread1", "gate": "x", "targets": [1], "controls": [0]},
            {"id": "spread2", "gate": "x", "targets": [2], "controls": [0]},
        ],
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
