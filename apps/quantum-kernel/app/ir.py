"""RedQuant Circuit IR, version 1 -- the JSON contract shared with TypeScript.

One canonical representation is shared by the drag-and-drop builder, the four
code dialects, the browser simulator (``packages/qir``) and this kernel.
Anything expressible in the builder is expressible here, round-trips to any
dialect, and hashes for cache lookup.

Ops are stored as a flat ordered list. Layers (the visual columns of the
builder) are *derived* by ASAP scheduling, never stored, so an edit can never
leave layer metadata inconsistent with semantics.

Qubit ordering follows ``app/gates.py``: qubit 0 is the most significant bit of
a basis index.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Sequence

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.gates import GATES, SELF_INVERSE, GateDef, gate

IR_VERSION = 1

TWO_PI = 2.0 * math.pi

#: Angles are snapped to this many decimal places before hashing, so that two
#: circuits differing only by floating-point noise share a cache entry.
ANGLE_PRECISION = 1e12


class IRError(ValueError):
    """A structural problem with a circuit, carrying the offending op id."""

    def __init__(self, message: str, op_id: str | None = None) -> None:
        super().__init__(message)
        self.op_id = op_id


class Symbol(BaseModel):
    """A named, unbound gate parameter, e.g. the ``theta`` of a VQE ansatz."""

    model_config = ConfigDict(extra="forbid")
    symbol: str = Field(min_length=1, max_length=64)


Param = float | Symbol


class ClassicalCondition(BaseModel):
    """Execute the op only when the named classical bits hold ``value``.

    ``bits`` is least-significant-first: ``bits=[2, 5], value=2`` means
    ``clbit[2] == 0 and clbit[5] == 1``.
    """

    model_config = ConfigDict(extra="forbid")
    bits: list[int] = Field(min_length=1)
    value: int = Field(ge=0)


class Op(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: Stable id used by the editor for selection and undo. Auto-filled when blank.
    id: str = ""
    #: Registry key, e.g. 'h', 'cx', 'rz', 'measure'.
    gate: str
    #: Target qubit indices, in operand order.
    targets: list[int] = Field(default_factory=list)
    #: Positive control qubits. Empty for uncontrolled gates.
    controls: list[int] = Field(default_factory=list)
    #: Parameters in the order declared by the gate definition.
    params: list[Param] = Field(default_factory=list)
    #: Classical bit targets, for measure.
    cbits: list[int] = Field(default_factory=list)
    condition: ClassicalCondition | None = None
    label: str | None = None

    @property
    def qubits(self) -> list[int]:
        """Every qubit the op touches, controls included."""
        return [*self.controls, *self.targets] if self.controls else list(self.targets)


class Circuit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = IR_VERSION
    name: str = "circuit"
    qubits: int = Field(ge=1, le=64)
    clbits: int = Field(default=0, ge=0, le=64)
    ops: list[Op] = Field(default_factory=list)
    #: Free-form; never affects semantics or the canonical hash.
    metadata: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _fill_ids(self) -> "Circuit":
        """Give every op a stable id so the editor and the grader can refer to it.

        Hand-written IR (labs, fixtures, LLM output) routinely omits ids; making
        them optional at the edge and total inside is cheaper than making every
        consumer defensive.
        """
        seen: set[str] = set()
        for i, op in enumerate(self.ops):
            if not op.id or op.id in seen:
                op.id = f"op{i}"
            seen.add(op.id)
        return self


def empty_circuit(qubits: int = 2, clbits: int | None = None, name: str = "circuit") -> Circuit:
    return Circuit(qubits=qubits, clbits=qubits if clbits is None else clbits, name=name)


def is_symbolic(p: Param) -> bool:
    return isinstance(p, Symbol)


def resolve_params(
    params: Sequence[Param] | None, bindings: dict[str, float] | None = None
) -> list[float]:
    """Substitute symbol bindings, failing loudly on an unbound symbol."""
    if not params:
        return []
    b = bindings or {}
    out: list[float] = []
    for p in params:
        if isinstance(p, Symbol):
            if p.symbol not in b:
                raise IRError(f"unbound parameter {p.symbol!r}")
            out.append(float(b[p.symbol]))
        else:
            out.append(float(p))
    return out


def has_symbols(circuit: Circuit) -> bool:
    return any(isinstance(p, Symbol) for op in circuit.ops for p in op.params)


def free_symbols(circuit: Circuit) -> list[str]:
    names: list[str] = []
    for op in circuit.ops:
        for p in op.params:
            if isinstance(p, Symbol) and p.symbol not in names:
                names.append(p.symbol)
    return names


# --------------------------------------------------------------------------
# Layering and metrics (port of packages/qir/src/analysis.ts)
# --------------------------------------------------------------------------


def layerize(circuit: Circuit) -> list[int]:
    """ASAP layering: the layer index of each op. Barriers fence full width."""
    frontier = [0] * circuit.qubits
    cl_frontier = [0] * max(circuit.clbits, 1)
    layers: list[int] = []
    for op in circuit.ops:
        if op.gate == "barrier":
            top = max(frontier) if frontier else 0
            frontier = [top] * circuit.qubits
            layers.append(top)
            continue
        layer = 0
        for q in op.qubits:
            if 0 <= q < len(frontier):
                layer = max(layer, frontier[q])
        for c in op.cbits:
            if 0 <= c < len(cl_frontier):
                layer = max(layer, cl_frontier[c])
        if op.condition:
            for c in op.condition.bits:
                if 0 <= c < len(cl_frontier):
                    layer = max(layer, cl_frontier[c])
        layers.append(layer)
        for q in op.qubits:
            if 0 <= q < len(frontier):
                frontier[q] = layer + 1
        for c in op.cbits:
            if 0 <= c < len(cl_frontier):
                cl_frontier[c] = layer + 1
    return layers


def moments(circuit: Circuit) -> list[list[Op]]:
    """Ops grouped into the visual columns the builder draws."""
    layers = layerize(circuit)
    if not layers:
        return []
    out: list[list[Op]] = [[] for _ in range(max(layers) + 1)]
    for op, layer in zip(circuit.ops, layers):
        out[layer].append(op)
    return out


@dataclass(frozen=True)
class CircuitMetrics:
    qubits: int
    clbits: int
    #: Total ops, barriers excluded.
    size: int
    #: Longest path through the dependency graph, barriers excluded.
    depth: int
    #: Ops acting on exactly two qubits (controls included).
    two_qubit_gates: int
    multi_qubit_gates: int
    single_qubit_gates: int
    measurements: int
    #: T and T-dagger count: the dominant cost under error correction.
    t_count: int
    #: True when every op is Clifford, so the circuit is classically simulable.
    clifford: bool
    gate_counts: dict[str, int]
    active_qubits: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "qubits": self.qubits,
            "clbits": self.clbits,
            "size": self.size,
            "depth": self.depth,
            "twoQubitGates": self.two_qubit_gates,
            "multiQubitGates": self.multi_qubit_gates,
            "singleQubitGates": self.single_qubit_gates,
            "measurements": self.measurements,
            "tCount": self.t_count,
            "clifford": self.clifford,
            "gateCounts": dict(sorted(self.gate_counts.items())),
            "activeQubits": self.active_qubits,
        }


def metrics(circuit: Circuit) -> CircuitMetrics:
    counts: dict[str, int] = {}
    size = one = two = multi = meas = t_count = 0
    clifford = True
    touched: set[int] = set()

    for op in circuit.ops:
        counts[op.gate] = counts.get(op.gate, 0) + 1
        if op.gate == "barrier":
            continue
        size += 1
        qs = op.qubits
        touched.update(qs)
        if op.gate == "measure":
            meas += 1
        elif len(qs) == 1:
            one += 1
        elif len(qs) == 2:
            two += 1
        else:
            multi += 1
        if op.gate in ("t", "tdg"):
            t_count += 1
        d = GATES.get(op.gate)
        if d is None or not d.clifford:
            clifford = False

    layers = layerize(circuit)
    depth = 0
    for op, layer in zip(circuit.ops, layers):
        if op.gate != "barrier":
            depth = max(depth, layer + 1)

    return CircuitMetrics(
        qubits=circuit.qubits,
        clbits=circuit.clbits,
        size=size,
        depth=depth,
        two_qubit_gates=two,
        multi_qubit_gates=multi,
        single_qubit_gates=one,
        measurements=meas,
        t_count=t_count,
        clifford=clifford,
        gate_counts=counts,
        active_qubits=len(touched),
    )


@dataclass(frozen=True)
class ValidationIssue:
    severity: Literal["error", "warning"]
    message: str
    op_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"severity": self.severity, "message": self.message, "opId": self.op_id}


def validate(circuit: Circuit) -> list[ValidationIssue]:
    """Structural validation. Runs on every edit so the builder cannot save junk."""
    issues: list[ValidationIssue] = []
    if circuit.qubits < 1:
        issues.append(ValidationIssue("error", "circuit needs at least one qubit"))

    for op in circuit.ops:
        d = GATES.get(op.gate)
        if d is None:
            issues.append(ValidationIssue("error", f"unknown gate {op.gate!r}", op.id))
            continue
        qs = op.qubits
        for q in qs:
            if q < 0 or q >= circuit.qubits:
                issues.append(
                    ValidationIssue(
                        "error", f"{op.gate} references qubit {q}, out of range", op.id
                    )
                )
        if len(set(qs)) != len(qs):
            issues.append(
                ValidationIssue("error", f"{op.gate} uses the same qubit twice", op.id)
            )
        variadic = d.controlled_form is not None and d.controlled_form.controls < 0
        expected_targets = len(op.targets) if variadic else d.arity
        if len(op.targets) != expected_targets:
            issues.append(
                ValidationIssue(
                    "error",
                    f"{op.gate} expects {expected_targets} target(s), got {len(op.targets)}",
                    op.id,
                )
            )
        if variadic and not op.controls:
            issues.append(
                ValidationIssue("error", f"{op.gate} needs at least one control", op.id)
            )
        np_ = len(d.param_names)
        if len(op.params) != np_:
            issues.append(
                ValidationIssue(
                    "error",
                    f"{op.gate} expects {np_} parameter(s) "
                    f"({', '.join(d.param_names) or 'none'}), got {len(op.params)}",
                    op.id,
                )
            )
        if op.gate == "measure":
            if not op.cbits:
                issues.append(ValidationIssue("error", "measure needs a classical bit", op.id))
            elif op.cbits[0] >= circuit.clbits:
                issues.append(
                    ValidationIssue(
                        "error", f"classical bit {op.cbits[0]} out of range", op.id
                    )
                )
        if op.condition:
            for c in op.condition.bits:
                if c < 0 or c >= circuit.clbits:
                    issues.append(
                        ValidationIssue(
                            "error", f"condition references classical bit {c}, out of range", op.id
                        )
                    )
            if op.condition.value >= (1 << len(op.condition.bits)):
                issues.append(
                    ValidationIssue(
                        "error",
                        f"condition value {op.condition.value} does not fit in "
                        f"{len(op.condition.bits)} bit(s)",
                        op.id,
                    )
                )

    m = metrics(circuit)
    if m.active_qubits < circuit.qubits:
        issues.append(
            ValidationIssue(
                "warning", f"{circuit.qubits - m.active_qubits} qubit(s) are never used"
            )
        )
    return issues


def validate_or_raise(circuit: Circuit) -> None:
    """Raise on the first error-severity issue. The API boundary uses this."""
    for issue in validate(circuit):
        if issue.severity == "error":
            raise IRError(issue.message, issue.op_id)


def inverse(circuit: Circuit) -> Circuit:
    """The circuit that undoes this one. Fails loudly on non-unitary ops."""
    ops: list[Op] = []
    for op in reversed(circuit.ops):
        if op.gate == "barrier":
            ops.append(op.model_copy(update={"id": f"{op.id}-inv"}))
            continue
        d = gate(op.gate)
        if d.inverse is None:
            raise IRError(f"gate {op.gate!r} has no defined inverse", op.id)
        params: list[Param] = list(op.params)
        if d.inverse.params is not None:
            numeric = [p if isinstance(p, float | int) else 0.0 for p in op.params]
            params = [float(v) for v in d.inverse.params([float(x) for x in numeric])]
        ops.append(op.model_copy(update={"id": f"{op.id}-inv", "gate": d.inverse.gate,
                                         "params": params}))
    return circuit.model_copy(update={"name": f"{circuit.name}-inverse", "ops": ops})


# --------------------------------------------------------------------------
# Canonical form and content hashing (port of packages/qir/src/canonical.ts)
# --------------------------------------------------------------------------


def round_angle(x: float) -> float:
    """Fold an angle into (-pi, pi] and snap it to 1e-12.

    ``Math.round`` in JavaScript rounds halves toward +infinity, unlike Python's
    banker's rounding, so ``floor(v + 0.5)`` is used to keep the two engines
    byte-identical on the canonical string.
    """
    a = math.fmod(float(x), TWO_PI)
    if a <= -math.pi:
        a += TWO_PI
    if a > math.pi:
        a -= TWO_PI
    r = math.floor(a * ANGLE_PRECISION + 0.5) / ANGLE_PRECISION
    return 0.0 if r == 0.0 else r


def js_number_to_string(x: float) -> str:
    """Format a float exactly as JavaScript's ``String(Number)`` would.

    Python's ``repr`` and JS's ``Number::toString`` both emit the shortest
    round-tripping digit string, but they disagree on when to switch to
    exponential notation and on whether integers keep a ``.0``. Reproducing
    ECMA-262 7.1.12.1 here is what lets the canonical string -- and therefore
    the hash -- match the TypeScript engine.
    """
    if x != x:
        return "NaN"
    if x == 0.0:
        return "0"
    if x == math.inf:
        return "Infinity"
    if x == -math.inf:
        return "-Infinity"
    neg = x < 0
    r = repr(abs(float(x)))
    mant, _, exp_s = r.partition("e")
    exp10 = int(exp_s) if exp_s else 0
    int_part, _, frac_part = mant.partition(".")
    combined = int_part + frac_part
    stripped = combined.lstrip("0")
    lead_zeros = len(combined) - len(stripped)
    # value == digits * 10**(n - k), i.e. n is the position of the decimal point
    n = len(int_part) + exp10 - lead_zeros
    digits = stripped.rstrip("0") or "0"
    k = len(digits)

    if k <= n <= 21:
        s = digits + "0" * (n - k)
    elif 0 < n <= 21:
        s = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        head = digits[0] if k == 1 else digits[0] + "." + digits[1:]
        s = f"{head}e{'+' if e >= 0 else '-'}{abs(e)}"
    return "-" + s if neg else s


def normalise_op(op: Op) -> Op:
    """Rewrite a controlled alias into its base gate plus explicit controls."""
    d = GATES.get(op.gate)
    if d is None or d.controlled_form is None:
        return op
    nc = d.controlled_form.controls
    if nc < 0:
        return op.model_copy(update={"gate": d.controlled_form.base})
    controls = sorted([*op.controls, *op.targets[:nc]])
    return op.model_copy(
        update={
            "gate": d.controlled_form.base,
            "controls": controls,
            "targets": op.targets[nc:],
        }
    )


def op_key(op: Op) -> str:
    """A stable, semantics-only string for one op. Ignores id, label, order."""
    params = ",".join(
        f"@{p.symbol}" if isinstance(p, Symbol) else js_number_to_string(round_angle(float(p)))
        for p in op.params
    )
    controls = ".".join(str(c) for c in sorted(op.controls))
    targets = ".".join(str(t) for t in op.targets)
    cbits = ".".join(str(c) for c in op.cbits)
    cond = (
        f"?{'.'.join(str(b) for b in op.condition.bits)}={op.condition.value}"
        if op.condition
        else ""
    )
    return f"{op.gate}|{controls}|{targets}|{params}|{cbits}{cond}"


def canonicalise(circuit: Circuit) -> Circuit:
    """Barriers dropped, aliases normalised, commuting ops sorted within a layer.

    Two circuits that differ only by the order in which independent gates were
    dragged onto the canvas must hash the same, because thousands of learners
    run the *same* lesson circuit and we want them all to hit one cache entry.
    """
    kept = [normalise_op(o) for o in circuit.ops if o.gate != "barrier"]
    staged = circuit.model_copy(update={"ops": kept})
    layers = layerize(staged)
    buckets: dict[int, list[Op]] = {}
    for op, layer in zip(kept, layers):
        buckets.setdefault(layer, []).append(op)
    ops: list[Op] = []
    for layer in sorted(buckets):
        ops.extend(sorted(buckets[layer], key=op_key))
    return Circuit(
        version=circuit.version,
        name=circuit.name,
        qubits=circuit.qubits,
        clbits=circuit.clbits,
        ops=ops,
    )


def canonical_string(circuit: Circuit) -> str:
    """The stable string used as the cache key. Excludes name and metadata."""
    c = canonicalise(circuit)
    return f"q{c.qubits}c{c.clbits};" + ";".join(op_key(o) for o in c.ops)


_FNV_PRIME = 0x01000193
_FNV_OFFSET = 0x811C9DC5
_MIX = 0x85EBCA6B
_M32 = 0xFFFFFFFF


def circuit_hash(circuit: Circuit) -> str:
    """A 64-bit content hash of the canonical string, rendered as 16 hex chars.

    Algorithm, matching ``packages/qir/src/canonical.ts``:

    * ``h1`` is textbook FNV-1a 32-bit over the UTF-16 code units of the
      canonical string: ``h1 = (h1 XOR c) * 16777619 mod 2^32``.
    * ``h2`` is a position-sensitive avalanche companion:
      ``h2 = (h2 + (c + i) * 0x85ebca6b) mod 2^32``, then ``h2 ^= h2 >> 13``.
      FNV-1a alone is order-sensitive but weak on short, highly structured
      strings like ours (they differ in a handful of digit positions), so the
      second lane mixes in the index and spreads the low bits.
    * The result is ``hex(h1) || hex(h2)``, both zero-padded to 8 characters.

    No crypto dependency, because this is a cache key and not a security
    boundary; Redis keys are namespaced per tenant, so a collision costs a
    wrong-cache-hit within one tenant at worst and the TTL is 24 h.

    Cross-language equality with the TypeScript engine holds for every circuit
    whose canonical string is ASCII, which is every circuit the builder can
    produce. It is not *guaranteed* across languages -- ``localeCompare``'s
    collation of the intra-layer sort is ICU-defined -- but it is guaranteed to
    be stable within Python, which is what the cache actually requires.
    """
    s = canonical_string(circuit)
    h1 = _FNV_OFFSET
    h2 = _FNV_PRIME
    for i, ch in enumerate(s):
        c = ord(ch)
        h1 = ((h1 ^ c) * _FNV_PRIME) & _M32
        h2 = (h2 + ((c + i) * _MIX)) & _M32
        h2 ^= h2 >> 13
    return f"{h1:08x}{h2:08x}"


def equivalent_by_structure(a: Circuit, b: Circuit) -> bool:
    """True when two circuits are the same up to commuting reorder and aliasing."""
    return canonical_string(a) == canonical_string(b)


def gate_set(circuit: Circuit) -> set[str]:
    """The distinct gate keys used, as written (aliases not normalised)."""
    return {op.gate for op in circuit.ops}


__all__ = [
    "ANGLE_PRECISION",
    "Circuit",
    "CircuitMetrics",
    "ClassicalCondition",
    "IRError",
    "IR_VERSION",
    "Op",
    "Param",
    "Symbol",
    "ValidationIssue",
    "canonical_string",
    "canonicalise",
    "circuit_hash",
    "empty_circuit",
    "equivalent_by_structure",
    "free_symbols",
    "gate_set",
    "has_symbols",
    "inverse",
    "js_number_to_string",
    "layerize",
    "metrics",
    "moments",
    "normalise_op",
    "op_key",
    "resolve_params",
    "round_angle",
    "validate",
    "validate_or_raise",
]
