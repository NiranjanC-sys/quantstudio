"""Week 6, Problem D: Exact Grover. Reference solution.

Two ordinary Grover iterations on N = 8 with one marked item overshoot: they land
at 0.945, not 1, because the rotation angle 2*arcsin(1/sqrt(8)) does not divide
pi/2 an integer number of times. Long's phase-matched variant replaces the two
sign flips by two equal phase rotations of angle

    phi = 2 * arcsin(sin(pi / (4J + 2)) / sin(beta)),   sin(beta) = sqrt(M / N),

which shortens each iteration just enough that J of them finish exactly on the
marked state. For J = 2, M = 1, N = 8 that is phi = 2.1268800471555034 radians,
and the success probability is 1 to within floating-point noise.
"""

from __future__ import annotations

import math

PI = math.pi

MARKED = "101"
WIDTH = 3
ITERATIONS = 2

#: sin(beta) = sqrt(M / N) = sqrt(1 / 8).
BETA = math.asin(math.sqrt(1.0 / 8.0))

PHI = 2.0 * math.asin(math.sin(PI / (4.0 * ITERATIONS + 2.0)) / math.sin(BETA))


def _phase_on(label: str, tag: str) -> list[dict]:
    """Multiply the amplitude of one basis state by exp(i * PHI)."""
    zeros = [i for i, b in enumerate(label) if b == "0"]
    pre = [{"id": f"{tag}x{q}", "gate": "x", "targets": [q]} for q in zeros]
    post = [{"id": f"{tag}y{q}", "gate": "x", "targets": [q]} for q in zeros]
    core = {"id": f"{tag}p", "gate": "p", "targets": [2], "controls": [0, 1], "params": [PHI]}
    return [*pre, core, *post]


def solve() -> dict:
    """Return the circuit IR (version 1) for the exact two-iteration search."""
    ops: list[dict] = [{"id": f"h{q}", "gate": "h", "targets": [q]} for q in range(WIDTH)]
    for k in range(ITERATIONS):
        ops += _phase_on(MARKED, f"o{k}")
        ops += [{"id": f"d{k}h{q}", "gate": "h", "targets": [q]} for q in range(WIDTH)]
        ops += _phase_on("0" * WIDTH, f"d{k}")
        ops += [{"id": f"d{k}g{q}", "gate": "h", "targets": [q]} for q in range(WIDTH)]
    return {
        "version": 1,
        "name": "exact-grover",
        "qubits": WIDTH,
        "clbits": 0,
        "ops": ops,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
