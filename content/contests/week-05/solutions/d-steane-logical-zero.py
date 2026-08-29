"""Week 5, Problem D: Steane Logical Zero. Reference solution.

|0_L> is the uniform superposition over the eight even-weight codewords of the
[7,4,3] Hamming code, which is a classical linear code: put the three free bits
in superposition with Hadamards, then compute each parity bit with CNOTs from the
free bits that feed it. Nine CNOTs, one per 1 in the generator matrix off the
free columns.

Generators, qubit 0 first:

    g1 = 1010101
    g2 = 0110011
    g3 = 0001111
"""

from __future__ import annotations

FREE = (0, 1, 3)

#: Which parity qubits each free qubit feeds.
FANOUT = {0: (2, 4, 6), 1: (2, 5, 6), 3: (4, 5, 6)}


def solve() -> dict:
    """Return the circuit IR (version 1) preparing the Steane logical zero."""
    ops: list[dict] = [{"id": f"h{q}", "gate": "h", "targets": [q]} for q in FREE]
    for control in FREE:
        for target in FANOUT[control]:
            ops.append(
                {"id": f"c{control}t{target}", "gate": "x", "targets": [target], "controls": [control]}
            )
    return {
        "version": 1,
        "name": "steane-logical-zero",
        "qubits": 7,
        "clbits": 0,
        "ops": ops,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
