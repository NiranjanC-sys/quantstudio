"""Week 2, Problem C: Read The Mask. Reference solution.

Bernstein-Vazirani on three query qubits. The oracle for f(x) = s . x mod 2 is
one CNOT per set bit of s, aimed at an answer qubit held in |->, so each CNOT
kicks back a factor (-1)^x_i onto the query register. One Hadamard layer later
the register holds |s> with amplitude 1, after a single query.
"""

from __future__ import annotations

#: The hidden mask, qubit 0 first.
MASK = (1, 0, 1)

QUERY = (0, 1, 2)
ANSWER = 3


def solve() -> dict:
    """Return the circuit IR (version 1) for the full Bernstein-Vazirani run."""
    ops: list[dict] = [{"id": "flip", "gate": "x", "targets": [ANSWER]}]
    for q in (*QUERY, ANSWER):
        ops.append({"id": f"h{q}", "gate": "h", "targets": [q]})
    for q in QUERY:
        if MASK[q]:
            ops.append({"id": f"q{q}", "gate": "x", "targets": [ANSWER], "controls": [q]})
    for q in QUERY:
        ops.append({"id": f"g{q}", "gate": "h", "targets": [q]})
    return {
        "version": 1,
        "name": "read-the-mask",
        "qubits": 4,
        "clbits": 0,
        "ops": ops,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
