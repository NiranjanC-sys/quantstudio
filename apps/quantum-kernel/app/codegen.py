"""Translation between the IR and the dialects learners actually write.

Four targets, plus OpenQASM 3 as the neutral text format.

**Endianness, once.** A qubit *index* means the same thing everywhere: ``q[2]``
is the third wire. What differs between SDKs is how a wire maps onto a bit of
the *basis index*. We put qubit 0 in the most significant bit; Qiskit puts it in
the least. So the Qiskit translation reverses wire indices (``our q`` ->
``n-1-q``) and nothing else: with that single change the amplitude arrays line
up entry-for-entry, no post-hoc reversal of the vector is needed, and counts
strings (classical bit 0 rightmost in both) need no change at all.
``tests/test_cross_backend.py::test_qiskit_wire_reversal_aligns_basis_indices``
proves it, and ``tests/test_gates.py::test_sdk_gate_conventions_match`` proves
every individual gate lines up under that mapping.

Cirq and PennyLane already put operand 0 in the most significant position, so
their translations use qubit indices unchanged.

Source generation is one-way. Going from Python source back to IR means running
the code, which is what ``POST /v1/execute`` and ``app/sandbox.py`` are for.
OpenQASM 3 round-trips in both directions because it is data, not a program.
"""

from __future__ import annotations

import ast
import math
import operator
import re
from typing import Any, Callable, Iterable, Sequence

from app.gates import GATES, base_form, gate
from app.ir import Circuit, IRError, Op, Symbol, resolve_params

# --------------------------------------------------------------------------
# OpenQASM 3
# --------------------------------------------------------------------------

#: Gates in ``stdgates.inc``. Anything else needs a definition in the preamble.
_STDGATES = frozenset(
    {
        "p", "x", "y", "z", "h", "s", "sdg", "t", "tdg", "sx", "rx", "ry", "rz",
        "cx", "cy", "cz", "cp", "crx", "cry", "crz", "ch", "swap", "ccx", "cswap",
        "cu", "id", "U", "u3",
    }
)

#: Exact definitions (not up to global phase) for the gates stdgates lacks.
#: Each is verified against the registry matrix in
#: ``tests/test_codegen.py::test_qasm_custom_definitions_are_exact``.
_QASM_DEFS: dict[str, str] = {
    "sxdg": "gate sxdg a { inv @ sx a; }",
    "cs": "gate cs a, b { ctrl @ s a, b; }",
    "csdg": "gate csdg a, b { inv @ ctrl @ s a, b; }",
    "csx": "gate csx a, b { ctrl @ sx a, b; }",
    "ccz": "gate ccz a, b, c { ctrl @ ctrl @ z a, b, c; }",
    "rzz": "gate rzz(theta) a, b { cx a, b; rz(theta) b; cx a, b; }",
    "rxx": "gate rxx(theta) a, b { h a; h b; rzz(theta) a, b; h a; h b; }",
    "ryy": (
        "gate ryy(theta) a, b { rx(-pi/2) a; rx(-pi/2) b; rzz(theta) a, b; "
        "rx(pi/2) a; rx(pi/2) b; }"
    ),
    "rzx": "gate rzx(theta) a, b { h b; rzz(theta) a, b; h b; }",
    "iswap": "gate iswap a, b { s a; s b; h a; cx a, b; cx b, a; h b; }",
    "ecr": "gate ecr a, b { rzx(pi/4) a, b; x a; rzx(-pi/4) a, b; }",
}

#: Definitions some entries above depend on, so the preamble stays orderable.
_QASM_DEF_DEPS: dict[str, tuple[str, ...]] = {
    "rxx": ("rzz",),
    "ryy": ("rzz",),
    "rzx": ("rzz",),
    "ecr": ("rzz", "rzx"),
}


def _fmt_angle(v: float) -> str:
    """Render an angle, preferring exact multiples of pi for readability."""
    if v == 0:
        return "0"
    for num in range(-8, 9):
        for den in (1, 2, 3, 4, 6, 8):
            if num == 0:
                continue
            if abs(v - num * math.pi / den) < 1e-12:
                sign = "-" if num < 0 else ""
                mag = abs(num)
                head = "pi" if mag == 1 else f"{mag}*pi"
                return f"{sign}{head}" if den == 1 else f"{sign}{head}/{den}"
    return repr(float(v))


