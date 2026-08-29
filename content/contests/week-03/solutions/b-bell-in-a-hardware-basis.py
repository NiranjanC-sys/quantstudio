"""Week 3, Problem B: Bell In A Hardware Basis. Reference solution.

Two rewrites and nothing else. H = Rz(pi/2) SX Rz(pi/2) up to a global phase,
and CX(0 -> 1) = (I x H) CZ (I x H), so the Bell preparation becomes three
compiled Hadamards around a single CZ.
"""

from __future__ import annotations

import math

HALF_PI = math.pi / 2.0


def _hadamard(q: int, tag: str) -> list[dict]:
    """H on qubit q, written in the {rz, sx} basis."""
    return [
        {"id": f"{tag}a", "gate": "rz", "targets": [q], "params": [HALF_PI]},
        {"id": f"{tag}b", "gate": "sx", "targets": [q]},
        {"id": f"{tag}c", "gate": "rz", "targets": [q], "params": [HALF_PI]},
    ]


def solve() -> dict:
    """Return the circuit IR (version 1) for the compiled Bell preparation."""
    ops = _hadamard(0, "h0")
    ops += _hadamard(1, "pre")
    ops += [{"id": "cz", "gate": "cz", "targets": [0, 1]}]
    ops += _hadamard(1, "post")
    return {
        "version": 1,
        "name": "bell-in-a-hardware-basis",
        "qubits": 2,
        "clbits": 0,
        "ops": ops,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
