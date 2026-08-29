"""Week 4, Problem D: Hidden Shift. Reference solution.

IP2(x) = x0 x1 XOR x2 x3 is bent and self-dual, so its Fourier transform is
itself. Three Hadamard layers with the shifted oracle in the first gap and the
unshifted oracle in the second leaves the register holding |s> exactly:

    H f(x + s) H IP2 H |0000> = |s>.

Both oracles are two CZ gates; the shift is an X conjugation by s.
"""

from __future__ import annotations

#: The hidden shift, qubit 0 first.
SHIFT = (1, 0, 1, 1)

WIDTH = 4


def _ip2(tag: str) -> list[dict]:
    """The inner-product-two phase oracle: (-1)^(x0 x1 XOR x2 x3)."""
    return [
        {"id": f"{tag}a", "gate": "cz", "targets": [0, 1]},
        {"id": f"{tag}b", "gate": "cz", "targets": [2, 3]},
    ]


def _shift(tag: str) -> list[dict]:
    return [
        {"id": f"{tag}{q}", "gate": "x", "targets": [q]}
        for q in range(WIDTH)
        if SHIFT[q]
    ]


def solve() -> dict:
    """Return the circuit IR (version 1) recovering the hidden shift."""
    ops: list[dict] = [{"id": f"h{q}", "gate": "h", "targets": [q]} for q in range(WIDTH)]
    ops += _shift("s1")
    ops += _ip2("f")
    ops += _shift("s2")
    ops += [{"id": f"m{q}", "gate": "h", "targets": [q]} for q in range(WIDTH)]
    ops += _ip2("g")
    ops += [{"id": f"e{q}", "gate": "h", "targets": [q]} for q in range(WIDTH)]
    return {
        "version": 1,
        "name": "hidden-shift",
        "qubits": WIDTH,
        "clbits": 0,
        "ops": ops,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(solve(), indent=2))