def _params_text(op: Op, bindings: dict[str, float] | None) -> str:
    if not op.params:
        return ""
    parts: list[str] = []
    for p in op.params:
        if isinstance(p, Symbol):
            if bindings and p.symbol in bindings:
                parts.append(_fmt_angle(float(bindings[p.symbol])))
            else:
                parts.append(p.symbol)
        else:
            parts.append(_fmt_angle(float(p)))
    return "(" + ", ".join(parts) + ")"


def to_qasm3(circuit: Circuit, bindings: dict[str, float] | None = None) -> str:
    """Emit OpenQASM 3. ``q[i]`` is our qubit ``i``; ``c[j]`` our classical bit ``j``."""
    used = {op.gate for op in circuit.ops}
    needed: list[str] = []

    def add_def(name: str) -> None:
        if name in needed or name not in _QASM_DEFS:
            return
        for dep in _QASM_DEF_DEPS.get(name, ()):
            add_def(dep)
        needed.append(name)

    for g in sorted(used):
        add_def(g)

    lines = ['OPENQASM 3.0;', 'include "stdgates.inc";', ""]
    lines.extend(_QASM_DEFS[n] for n in needed)
    if needed:
        lines.append("")
    symbols = sorted({p.symbol for op in circuit.ops for p in op.params if isinstance(p, Symbol)})
    for s in symbols:
        if not bindings or s not in bindings:
            lines.append(f"input float[64] {s};")
    if symbols:
        lines.append("")
    lines.append(f"qubit[{circuit.qubits}] q;")
    if circuit.clbits:
        lines.append(f"bit[{circuit.clbits}] c;")
    lines.append("")

    for op in circuit.ops:
        stmt = _qasm_statement(op, bindings)
        if stmt is None:
            continue
        if op.condition is not None:
            bits = op.condition.bits
            if len(bits) == 1:
                cond = f"c[{bits[0]}] == {op.condition.value}"
            else:
                terms = [
                    f"c[{b}] == {(op.condition.value >> i) & 1}" for i, b in enumerate(bits)
                ]
                cond = " && ".join(terms)
            lines.append(f"if ({cond}) {{ {stmt} }}")
        else:
            lines.append(stmt)
    return "\n".join(lines) + "\n"


def _qasm_statement(op: Op, bindings: dict[str, float] | None) -> str | None:
    qs = [f"q[{i}]" for i in op.qubits]
    if op.gate == "measure":
        return f"c[{op.cbits[0]}] = measure q[{op.targets[0]}];"
    if op.gate == "reset":
        return f"reset q[{op.targets[0]}];"
    if op.gate == "barrier":
        return "barrier " + ", ".join(f"q[{t}]" for t in op.targets) + ";"
    name = op.gate
    if name == "cu":
        # stdgates.inc `cu` takes four angles (theta, phi, lambda, gamma); ours
        # takes three, so emit the modifier form, which is exactly our gate.
        return f"ctrl @ U{_params_text(op, bindings)} " + ", ".join(qs) + ";"
    if name == "mcx":
        k = len(op.controls)
        return f"ctrl({k}) @ x " + ", ".join(qs) + ";"
    emitted = GATES[name].qasm_name or name
    if op.controls and GATES[name].controlled_form is None:
        prefix = "ctrl @ " * len(op.controls)
        return f"{prefix}{emitted}{_params_text(op, bindings)} " + ", ".join(qs) + ";"
    return f"{emitted}{_params_text(op, bindings)} " + ", ".join(qs) + ";"


_ALLOWED_CONSTS = {"pi": math.pi, "tau": math.tau, "euler": math.e, "e": math.e}
_BINOPS: dict[type, Callable[[float, float], float]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
}
_FUNCS: dict[str, Callable[..., float]] = {
    "sin": math.sin, "cos": math.cos, "tan": math.tan, "sqrt": math.sqrt,
    "exp": math.exp, "log": math.log, "arcsin": math.asin, "arccos": math.acos,
    "arctan": math.atan,
}


