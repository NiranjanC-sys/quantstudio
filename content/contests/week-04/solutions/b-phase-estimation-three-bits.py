"""Week 4, Problem B: Three Bits Of Phase. Reference solution.

The eigenphase is 3/8 = 0.011 in binary, so three counting qubits read it
exactly. The trick that keeps the circuit inside the seven two-qubit gate budget
is doubling the angle instead of repeating the query: counting qubit k applies
one controlled phase of 2*pi*phi*2^(n-1-k) rather than 2^(n-1-k) copies of the
unit query, which turns 7 queries into 3.
"""

from __future__ import annotations

import math

PI = math.pi

#: The eigenphase to be read out, exact in three binary digits.
PHI = 3.0 / 8.0

COUNTING = (0, 1, 2)
EIGEN = 3


def _inverse_qft(qs: tuple[int, ...]) -> list[dict]:
    """QFT-dagger on three qubits, qs[0] most significant."""
    a, b, c = qs
    return [
        {"id": "iq0", "gate": "swap", "targets": [a, c]},
        {"id": "iq1", "gate": "h", "targets": [c]},
        {"id": "iq2", "gate": "cp", "targets": [b, c], "params": [-PI / 2.0]},
        {"id": "iq3", "gate": "h", "targets": [b]},
        {"id": "iq4", "gate": "cp", "targets": [a, c], "params": [-PI / 4.0]},
        {"id": "iq5", "gate": "cp", "targets": [a, b], "params": [-PI / 2.0]},
        {"id": "iq6", "gate": "h", "targets": [a]},
    ]


def solve() -> dict:
    """Return the circuit IR (version 1) for exact three-bit phase estimation."""
    ops: list[dict] = [{"id": "eig", "gate": "x", "targets": [EIGEN]}]
    ops += [{"id": f"h{q}", "gate": "h", "targets": [q]} for q in COUNTING]
    for k, q in enumerate(COUNTING):
        power = 1 << (len(COUNTING) - 1 - k)
        ops.append(
            {
                "id": f"cu{q}",
                "gate": "cp",
                "targets": [q, EIGEN],
                "params": [2.0 * PI * PHI * power],
            }
        )
    ops += _inverse_qft(COUNTING)
    return {
        "version": 1,
        "name": "phase-estimation-three-bits",
        "qubits": 4,
        "clbits": 0,
        "ops": ops,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
