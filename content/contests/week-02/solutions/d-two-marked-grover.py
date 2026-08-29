"""Week 2, Problem D: Two Marked Items. Reference solution.

With N = 8 and M = 2 the Grover angle is theta = 2*arcsin(sqrt(2/8)) = pi/3, so
one iteration rotates the state through exactly pi/2 and lands on the marked
subspace with probability 1. The oracle marks 010 and 101 as two X-conjugated
CCZ gates; the diffusion operator is the usual H, X, CCZ, X, H sandwich.
"""

from __future__ import annotations

MARKED = ("010", "101")


def _mark(label: str, tag: str) -> list[dict]:
    """Phase-flip one basis state with an X-conjugated CCZ."""
    zeros = [i for i, b in enumerate(label) if b == "0"]
    pre = [{"id": f"{tag}x{q}", "gate": "x", "targets": [q]} for q in zeros]
    post = [{"id": f"{tag}y{q}", "gate": "x", "targets": [q]} for q in zeros]
    return [*pre, {"id": f"{tag}ccz", "gate": "ccz", "targets": [0, 1, 2]}, *post]


def solve() -> dict:
    """Return the circuit IR (version 1) for one exact Grover iteration."""
    ops: list[dict] = [{"id": f"h{q}", "gate": "h", "targets": [q]} for q in range(3)]
    ops += _mark(MARKED[0], "a")
    ops += _mark(MARKED[1], "b")
    ops += [{"id": f"dh{q}", "gate": "h", "targets": [q]} for q in range(3)]
    ops += [{"id": f"dx{q}", "gate": "x", "targets": [q]} for q in range(3)]
    ops += [{"id": "dccz", "gate": "ccz", "targets": [0, 1, 2]}]
    ops += [{"id": f"dy{q}", "gate": "x", "targets": [q]} for q in range(3)]
    ops += [{"id": f"dg{q}", "gate": "h", "targets": [q]} for q in range(3)]
    return {
        "version": 1,
        "name": "two-marked-grover",
        "qubits": 3,
        "clbits": 0,
        "ops": ops,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