def eval_angle(expr: str) -> float:
    """Evaluate a QASM angle expression without ``eval``.

    Only literals, ``pi``/``tau``/``euler``, unary minus, the five arithmetic
    operators and a fixed set of maths functions are permitted. QASM files
    arrive from learners, so an expression parser that can call arbitrary code
    is a remote-code-execution hole no matter how it is sandboxed.
    """
    tree = ast.parse(expr.strip(), mode="eval")

    def walk(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return walk(node.body)
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (int, float)):
                return float(node.value)
            raise IRError(f"non-numeric constant in angle {expr!r}")
        if isinstance(node, ast.Name):
            if node.id in _ALLOWED_CONSTS:
                return _ALLOWED_CONSTS[node.id]
            raise IRError(f"unknown symbol {node.id!r} in angle {expr!r}")
        if isinstance(node, ast.UnaryOp):
            v = walk(node.operand)
            if isinstance(node.op, ast.USub):
                return -v
            if isinstance(node.op, ast.UAdd):
                return v
            raise IRError(f"unsupported unary operator in angle {expr!r}")
        if isinstance(node, ast.BinOp):
            fn = _BINOPS.get(type(node.op))
            if fn is None:
                raise IRError(f"unsupported operator in angle {expr!r}")
            return fn(walk(node.left), walk(node.right))
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS:
                raise IRError(f"unsupported call in angle {expr!r}")
            return _FUNCS[node.func.id](*[walk(a) for a in node.args])
        raise IRError(f"cannot evaluate angle {expr!r}")

    return float(walk(tree))


