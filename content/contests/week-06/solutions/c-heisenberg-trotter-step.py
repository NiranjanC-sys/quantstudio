"""Week 6, Problem C: One Trotter Step. Reference solution.

The isotropic Heisenberg bond is a root of SWAP. XX + YY + ZZ has eigenvalue +1
on the triplet and -3 on the singlet, so

    exp(-i theta (XX + YY + ZZ) / 2) = exp(-i theta / 2) * SWAP^(2 theta / pi),

and SWAP = CX(i -> j) CX(j -> i) CX(i -> j) is a conjugation of a single CNOT by
another, which means SWAP^alpha = CX(i -> j) CX(j -> i)^alpha CX(i -> j). The
fractional CNOT is one controlled Rx plus a phase on the control, so each bond
costs three two-qubit gates instead of the six a term-by-term Trotterisation
would spend.
"""

from __future__ import annotations

import math

PI = math.pi

#: The Trotter time step.
THETA = PI / 6.0

#: exp(-i theta (XX + YY + ZZ) / 2) is SWAP to this power, up to a global phase.
ALPHA = 2.0 * THETA / PI

BONDS = ((0, 1), (1, 2))


def _bond(i: int, j: int, tag: str) -> list[dict]:
    """One Heisenberg bond as SWAP^ALPHA on qubits i and j."""
    return [
        {"id": f"{tag}a", "gate": "x", "targets": [j], "controls": [i]},
        {"id": f"{tag}b", "gate": "crx", "targets": [j, i], "params": [PI * ALPHA]},
        {"id": f"{tag}c", "gate": "p", "targets": [j], "params": [PI * ALPHA / 2.0]},
        {"id": f"{tag}d", "gate": "x", "targets": [j], "controls": [i]},
    ]


def solve() -> dict:
    """Return the circuit IR (version 1) for one first-order Trotter step."""
    ops: list[dict] = []
    for n, (i, j) in enumerate(BONDS):
        ops += _bond(i, j, f"b{n}")
    return {
        "version": 1,
        "name": "heisenberg-trotter-step",
        "qubits": 3,
        "clbits": 0,
        "ops": ops,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