_COMMENT = re.compile(r"//[^\n]*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_GATE_DEF = re.compile(r"\bgate\s+\w+[^{]*\{[^}]*\}", re.S)
_IF_BLOCK = re.compile(r"\bif\s*\(([^)]*)\)\s*\{([^}]*)\}", re.S)
_DECL_Q = re.compile(r"^(?:qubit\s*\[\s*(\d+)\s*\]\s*(\w+)|qreg\s+(\w+)\s*\[\s*(\d+)\s*\])$")
_DECL_C = re.compile(r"^(?:bit\s*\[\s*(\d+)\s*\]\s*(\w+)|creg\s+(\w+)\s*\[\s*(\d+)\s*\])$")
_MEASURE_ASSIGN = re.compile(r"^(\w+)\s*\[\s*(\d+)\s*\]\s*=\s*measure\s+(\w+)\s*\[\s*(\d+)\s*\]$")
_MEASURE_ARROW = re.compile(r"^measure\s+(\w+)\s*\[\s*(\d+)\s*\]\s*->\s*(\w+)\s*\[\s*(\d+)\s*\]$")
_CALL = re.compile(r"^((?:(?:ctrl|inv|pow)\s*(?:\([^)]*\))?\s*@\s*)*)(\w+)\s*(\([^)]*\))?\s*(.*)$")
_QREF = re.compile(r"(\w+)\s*\[\s*(\d+)\s*\]")
_COND_TERM = re.compile(r"^(\w+)(?:\s*\[\s*(\d+)\s*\])?\s*==\s*(\d+)$")


def from_qasm3(text: str) -> Circuit:
    """Parse the OpenQASM 3 subset the builder and the labs actually produce.

    Deliberately not a full OpenQASM 3 implementation -- no classical control
    flow beyond ``if``, no subroutines, no arrays. It accepts everything
    :func:`to_qasm3` emits (round-trip tested), plus the OpenQASM 2 spellings
    (``qreg``/``creg``/``measure ->``) that a decade of tutorials taught people.
    """
    src = _BLOCK_COMMENT.sub(" ", text)
    src = _COMMENT.sub("", src)
    src = _GATE_DEF.sub("", src)  # our own preamble; the registry already knows these

    conditioned: list[tuple[str, list[int], int]] = []

    def take_if(m: re.Match[str]) -> str:
        cond = m.group(1)
        body = m.group(2)
        bits, value = _parse_condition(cond)
        for stmt in [s.strip() for s in body.split(";") if s.strip()]:
            conditioned.append((stmt, bits, value))
        return f" __IF{len(conditioned) - 1}__;"

    # Each if-block collapses to a marker so the statement splitter stays simple.
    markers: list[tuple[int, int]] = []
    out_parts: list[str] = []
    pos = 0
    for m in _IF_BLOCK.finditer(src):
        out_parts.append(src[pos : m.start()])
        start = len(conditioned)
        take_if(m)
        markers.append((start, len(conditioned)))
        out_parts.append(f" __IF{len(markers) - 1}__;")
        pos = m.end()
    out_parts.append(src[pos:])
    src = "".join(out_parts)

    qregs: dict[str, tuple[int, int]] = {}
    cregs: dict[str, tuple[int, int]] = {}
    nq = 0
    nc = 0
    ops: list[Op] = []

    def emit(stmt: str, cond: tuple[list[int], int] | None) -> None:
        op = _parse_statement(stmt, qregs, cregs)
        if op is None:
            return
        if cond is not None:
            from app.ir import ClassicalCondition

            op.condition = ClassicalCondition(bits=cond[0], value=cond[1])
        ops.append(op)

    for raw in src.split(";"):
        stmt = raw.strip()
        if not stmt:
            continue
        low = stmt.lower()
        if low.startswith("openqasm") or low.startswith("include") or low.startswith("input "):
            continue
        m = re.match(r"^__IF(\d+)__$", stmt)
        if m:
            lo, hi = markers[int(m.group(1))]
            for s, bits, value in conditioned[lo:hi]:
                emit(s, (bits, value))
            continue
        dq = _DECL_Q.match(stmt)
        if dq:
            size = int(dq.group(1) or dq.group(4))
            name = dq.group(2) or dq.group(3)
            qregs[name] = (nq, size)
            nq += size
            continue
        dc = _DECL_C.match(stmt)
        if dc:
            size = int(dc.group(1) or dc.group(4))
            name = dc.group(2) or dc.group(3)
            cregs[name] = (nc, size)
            nc += size
            continue
        emit(stmt, None)

    if nq == 0:
        raise IRError("QASM program declares no qubits")
    return Circuit(version=1, name="qasm", qubits=nq, clbits=nc, ops=ops)


def _parse_condition(cond: str) -> tuple[list[int], int]:
    terms = [t.strip() for t in re.split(r"&&", cond) if t.strip()]
    bits: list[int] = []
    value = 0
    for i, term in enumerate(terms):
        m = _COND_TERM.match(term)
        if m is None:
            raise IRError(f"cannot parse condition {cond!r}")
        idx, v = m.group(2), int(m.group(3))
        if idx is None:
            # `c == 5` over a whole register: expand to per-bit terms.
            if len(terms) != 1:
                raise IRError(f"cannot mix whole-register and bit conditions: {cond!r}")
            width = max(1, v.bit_length())
            return list(range(width)), v
        bits.append(int(idx))
        value |= (v & 1) << i
    return bits, value


def _parse_statement(
    stmt: str, qregs: dict[str, tuple[int, int]], cregs: dict[str, tuple[int, int]]
) -> Op | None:
    def qindex(name: str, idx: int) -> int:
        if name not in qregs:
            raise IRError(f"unknown quantum register {name!r}")
        base, size = qregs[name]
        if not 0 <= idx < size:
            raise IRError(f"{name}[{idx}] out of range")
        return base + idx

    def cindex(name: str, idx: int) -> int:
        if name not in cregs:
            raise IRError(f"unknown classical register {name!r}")
        base, size = cregs[name]
        if not 0 <= idx < size:
            raise IRError(f"{name}[{idx}] out of range")
        return base + idx

    m = _MEASURE_ASSIGN.match(stmt)
    if m:
        return Op(gate="measure", targets=[qindex(m.group(3), int(m.group(4)))],
                  cbits=[cindex(m.group(1), int(m.group(2)))])
    m = _MEASURE_ARROW.match(stmt)
    if m:
        return Op(gate="measure", targets=[qindex(m.group(1), int(m.group(2)))],
                  cbits=[cindex(m.group(3), int(m.group(4)))])

    m = _CALL.match(stmt)
    if m is None:
        raise IRError(f"cannot parse statement {stmt!r}")
    modifiers, name, params_text, operands = m.groups()
    name = name.lower()
    if name in ("openqasm", "include", "input", "output", "const", "let", "def"):
        return None

    qubits: list[int] = []
    for reg, idx in _QREF.findall(operands or ""):
        qubits.append(qindex(reg, int(idx)))
    if not qubits and (operands or "").strip() in qregs:
        base, size = qregs[(operands or "").strip()]
        qubits = list(range(base, base + size))

    if name == "reset":
        return Op(gate="reset", targets=qubits[:1])
    if name == "barrier":
        return Op(gate="barrier", targets=qubits or [0])

    params: list[float] = []
    if params_text:
        inner = params_text.strip()[1:-1].strip()
        if inner:
            params = [eval_angle(p) for p in _split_args(inner)]

    n_ctrl = 0
    for mod in re.finditer(r"(ctrl|inv|pow)\s*(?:\(([^)]*)\))?\s*@", modifiers or ""):
        kind, arg = mod.group(1), mod.group(2)
        if kind == "ctrl":
            n_ctrl += int(arg) if arg else 1
        elif kind == "inv":
            d = GATES.get(name)
            if d is None or d.inverse is None:
                raise IRError(f"cannot invert gate {name!r}")
            if d.inverse.params is not None and params:
                params = list(d.inverse.params(params))
            name = d.inverse.gate
        else:
            raise IRError("pow @ modifier is not supported")

    if name not in GATES:
        raise IRError(f"unknown gate {name!r}")
    if n_ctrl:
        if name == "x" and n_ctrl > 2:
            return Op(gate="mcx", targets=qubits[n_ctrl:], controls=qubits[:n_ctrl])
        alias = {("x", 1): "cx", ("x", 2): "ccx", ("y", 1): "cy", ("z", 1): "cz",
                 ("z", 2): "ccz", ("h", 1): "ch", ("s", 1): "cs", ("sdg", 1): "csdg",
                 ("sx", 1): "csx", ("p", 1): "cp", ("rx", 1): "crx", ("ry", 1): "cry",
                 ("rz", 1): "crz", ("u", 1): "cu", ("swap", 1): "cswap"}.get((name, n_ctrl))
        if alias:
            return Op(gate=alias, targets=qubits, params=[float(p) for p in params])
        return Op(gate=name, targets=qubits[n_ctrl:], controls=qubits[:n_ctrl],
                  params=[float(p) for p in params])
    return Op(gate=name, targets=qubits, params=[float(p) for p in params])


def _split_args(text: str) -> list[str]:
    depth = 0
    out: list[str] = []
    cur: list[str] = []
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if cur:
        out.append("".join(cur))
    return [s.strip() for s in out if s.strip()]


# --------------------------------------------------------------------------
# Qiskit
# --------------------------------------------------------------------------

#: our gate key -> (qiskit.circuit.library class name, number of params)
_QISKIT_GATES: dict[str, str] = {
    "id": "IGate", "x": "XGate", "y": "YGate", "z": "ZGate", "h": "HGate",
    "s": "SGate", "sdg": "SdgGate", "t": "TGate", "tdg": "TdgGate",
    "sx": "SXGate", "sxdg": "SXdgGate", "rx": "RXGate", "ry": "RYGate",
    "rz": "RZGate", "p": "PhaseGate", "u": "UGate", "swap": "SwapGate",
    "iswap": "iSwapGate", "rxx": "RXXGate", "ryy": "RYYGate", "rzz": "RZZGate",
    "rzx": "RZXGate", "ecr": "ECRGate",
}


def to_qiskit(circuit: Circuit, bindings: dict[str, float] | None = None):
    """Build a ``qiskit.QuantumCircuit``. Wire ``q`` becomes Qiskit wire ``n-1-q``.

    Controlled aliases are rewritten to base gate plus ``.control(k)`` so a
    single code path covers cx, ccx and a 5-control mcx.
    """
    from qiskit import QuantumCircuit
    from qiskit.circuit import library as qlib

    n = circuit.qubits
    qc = QuantumCircuit(n, circuit.clbits) if circuit.clbits else QuantumCircuit(n)
    w = lambda q: n - 1 - q  # noqa: E731 -- the entire endian translation, in one place

    for op in circuit.ops:
        if op.gate == "barrier":
            qc.barrier(*[w(t) for t in op.targets])
            continue
        if op.gate == "measure":
            qc.measure(w(op.targets[0]), op.cbits[0])
            continue
        if op.gate == "reset":
            qc.reset(w(op.targets[0]))
            continue
        base_key, targets, controls = base_form(op.gate, op.targets, op.controls)
        cls_name = _QISKIT_GATES.get(base_key)
        if cls_name is None:
            raise IRError(f"gate {op.gate!r} has no Qiskit translation", op.id)
        params = resolve_params(op.params, bindings)
        g = getattr(qlib, cls_name)(*params)
        if controls:
            g = g.control(len(controls))
        wires = [w(c) for c in controls] + [w(t) for t in targets]
        if op.condition is not None:
            raise IRError(
                "classical conditions are not translated to Qiskit; run the "
                "circuit on the native backend, which supports them",
                op.id,
            )
        qc.append(g, wires)
    return qc


_QISKIT_TO_IR: dict[str, str] = {v.lower(): k for k, v in _QISKIT_GATES.items()}
_QISKIT_NAME_TO_IR: dict[str, str] = {
    "id": "id", "x": "x", "y": "y", "z": "z", "h": "h", "s": "s", "sdg": "sdg",
    "t": "t", "tdg": "tdg", "sx": "sx", "sxdg": "sxdg", "rx": "rx", "ry": "ry",
    "rz": "rz", "p": "p", "u": "u", "u3": "u", "swap": "swap", "iswap": "iswap",
    "rxx": "rxx", "ryy": "ryy", "rzz": "rzz", "rzx": "rzx", "ecr": "ecr",
    "cx": "cx", "cy": "cy", "cz": "cz", "ch": "ch", "cs": "cs", "csdg": "csdg",
    "csx": "csx", "cp": "cp", "crx": "crx", "cry": "cry", "crz": "crz",
    "cu": "cu", "ccx": "ccx", "ccz": "ccz", "cswap": "cswap", "mcx": "mcx",
    "measure": "measure", "reset": "reset", "barrier": "barrier",
}


def from_qiskit(qc: Any) -> Circuit:
    """Convert a ``qiskit.QuantumCircuit`` back to IR, undoing the wire reversal.

    Used by ``POST /v1/execute``: a learner writes Qiskit in the sandbox, and
    the graders, the visualiser and the transpiler all speak IR.
    """
    n = qc.num_qubits
    qubit_index = {bit: i for i, bit in enumerate(qc.qubits)}
    clbit_index = {bit: i for i, bit in enumerate(qc.clbits)}
    ops: list[Op] = []
    for inst in qc.data:
        name = inst.operation.name.lower()
        key = _QISKIT_NAME_TO_IR.get(name)
        if key is None:
            raise IRError(f"Qiskit instruction {name!r} has no IR equivalent")
        wires = [n - 1 - qubit_index[b] for b in inst.qubits]
        params = [float(p) for p in inst.operation.params] if inst.operation.params else []
        if key == "measure":
            ops.append(Op(gate="measure", targets=wires, cbits=[clbit_index[inst.clbits[0]]]))
            continue
        if key in ("reset", "barrier"):
            ops.append(Op(gate=key, targets=wires))
            continue
        if key == "mcx":
            ops.append(Op(gate="mcx", targets=wires[-1:], controls=sorted(wires[:-1])))
            continue
        ops.append(Op(gate=key, targets=wires, params=params))
    return Circuit(version=1, name=qc.name or "qiskit", qubits=n,
                   clbits=qc.num_clbits, ops=ops)


# --------------------------------------------------------------------------
# Source generation
# --------------------------------------------------------------------------


def _resolved_matrix(op: Op, base_key: str):
    """The base gate's matrix with this op's numeric parameters substituted."""
    if any(isinstance(p, Symbol) for p in op.params):
        raise IRError(
            f"gate {op.gate!r} has no named form in this dialect and its "
            f"parameters are symbolic, so no literal matrix can be emitted; "
            f"bind the parameters first",
            op.id,
        )
    d = gate(base_key)
    if d.matrix is None:
        raise IRError(f"gate {op.gate!r} has no matrix", op.id)
    return d.matrix([float(p) for p in op.params])


def _src_params(op: Op) -> str:
    return ", ".join(
        p.symbol if isinstance(p, Symbol) else repr(float(p)) for p in op.params
    )


def to_qiskit_source(circuit: Circuit) -> str:
    """Runnable Qiskit source. Emits the wire reversal explicitly and comments why."""
    n = circuit.qubits
    lines = [
        "from qiskit import QuantumCircuit",
        "",
        "# RedQuant puts qubit 0 in the MOST significant bit of a basis index;",
        "# Qiskit puts it in the least. `w()` is that translation, and it is the",
        "# only difference between this circuit and the one in the builder.",
        f"N = {n}",
        "w = lambda q: N - 1 - q",
        "",
        f"qc = QuantumCircuit({n}, {circuit.clbits})" if circuit.clbits
        else f"qc = QuantumCircuit({n})",
    ]
    for op in circuit.ops:
        if op.gate == "measure":
            lines.append(f"qc.measure(w({op.targets[0]}), {op.cbits[0]})")
            continue
        if op.gate in ("reset", "barrier"):
            args = ", ".join(f"w({t})" for t in op.targets)
            lines.append(f"qc.{op.gate}({args})")
            continue
        base_key, targets, controls = base_form(op.gate, op.targets, op.controls)
        method = op.gate if not controls or GATES[op.gate].controlled_form else base_key
        wires = [f"w({q})" for q in (list(controls) + list(targets))] if controls and not GATES[op.gate].controlled_form else [f"w({q})" for q in op.qubits]
        params = _src_params(op)
        call = f"qc.{op.gate}({params}, {', '.join(wires)})" if params else f"qc.{op.gate}({', '.join(wires)})"
        lines.append(call)
    return "\n".join(lines) + "\n"


def _matrix_literal(m) -> str:
    """A NumPy array literal for a gate matrix, for source that must be runnable."""
    rows = []
    for row in m:
        rows.append("[" + ", ".join(_complex_literal(v) for v in row) + "]")
    return "np.array([" + ", ".join(rows) + "], dtype=complex)"


def _complex_literal(v: complex) -> str:
    re, im = float(v.real), float(v.imag)
    if im == 0.0:
        return repr(re)
    return f"complex({re!r}, {im!r})"


def to_cirq_source(circuit: Circuit) -> str:
    """Runnable Cirq source. No index translation: Cirq shares our convention."""
    lines = [
        "import cirq",
        "import numpy as np",
        "",
        "# Cirq orders qubits exactly as RedQuant does: the first qubit is the",
        "# most significant bit of a basis index, so indices carry over unchanged.",
        f"q = cirq.LineQubit.range({circuit.qubits})",
        "circuit = cirq.Circuit()",
    ]
    for op in circuit.ops:
        if op.gate == "barrier":
            continue
        if op.gate == "measure":
            lines.append(
                f"circuit.append(cirq.measure(q[{op.targets[0]}], key='c{op.cbits[0]}'))"
            )
            continue
        if op.gate == "reset":
            lines.append(f"circuit.append(cirq.reset(q[{op.targets[0]}]))")
            continue
        base_key, targets, controls = base_form(op.gate, op.targets, op.controls)
        params = _src_params(op)
        args = ", ".join(f"q[{t}]" for t in targets)
        expr = _CIRQ_SOURCE.get(base_key)
        if expr is None:
            # Cirq has no name for this one (ecr, rzx, u, ...); its matrix is
            # exact in our convention and MatrixGate reads operands most
            # significant first, exactly as we do.
            expr = "cirq.MatrixGate(" + _matrix_literal(_resolved_matrix(op, base_key)) + ")"
            body = expr + f"({args})"
        else:
            body = expr.format(p=params) + f"({args})"
        if controls:
            ctl = ", ".join(f"q[{c}]" for c in controls)
            body += f".controlled_by({ctl})"
        lines.append(f"circuit.append({body})")
    return "\n".join(lines) + "\n"


_CIRQ_SOURCE: dict[str, str] = {
    "id": "cirq.I", "x": "cirq.X", "y": "cirq.Y", "z": "cirq.Z", "h": "cirq.H",
    "s": "cirq.S", "sdg": "(cirq.S ** -1)", "t": "cirq.T", "tdg": "(cirq.T ** -1)",
    "sx": "(cirq.X ** 0.5)", "sxdg": "(cirq.X ** -0.5)",
    "rx": "cirq.rx({p})", "ry": "cirq.ry({p})", "rz": "cirq.rz({p})",
    "p": "cirq.ZPowGate(exponent=({p}) / 3.141592653589793)",
    "swap": "cirq.SWAP", "iswap": "cirq.ISWAP",
    "rxx": "cirq.XXPowGate(exponent=({p}) / 3.141592653589793, global_shift=-0.5)",
    "ryy": "cirq.YYPowGate(exponent=({p}) / 3.141592653589793, global_shift=-0.5)",
    "rzz": "cirq.ZZPowGate(exponent=({p}) / 3.141592653589793, global_shift=-0.5)",
}


def to_pennylane_source(circuit: Circuit) -> str:
    """Runnable PennyLane source. Wires carry over unchanged, as in Cirq."""
    lines = [
        "import pennylane as qml",
        "import numpy as np",
        "",
        "# PennyLane wire 0 is the most significant bit, matching RedQuant.",
        f'dev = qml.device("default.qubit", wires={circuit.qubits})',
        "",
        "@qml.qnode(dev)",
        "def circuit():",
    ]
    body: list[str] = []
    for op in circuit.ops:
        if op.gate in ("barrier", "measure"):
            continue
        if op.gate == "reset":
            body.append(f"    qml.measure({op.targets[0]}, reset=True)")
            continue
        base_key, targets, controls = base_form(op.gate, op.targets, op.controls)
        expr = _PL_SOURCE.get(base_key)
        params = _src_params(op)
        wires = list(targets)
        if expr is None:
            lit = _matrix_literal(_resolved_matrix(op, base_key))
            call = f"qml.QubitUnitary({lit}, wires={wires})"
        else:
            call = expr.format(p=params, w=wires if len(wires) > 1 else wires[0])
        if controls:
            call = f"qml.ctrl({call}, control={list(controls)})"
        body.append(f"    {call}")
    lines.extend(body or ["    pass"])
    lines.append("    return qml.state()")
    return "\n".join(lines) + "\n"


_PL_SOURCE: dict[str, str] = {
    "id": "qml.Identity({w})", "x": "qml.PauliX({w})", "y": "qml.PauliY({w})",
    "z": "qml.PauliZ({w})", "h": "qml.Hadamard({w})", "s": "qml.S({w})",
    "sdg": "qml.adjoint(qml.S({w}))", "t": "qml.T({w})",
    "tdg": "qml.adjoint(qml.T({w}))", "sx": "qml.SX({w})",
    "sxdg": "qml.adjoint(qml.SX({w}))", "rx": "qml.RX({p}, {w})",
    "ry": "qml.RY({p}, {w})", "rz": "qml.RZ({p}, {w})",
    "p": "qml.PhaseShift({p}, {w})", "u": "qml.U3({p}, {w})",
    "swap": "qml.SWAP({w})", "iswap": "qml.ISWAP({w})",
    "rxx": "qml.IsingXX({p}, {w})", "ryy": "qml.IsingYY({p}, {w})",
    "rzz": "qml.IsingZZ({p}, {w})", "ecr": "qml.ECR({w})",
}


DIALECTS: tuple[str, ...] = ("qasm3", "qiskit", "cirq", "pennylane")


def to_source(circuit: Circuit, dialect: str, bindings: dict[str, float] | None = None) -> str:
    if dialect == "qasm3":
        return to_qasm3(circuit, bindings)
    if dialect == "qiskit":
        return to_qiskit_source(circuit)
    if dialect == "cirq":
        return to_cirq_source(circuit)
    if dialect == "pennylane":
        return to_pennylane_source(circuit)
    raise IRError(f"unknown dialect {dialect!r}; known: {', '.join(DIALECTS)}")


__all__ = [
    "DIALECTS",
    "eval_angle",
    "from_qasm3",
    "from_qiskit",
    "to_cirq_source",
    "to_pennylane_source",
    "to_qasm3",
    "to_qiskit",
    "to_qiskit_source",
    "to_source",
]
