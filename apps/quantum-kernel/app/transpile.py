"""A real transpiler: decomposition, layout, routing, basis translation, optimisation.

The lesson this powers ("why does my 12-gate circuit become 90 gates on real
hardware?") only works if the numbers are honest, so every pass here is the
actual algorithm rather than a demonstration of one:

* **decomposition** -- controlled gates go to CNOT + single-qubit rotations by
  the Nielsen & Chuang ``U = e^{i alpha} A X B X C`` construction, two-control
  gates by the square-root construction, and every named two-qubit gate by a
  hand-verified CNOT identity. All exact, not up to global phase, because a
  decomposition that loses phase becomes wrong the moment something controls it.
* **layout** -- trivial, or a greedy placement that seeds on the heaviest
  interacting pair and grows by weighted distance.
* **routing** -- SABRE: front layer, extended lookahead set with a decay
  penalty, swap candidates drawn from the neighbourhood of the front layer.
* **basis translation** -- to ``{rz, sx, x, cx}`` (IBM superconducting) or
  ``{rx, ry, rzz}`` (trapped ion), via ZYZ Euler angles.
* **optimisation** -- maximal single-qubit runs collapsed to one Euler triple,
  adjacent self-inverse pairs cancelled, zero-angle rotations dropped.

``tests/test_transpile.py`` proves semantic equivalence on the full unitary
(``equal_up_to_global_phase``) for every pass and every basis, including through
routing, where the layout permutation is undone explicitly.
"""

from __future__ import annotations

import cmath
import math
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Iterable, Literal, Sequence

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from app.gates import GATES, SELF_INVERSE, Matrix, base_form, gate, op_matrix
from app.ir import Circuit, CircuitMetrics, IRError, Op, metrics, resolve_params
from app.noise import DEVICE_NAMES, device_model

#: Angles below this are treated as zero when dropping trivial rotations.
ANGLE_EPS = 1e-12

BASIS_SETS: dict[str, tuple[str, ...]] = {
    "ibm": ("rz", "sx", "x", "cx"),
    "ion": ("rx", "ry", "rzz"),
    "u_cx": ("u", "cx"),
    "none": (),
}


# --------------------------------------------------------------------------
# Single-qubit Euler decomposition
# --------------------------------------------------------------------------


def zyz(u: Matrix) -> tuple[float, float, float, float]:
    """Decompose a 2x2 unitary as ``e^{i alpha} Rz(beta) Ry(gamma) Rz(delta)``.

    Returns ``(alpha, beta, gamma, delta)``. The global phase is returned rather
    than discarded because the controlled-gate constructions need it: a
    controlled ``e^{i alpha} V`` is a phase gate on the control times a
    controlled ``V``, and dropping ``alpha`` silently changes the circuit.
    """
    if u.shape != (2, 2):
        raise ValueError("zyz needs a 2x2 matrix")
    det = u[0, 0] * u[1, 1] - u[0, 1] * u[1, 0]
    alpha = 0.5 * cmath.phase(det)
    v = u * cmath.exp(-1j * alpha)  # now in SU(2): det(v) == 1
    a, b, c, d = v[0, 0], v[0, 1], v[1, 0], v[1, 1]
    gamma = 2.0 * math.atan2(abs(c), abs(a))
    if abs(c) < 1e-12:
        # gamma == 0: only beta + delta is determined; put it all in beta.
        beta = 2.0 * cmath.phase(d)
        delta = 0.0
    elif abs(a) < 1e-12:
        # gamma == pi: only beta - delta is determined.
        beta = 2.0 * cmath.phase(c)
        delta = 0.0
    else:
        pd = cmath.phase(d)  # (beta + delta) / 2
        pc = cmath.phase(c)  # (beta - delta) / 2
        beta = pd + pc
        delta = pd - pc
    return alpha, beta, gamma, delta


def _op(gate_key: str, targets: list[int], params: list[float] | None = None,
        controls: list[int] | None = None) -> Op:
    return Op(gate=gate_key, targets=targets, params=[float(p) for p in (params or [])],
              controls=controls or [])


def _wrap(theta: float) -> float:
    """Fold an angle into (-pi, pi]; keeps emitted rotations readable and small."""
    a = math.fmod(theta, 2.0 * math.pi)
    if a <= -math.pi:
        a += 2.0 * math.pi
    if a > math.pi:
        a -= 2.0 * math.pi
    return 0.0 if abs(a) < ANGLE_EPS else a


def _is_diagonal(u: Matrix) -> bool:
    return abs(u[0, 1]) < 1e-12 and abs(u[1, 0]) < 1e-12


def _is_antidiagonal(u: Matrix) -> bool:
    return abs(u[0, 0]) < 1e-12 and abs(u[1, 1]) < 1e-12


def emit_u(u: Matrix, q: int) -> list[Op]:
    """One ``u`` gate. The neutral form: exact up to global phase, minimal size."""
    _, beta, gamma, delta = zyz(u)
    if abs(_wrap(gamma)) < ANGLE_EPS and abs(_wrap(beta + delta)) < ANGLE_EPS:
        return []
    return [_op("u", [q], [gamma, beta, delta])]


def emit_zyz(u: Matrix, q: int) -> list[Op]:
    """``rz(delta), ry(gamma), rz(beta)`` in circuit order, zero angles dropped."""
    _, beta, gamma, delta = zyz(u)
    out: list[Op] = []
    for key, angle in (("rz", delta), ("ry", gamma), ("rz", beta)):
        a = _wrap(angle)
        if a:
            out.append(_op(key, [q], [a]))
    return out


def emit_ibm(u: Matrix, q: int) -> list[Op]:
    """Express a 1-qubit unitary in ``{rz, sx, x}``.

    Derivation, because the identity is not the one people half-remember:
    ``Rx(pi/2) Rz(b) Rx(pi/2) == Ry(-b) Rx(pi)``, so the two-SX sandwich is a
    ZYZ triple *times a fixed X*. Solving for the triple therefore means
    decomposing ``U X`` rather than ``U``:

        U ~ Rz(beta) . SX . Rz(-gamma) . SX . Rz(-delta),
        where (beta, gamma, delta) are the ZYZ angles of ``U @ X``.

    Diagonal and anti-diagonal inputs short-circuit to one ``rz`` or one ``x``,
    which is what keeps a transpiled Clifford circuit from tripling in size.
    """
    if _is_diagonal(u):
        theta = _wrap(cmath.phase(u[1, 1]) - cmath.phase(u[0, 0]))
        return [_op("rz", [q], [theta])] if theta else []
    if _is_antidiagonal(u):
        theta = _wrap(cmath.phase(u[1, 0]) - cmath.phase(u[0, 1]))
        ops = [_op("x", [q])]
        if theta:
            ops.append(_op("rz", [q], [theta]))
        return ops
    x = np.array([[0, 1], [1, 0]], dtype=np.complex128)
    _, beta, gamma, delta = zyz(u @ x)
    out: list[Op] = []
    for key, angle in (("rz", -delta), ("sx", None), ("rz", -gamma), ("sx", None), ("rz", beta)):
        if key == "sx":
            out.append(_op("sx", [q]))
        else:
            a = _wrap(angle)  # type: ignore[arg-type]
            if a:
                out.append(_op("rz", [q], [a]))
    return out


def emit_ion(u: Matrix, q: int) -> list[Op]:
    """Express a 1-qubit unitary in ``{rx, ry}``.

    ``Rz(x) == Ry(-pi/2) Rx(x) Ry(pi/2)``, so substituting into ZYZ and merging
    the adjacent Y rotations gives ``Ry(-pi/2) Rx(beta) Ry(gamma) Rx(delta) Ry(pi/2)``.
    """
    _, beta, gamma, delta = zyz(u)
    half = math.pi / 2.0
    seq: list[tuple[str, float]] = [
        ("ry", half), ("rx", delta), ("ry", gamma), ("rx", beta), ("ry", -half)
    ]
    out: list[Op] = []
    for key, angle in seq:
        a = _wrap(angle)
        if a:
            out.append(_op(key, [q], [a]))
    return out


ONE_QUBIT_EMITTERS: dict[str, Callable[[Matrix, int], list[Op]]] = {
    "ibm": emit_ibm,
    "ion": emit_ion,
    "u_cx": emit_u,
    "none": emit_zyz,
}


# --------------------------------------------------------------------------
# Multi-qubit decomposition to {1-qubit, cx}
# --------------------------------------------------------------------------


def _sqrtm_unitary(u: Matrix) -> Matrix:
    """A principal square root of a unitary, via its spectral decomposition."""
    w, v = np.linalg.eig(u)
    root = v @ np.diag(np.sqrt(w.astype(np.complex128))) @ np.linalg.inv(v)
    if not np.allclose(root @ root, u, atol=1e-9):
        from scipy.linalg import sqrtm  # scipy is a hard dependency; this is the fallback

        root = np.asarray(sqrtm(u), dtype=np.complex128)
    return root


def controlled_u_ops(u: Matrix, control: int, target: int) -> list[Op]:
    """``C-U`` as CNOTs plus single-qubit rotations, exactly (phase included).

    Nielsen & Chuang 4.3: write ``U = e^{i alpha} A X B X C`` with ``ABC == I``,
    then ``C-U`` is ``C, CNOT, B, CNOT, A`` on the target plus ``P(alpha)`` on the
    control. The phase gate is what makes this exact rather than
    up-to-global-phase, and it is why :func:`zyz` returns ``alpha`` at all.
    """
    alpha, beta, gamma, delta = zyz(u)
    ops: list[Op] = []
    # C = Rz((delta - beta) / 2)
    if _wrap((delta - beta) / 2.0):
        ops.append(_op("rz", [target], [_wrap((delta - beta) / 2.0)]))
    ops.append(_op("cx", [control, target]))
    # B = Ry(-gamma/2) Rz(-(delta + beta)/2)  -> circuit order rz then ry
    if _wrap(-(delta + beta) / 2.0):
        ops.append(_op("rz", [target], [_wrap(-(delta + beta) / 2.0)]))
    if _wrap(-gamma / 2.0):
        ops.append(_op("ry", [target], [_wrap(-gamma / 2.0)]))
    ops.append(_op("cx", [control, target]))
    # A = Rz(beta) Ry(gamma/2)  -> circuit order ry then rz
    if _wrap(gamma / 2.0):
        ops.append(_op("ry", [target], [_wrap(gamma / 2.0)]))
    if _wrap(beta):
        ops.append(_op("rz", [target], [_wrap(beta)]))
    if _wrap(alpha):
        ops.append(_op("p", [control], [_wrap(alpha)]))
    return ops


#: The textbook 6-CNOT Toffoli. Exact, including phase.
def toffoli_ops(c1: int, c2: int, t: int) -> list[Op]:
    return [
        _op("h", [t]),
        _op("cx", [c2, t]), _op("tdg", [t]),
        _op("cx", [c1, t]), _op("t", [t]),
        _op("cx", [c2, t]), _op("tdg", [t]),
        _op("cx", [c1, t]), _op("t", [c2]), _op("t", [t]),
        _op("h", [t]),
        _op("cx", [c1, c2]), _op("t", [c1]), _op("tdg", [c2]),
        _op("cx", [c1, c2]),
    ]


def multi_controlled_ops(u: Matrix, controls: Sequence[int], target: int,
                         max_controls: int = 6) -> list[Op]:
    """``C^k-U`` by the square-root recursion, exact at every level.

    ``C^k U = C^{k-1}V . CX(c_{k-1}, c_k) . C^{k-1}V^dagger . CX . C(V)`` with
    ``V = sqrt(U)`` (Barenco et al. 1995, Lemma 6.1). Gate count grows like
    ``2^k``, which is the honest cost of an ancilla-free construction; beyond
    ``max_controls`` we refuse instead of emitting tens of thousands of gates,
    and point the caller at the ancilla-assisted form.
    """
    k = len(controls)
    if k == 0:
        return []
    if k == 1:
        return controlled_u_ops(u, controls[0], target)
    if k > max_controls:
        raise IRError(
            f"ancilla-free decomposition of a {k}-controlled gate needs "
            f"O(2^{k}) gates; add ancilla qubits and use a CCX ladder instead"
        )
    if k == 2 and np.allclose(u, np.array([[0, 1], [1, 0]], dtype=np.complex128)):
        return toffoli_ops(controls[0], controls[1], target)
    v = _sqrtm_unitary(u)
    vdg = v.conj().T
    head, last = list(controls[:-1]), controls[-1]
    return (
        controlled_u_ops(v, last, target)
        + multi_controlled_ops(np.array([[0, 1], [1, 0]], dtype=np.complex128), head, last,
                               max_controls)
        + controlled_u_ops(vdg, last, target)
        + multi_controlled_ops(np.array([[0, 1], [1, 0]], dtype=np.complex128), head, last,
                               max_controls)
        + multi_controlled_ops(v, head, target, max_controls)
    )


def _two_qubit_ops(key: str, params: list[float], a: int, b: int) -> list[Op] | None:
    """Exact CNOT-based identities for the named two-qubit gates.

    Each one is pinned numerically in ``tests/test_transpile.py``; they are
    written out rather than derived so that a reader can check them against a
    textbook.
    """
    half = math.pi / 2.0
    if key == "cx":
        return [_op("cx", [a, b])]
    if key == "swap":
        return [_op("cx", [a, b]), _op("cx", [b, a]), _op("cx", [a, b])]
    if key == "iswap":
        return [_op("s", [a]), _op("s", [b]), _op("h", [a]),
                _op("cx", [a, b]), _op("cx", [b, a]), _op("h", [b])]
    if key == "rzz":
        return [_op("cx", [a, b]), _op("rz", [b], [params[0]]), _op("cx", [a, b])]
    if key == "rxx":
        return [_op("h", [a]), _op("h", [b])] + _two_qubit_ops("rzz", params, a, b) + [
            _op("h", [a]), _op("h", [b])]
    if key == "ryy":
        return ([_op("rx", [a], [-half]), _op("rx", [b], [-half])]
                + _two_qubit_ops("rzz", params, a, b)
                + [_op("rx", [a], [half]), _op("rx", [b], [half])])
    if key == "rzx":
        return [_op("h", [b])] + _two_qubit_ops("rzz", params, a, b) + [_op("h", [b])]
    if key == "ecr":
        return (_two_qubit_ops("rzx", [math.pi / 4.0], a, b)
                + [_op("x", [a])]
                + _two_qubit_ops("rzx", [-math.pi / 4.0], a, b))
    return None


def decompose(circuit: Circuit, max_controls: int = 6) -> Circuit:
    """Rewrite every op into single-qubit gates plus CNOTs.

    Measure, reset and barrier pass through untouched; a classical condition is
    carried onto *every* gate of the replacement, which is correct because the
    condition gates the whole operation.
    """
    ops: list[Op] = []
    for op in circuit.ops:
        for produced in _decompose_op(op, max_controls):
            if op.condition is not None:
                produced = produced.model_copy(update={"condition": op.condition})
            ops.append(produced)
    return circuit.model_copy(update={"ops": ops, "name": f"{circuit.name}"})


def _decompose_op(op: Op, max_controls: int) -> list[Op]:
    if op.gate in ("measure", "reset", "barrier"):
        return [op]
    base_key, targets, controls = base_form(op.gate, op.targets, op.controls)
    params = [float(p) for p in resolve_params(op.params, None)]
    d = gate(base_key)

    if not controls:
        if len(targets) == 1:
            return [Op(gate=base_key, targets=targets, params=params)]
        two = _two_qubit_ops(base_key, params, targets[0], targets[1]) if len(targets) == 2 else None
        if two is not None:
            return two
        raise IRError(f"no CNOT decomposition for gate {op.gate!r}", op.id)

    if base_key == "swap" and len(targets) == 2:
        # Fredkin: CNOT(t2, t1), Toffoli(controls + t1 -> t2), CNOT(t2, t1).
        t1, t2 = targets
        inner = multi_controlled_ops(
            np.array([[0, 1], [1, 0]], dtype=np.complex128),
            list(controls) + [t1], t2, max_controls,
        )
        return [_op("cx", [t2, t1])] + inner + [_op("cx", [t2, t1])]

    if len(targets) != 1:
        raise IRError(
            f"controlled multi-target gate {op.gate!r} has no decomposition", op.id
        )
    if d.matrix is None:
        raise IRError(f"gate {op.gate!r} has no matrix", op.id)
    return multi_controlled_ops(d.matrix(params), list(controls), targets[0], max_controls)


# --------------------------------------------------------------------------
# Coupling maps, layout and routing
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class CouplingMap:
    """An undirected hardware connectivity graph with cached all-pairs distances."""

    num_qubits: int
    edges: tuple[tuple[int, int], ...]

    @property
    def adjacency(self) -> dict[int, set[int]]:
        adj: dict[int, set[int]] = {q: set() for q in range(self.num_qubits)}
        for a, b in self.edges:
            adj[a].add(b)
            adj[b].add(a)
        return adj

    def distance_matrix(self) -> np.ndarray:
        """BFS from every node. Unreachable pairs get a large finite penalty so
        the routing heuristic degrades gracefully on a disconnected device."""
        n = self.num_qubits
        adj = self.adjacency
        big = n * 4
        dist = np.full((n, n), big, dtype=np.int64)
        for src in range(n):
            dist[src, src] = 0
            queue = deque([src])
            while queue:
                cur = queue.popleft()
                for nb in adj[cur]:
                    if dist[src, nb] == big:
                        dist[src, nb] = dist[src, cur] + 1
                        queue.append(nb)
        return dist

    def is_adjacent(self, a: int, b: int) -> bool:
        return (a, b) in self.edges or (b, a) in self.edges

    @staticmethod
    def from_pairs(pairs: Iterable[Sequence[int]], num_qubits: int | None = None) -> "CouplingMap":
        edges = tuple(sorted({(int(min(p)), int(max(p))) for p in pairs}))
        n = (max((max(e) for e in edges), default=-1) + 1) if num_qubits is None else num_qubits
        return CouplingMap(num_qubits=n, edges=edges)

    @staticmethod
    def from_device(name: str) -> "CouplingMap":
        d = device_model(name)
        return CouplingMap(num_qubits=d.num_qubits, edges=d.coupling_map)

    @staticmethod
    def line(n: int) -> "CouplingMap":
        return CouplingMap(num_qubits=n, edges=tuple((i, i + 1) for i in range(n - 1)))

    @staticmethod
    def full(n: int) -> "CouplingMap":
        return CouplingMap(
            num_qubits=n, edges=tuple((a, b) for a in range(n) for b in range(a + 1, n))
        )


def interaction_weights(circuit: Circuit) -> dict[tuple[int, int], int]:
    """How often each logical pair interacts. The input to greedy layout."""
    w: dict[tuple[int, int], int] = {}
    for op in circuit.ops:
        qs = op.qubits
        if len(qs) != 2:
            continue
        key = (min(qs), max(qs))
        w[key] = w.get(key, 0) + 1
    return w


def trivial_layout(circuit: Circuit, coupling: CouplingMap) -> list[int]:
    """Logical ``i`` on physical ``i``. The baseline every other layout must beat."""
    if circuit.qubits > coupling.num_qubits:
        raise IRError(
            f"circuit needs {circuit.qubits} qubits, device has {coupling.num_qubits}"
        )
    return list(range(circuit.qubits))


def greedy_layout(circuit: Circuit, coupling: CouplingMap) -> list[int]:
    """Place the heaviest interacting pair on the best-connected edge, then grow.

    A cheap alternative to SABRE's forward-backward layout refinement: seed on
    the pair that interacts most often, put it on the physical edge whose two
    endpoints have the highest combined degree, then repeatedly place the
    unplaced logical qubit with the strongest ties to already-placed ones on the
    free physical qubit that minimises weighted distance. On the heavy-hex maps
    this typically halves the swap count versus trivial, which
    ``tests/test_transpile.py`` checks on a worked example.
    """
    n_log = circuit.qubits
    if n_log > coupling.num_qubits:
        raise IRError(
            f"circuit needs {n_log} qubits, device has {coupling.num_qubits}"
        )
    weights = interaction_weights(circuit)
    if not weights:
        return trivial_layout(circuit, coupling)
    dist = coupling.distance_matrix()
    adj = coupling.adjacency
    degree = {q: len(adj[q]) for q in range(coupling.num_qubits)}

    placement: dict[int, int] = {}
    used: set[int] = set()

    (la, lb), _ = max(weights.items(), key=lambda kv: (kv[1], -kv[0][0], -kv[0][1]))
    pa, pb = max(coupling.edges, key=lambda e: (degree[e[0]] + degree[e[1]], -e[0]))
    placement[la], placement[lb] = pa, pb
    used.update((pa, pb))

    remaining = [q for q in range(n_log) if q not in placement]
    while remaining:
        def tie_strength(q: int) -> int:
            return sum(
                w for (a, b), w in weights.items()
                if (a == q and b in placement) or (b == q and a in placement)
            )

        remaining.sort(key=lambda q: (-tie_strength(q), q))
        q = remaining.pop(0)
        neighbours = [
            (placement[b if a == q else a], w)
            for (a, b), w in weights.items()
            if (a == q and b in placement) or (b == q and a in placement)
        ]
        free = [p for p in range(coupling.num_qubits) if p not in used]
        if not free:
            raise IRError("no free physical qubit left for layout")
        if neighbours:
            best = min(free, key=lambda p: (sum(w * dist[p, pq] for pq, w in neighbours), -degree[p], p))
        else:
            best = max(free, key=lambda p: (degree[p], -p))
        placement[q] = best
        used.add(best)
    return [placement[q] for q in range(n_log)]


LAYOUTS: dict[str, Callable[[Circuit, CouplingMap], list[int]]] = {
    "trivial": trivial_layout,
    "greedy": greedy_layout,
}


@dataclass
class RoutingResult:
    ops: list[Op]
    initial_layout: list[int]
    final_layout: list[int]
    swaps: int


def sabre_route(
    circuit: Circuit,
    coupling: CouplingMap,
    initial_layout: Sequence[int],
    extended_size: int = 20,
    extended_weight: float = 0.5,
    decay_delta: float = 0.001,
    decay_reset: int = 5,
    max_rounds: int | None = None,
) -> RoutingResult:
    """SABRE routing: insert SWAPs until every two-qubit gate is on an edge.

    The heuristic is Li, Ding & Xie 2019: score a candidate SWAP by the mean
    coupling distance of the front layer after applying it, plus a decayed,
    down-weighted contribution from a lookahead window, plus a per-qubit decay
    that discourages using the same qubit for consecutive swaps (which is what
    stops the search oscillating between two mappings forever).
    """
    n_phys = coupling.num_qubits
    dist = coupling.distance_matrix()
    adj = coupling.adjacency
    pi = list(initial_layout) + [
        p for p in range(n_phys) if p not in set(initial_layout)
    ]
    # pi[logical] = physical; inv[physical] = logical
    inv = [0] * n_phys
    for l, p in enumerate(pi):
        inv[p] = l

    ops = list(circuit.ops)
    n_ops = len(ops)
    # Dependency graph: an op depends on the previous op touching any of its
    # qubits or classical bits.
    preds: list[int] = [0] * n_ops
    succs: list[list[int]] = [[] for _ in range(n_ops)]
    last_q: dict[int, int] = {}
    last_c: dict[int, int] = {}
    for i, op in enumerate(ops):
        deps: set[int] = set()
        for q in op.qubits:
            if q in last_q:
                deps.add(last_q[q])
        for c in list(op.cbits) + (list(op.condition.bits) if op.condition else []):
            if c in last_c:
                deps.add(last_c[c])
        preds[i] = len(deps)
        for d in deps:
            succs[d].append(i)
        for q in op.qubits:
            last_q[q] = i
        for c in list(op.cbits) + (list(op.condition.bits) if op.condition else []):
            last_c[c] = i

    front = deque(i for i in range(n_ops) if preds[i] == 0)
    remaining = set(range(n_ops))
    out: list[Op] = []
    swaps = 0
    decay = [1.0] * n_phys
    since_reset = 0
    limit = max_rounds if max_rounds is not None else 200 * max(n_ops, 1) + 1000

    def emit(idx: int) -> None:
        op = ops[idx]
        out.append(
            op.model_copy(
                update={
                    "targets": [pi[t] for t in op.targets],
                    "controls": [pi[c] for c in op.controls],
                }
            )
        )
        remaining.discard(idx)
        for s in succs[idx]:
            preds[s] -= 1
            if preds[s] == 0:
                front.append(s)

    rounds = 0
    while remaining:
        rounds += 1
        if rounds > limit:  # pragma: no cover - guards against a pathological map
            raise IRError("routing failed to converge; is the coupling map connected?")
        progressed = False
        stuck: list[int] = []
        while front:
            idx = front.popleft()
            op = ops[idx]
            qs = op.qubits
            if len(qs) <= 1:
                emit(idx)
                progressed = True
            elif len(qs) == 2 and coupling.is_adjacent(pi[qs[0]], pi[qs[1]]):
                emit(idx)
                progressed = True
            else:
                stuck.append(idx)
        front.extend(stuck)
        if not remaining:
            break
        if progressed:
            decay = [1.0] * n_phys
            since_reset = 0
            continue

        active = [i for i in front if len(ops[i].qubits) == 2]
        if not active:
            raise IRError(
                "routing cannot place a gate on more than two qubits; run "
                "decompose() before routing"
            )
        extended = [
            i for i in sorted(remaining)
            if i not in front and len(ops[i].qubits) == 2
        ][:extended_size]

        candidates: set[tuple[int, int]] = set()
        for i in active:
            for q in ops[i].qubits:
                p = pi[q]
                for nb in adj[p]:
                    candidates.add((min(p, nb), max(p, nb)))
        if not candidates:
            raise IRError("routing found no swap candidates; coupling map is empty")

        def score(swap: tuple[int, int]) -> float:
            p1, p2 = swap
            l1, l2 = inv[p1], inv[p2]
            trial = list(pi)
            trial[l1], trial[l2] = p2, p1
            base = sum(dist[trial[ops[i].qubits[0]], trial[ops[i].qubits[1]]] for i in active)
            base /= len(active)
            if extended:
                ext = sum(
                    dist[trial[ops[i].qubits[0]], trial[ops[i].qubits[1]]] for i in extended
                ) / len(extended)
                base += extended_weight * ext
            return max(decay[p1], decay[p2]) * base

        best = min(sorted(candidates), key=score)
        p1, p2 = best
        l1, l2 = inv[p1], inv[p2]
        pi[l1], pi[l2] = p2, p1
        inv[p1], inv[p2] = l2, l1
        out.append(Op(gate="swap", targets=[p1, p2]))
        swaps += 1
        since_reset += 1
        if since_reset >= decay_reset:
            decay = [1.0] * n_phys
            since_reset = 0
        else:
            decay[p1] += decay_delta
            decay[p2] += decay_delta

    return RoutingResult(ops=out, initial_layout=list(initial_layout),
                         final_layout=pi[: circuit.qubits], swaps=swaps)


def permutation_operator(pi: Sequence[int], n: int) -> np.ndarray:
    """Operator sending logical qubit ``l`` to physical wire ``pi[l]``.

    Used to undo layout and routing when checking semantic equivalence:
    ``U_logical == P(final)^dagger . U_physical . P(initial)``.
    """
    dim = 1 << n
    p = np.zeros((dim, dim), dtype=np.complex128)
    for i in range(dim):
        j = 0
        for l in range(n):
            bit = (i >> (n - 1 - l)) & 1
            if bit:
                j |= 1 << (n - 1 - pi[l])
        p[j, i] = 1.0
    return p


# --------------------------------------------------------------------------
# Optimisation passes
# --------------------------------------------------------------------------


def cancel_adjacent_inverses(circuit: Circuit) -> Circuit:
    """Delete pairs of adjacent, identical, self-inverse gates.

    "Adjacent" means adjacent in the dependency graph, not in the op list: an
    ``h`` on qubit 3 still cancels a previous ``h`` on qubit 3 even with a dozen
    gates on other qubits in between, which is the whole point.
    """
    ops = circuit.ops
    out: list[Op | None] = []
    hist: dict[int, list[int]] = {}
    for op in ops:
        qs = op.qubits
        if (
            op.gate in SELF_INVERSE
            and not op.params
            and op.condition is None
            and qs
            and all(hist.get(q) for q in qs)
        ):
            tops = {hist[q][-1] for q in qs}
            if len(tops) == 1:
                i = tops.pop()
                prev = out[i]
                if (
                    prev is not None
                    and prev.gate == op.gate
                    and prev.targets == op.targets
                    and sorted(prev.controls) == sorted(op.controls)
                    and prev.condition is None
                    and set(prev.qubits) == set(qs)
                ):
                    out[i] = None
                    for q in qs:
                        hist[q].pop()
                    continue
        out.append(op)
        idx = len(out) - 1
        for q in qs:
            hist.setdefault(q, []).append(idx)
    kept = [o for o in out if o is not None]
    if len(kept) == len(ops):
        return circuit
    return cancel_adjacent_inverses(circuit.model_copy(update={"ops": kept}))


def drop_trivial_rotations(circuit: Circuit) -> Circuit:
    """Remove ``id`` and rotations whose angle is zero modulo 2*pi."""
    kept: list[Op] = []
    for op in circuit.ops:
        if op.gate == "id":
            continue
        if op.gate in ("rx", "ry", "rz", "p") and len(op.params) == 1 and not op.controls:
            try:
                if abs(_wrap(float(op.params[0]))) < ANGLE_EPS:
                    continue
            except TypeError:  # symbolic parameter: keep it
                pass
        kept.append(op)
    return circuit.model_copy(update={"ops": kept})


def merge_single_qubit_runs(
    circuit: Circuit,
    emitter: Callable[[Matrix, int], list[Op]],
    basis_gates: Sequence[str] = (),
) -> Circuit:
    """Collapse each maximal run of single-qubit gates into one Euler triple.

    A run ends at the first op on that qubit which is multi-qubit, non-unitary,
    classically conditioned or symbolically parameterised. The run's matrix is
    the ordered product, and ``emitter`` re-expresses it in the target basis --
    which is how "17 gates on qubit 2" becomes "rz, sx, rz, sx, rz".

    A run of exactly one gate is left alone when that gate is already in
    ``basis_gates``: re-emitting a lone ``sx`` through the ZYZ path would turn
    one gate into five for no gain. With an empty ``basis_gates`` (no target
    basis) every singleton is left alone.
    """
    pending: dict[int, list[Op]] = {}
    out: list[Op] = []

    def flush(q: int) -> None:
        run = pending.pop(q, [])
        if not run:
            return
        if len(run) == 1 and (not basis_gates or run[0].gate in basis_gates):
            out.append(run[0])
            return
        u = np.eye(2, dtype=np.complex128)
        for op in run:
            u = op_matrix(op.gate, [float(p) for p in op.params]) @ u
        out.extend(emitter(u, q))

    for op in circuit.ops:
        qs = op.qubits
        mergeable = (
            len(qs) == 1
            and not op.controls
            and op.condition is None
            and op.gate in GATES
            and GATES[op.gate].unitary
            and GATES[op.gate].matrix is not None
            and all(not hasattr(p, "symbol") for p in op.params)
        )
        if mergeable:
            pending.setdefault(qs[0], []).append(op)
            continue
        for q in qs:
            flush(q)
        out.append(op)
    for q in sorted(pending):
        flush(q)
    return circuit.model_copy(update={"ops": out})


# --------------------------------------------------------------------------
# The driver
# --------------------------------------------------------------------------


class TranspileTarget(BaseModel):
    """What to compile for. Every field has a defensible default."""

    model_config = ConfigDict(extra="forbid")

    basis: Literal["ibm", "ion", "u_cx", "none"] = "ibm"
    #: Named device, or an explicit coupling map, or neither (all-to-all).
    device: str | None = None
    coupling_map: list[list[int]] | None = None
    layout: Literal["trivial", "greedy", "none"] = "greedy"
    route: bool = True
    optimise: bool = True
    #: 0 no optimisation, 1 cancellation, 2 + run merging, 3 + a second sweep.
    optimisation_level: int = Field(default=2, ge=0, le=3)
    max_controls: int = Field(default=6, ge=1, le=8)

    def resolve_coupling(self, min_qubits: int) -> CouplingMap | None:
        if self.device:
            return CouplingMap.from_device(self.device)
        if self.coupling_map:
            return CouplingMap.from_pairs(self.coupling_map)
        return None


@dataclass
class TranspileResult:
    circuit: Circuit
    before: CircuitMetrics
    after: CircuitMetrics
    initial_layout: list[int]
    final_layout: list[int]
    swaps_added: int
    passes: list[str]
    basis: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "circuit": self.circuit.model_dump(),
            "before": self.before.to_dict(),
            "after": self.after.to_dict(),
            "initialLayout": self.initial_layout,
            "finalLayout": self.final_layout,
            "swapsAdded": self.swaps_added,
            "passes": self.passes,
            "basis": list(self.basis),
            "delta": {
                "depth": self.after.depth - self.before.depth,
                "size": self.after.size - self.before.size,
                "twoQubitGates": self.after.two_qubit_gates - self.before.two_qubit_gates,
            },
        }


def transpile(circuit: Circuit, target: TranspileTarget | None = None) -> TranspileResult:
    """Run the full pipeline and report before/after metrics."""
    target = target or TranspileTarget()
    before = metrics(circuit)
    passes: list[str] = []

    coupling = target.resolve_coupling(circuit.qubits)
    work = circuit
    if coupling is not None and circuit.qubits < coupling.num_qubits:
        # Pad to the device width so layout and routing can use spare qubits.
        work = work.model_copy(update={"qubits": coupling.num_qubits})

    work = decompose(work, target.max_controls)
    passes.append("decompose")

    initial_layout = list(range(work.qubits))
    final_layout = list(initial_layout)
    swaps = 0

    if coupling is not None and target.layout != "none":
        chooser = LAYOUTS[target.layout]
        logical = circuit.model_copy(update={"ops": work.ops, "qubits": circuit.qubits})
        initial_layout = chooser(logical, coupling)
        initial_layout = initial_layout + [
            p for p in range(coupling.num_qubits) if p not in set(initial_layout)
        ]
        passes.append(f"layout:{target.layout}")

    if coupling is not None and target.route:
        routed = sabre_route(work, coupling, initial_layout)
        work = work.model_copy(update={"ops": routed.ops, "qubits": coupling.num_qubits})
        final_layout = routed.final_layout + [
            p for p in range(coupling.num_qubits) if p not in set(routed.final_layout)
        ]
        swaps = routed.swaps
        passes.append("route:sabre")
        # SWAPs are three CNOTs on hardware; expand them into the basis too.
        work = decompose(work, target.max_controls)
        passes.append("decompose:swaps")
    elif coupling is not None and target.layout != "none":
        work = work.model_copy(
            update={
                "ops": [
                    op.model_copy(
                        update={
                            "targets": [initial_layout[t] for t in op.targets],
                            "controls": [initial_layout[c] for c in op.controls],
                        }
                    )
                    for op in work.ops
                ],
                "qubits": coupling.num_qubits,
            }
        )
        final_layout = list(initial_layout)
        passes.append("apply-layout")

    if target.basis == "ion":
        work = _to_ion_two_qubit(work)
        passes.append("basis:2q->rzz")

    emitter = ONE_QUBIT_EMITTERS[target.basis]
    if target.optimise and target.optimisation_level >= 1:
        work = cancel_adjacent_inverses(work)
        passes.append("cancel-inverses")
    basis_gates = BASIS_SETS[target.basis]
    if target.basis != "none" or target.optimisation_level >= 2:
        work = merge_single_qubit_runs(work, emitter, basis_gates)
        passes.append(f"merge-1q:{target.basis}")
    work = drop_trivial_rotations(work)
    passes.append("drop-trivial")
    if target.optimise and target.optimisation_level >= 3:
        work = cancel_adjacent_inverses(work)
        work = merge_single_qubit_runs(work, emitter, basis_gates)
        work = drop_trivial_rotations(work)
        passes.append("resweep")

    work = work.model_copy(update={"name": f"{circuit.name}-transpiled"})
    return TranspileResult(
        circuit=work,
        before=before,
        after=metrics(work),
        initial_layout=initial_layout[: circuit.qubits],
        final_layout=final_layout[: circuit.qubits],
        swaps_added=swaps,
        passes=passes,
        basis=BASIS_SETS[target.basis],
    )


def _to_ion_two_qubit(circuit: Circuit) -> Circuit:
    """Replace every CNOT with ``h . (rzz + rz + rz) . h``.

    ``CZ == e^{-i pi/4} (Rz(pi/2) tensor Rz(pi/2)) Rzz(-pi/2)`` exactly, and
    ``CX == H_t CZ H_t``; the surviving Hadamards and Rz gates are folded into
    the single-qubit runs by the merge pass that follows.
    """
    half = math.pi / 2.0
    ops: list[Op] = []
    for op in circuit.ops:
        if op.gate != "cx":
            ops.append(op)
            continue
        c, t = op.targets
        ops.extend(
            [
                _op("h", [t]),
                _op("rzz", [c, t], [-half]),
                _op("rz", [c], [half]),
                _op("rz", [t], [half]),
                _op("h", [t]),
            ]
        )
    return circuit.model_copy(update={"ops": ops})


__all__ = [
    "ANGLE_EPS",
    "BASIS_SETS",
    "CouplingMap",
    "LAYOUTS",
    "ONE_QUBIT_EMITTERS",
    "RoutingResult",
    "TranspileResult",
    "TranspileTarget",
    "cancel_adjacent_inverses",
    "controlled_u_ops",
    "decompose",
    "drop_trivial_rotations",
    "emit_ibm",
    "emit_ion",
    "emit_u",
    "emit_zyz",
    "greedy_layout",
    "interaction_weights",
    "merge_single_qubit_runs",
    "multi_controlled_ops",
    "permutation_operator",
    "sabre_route",
    "toffoli_ops",
    "transpile",
    "trivial_layout",
    "zyz",
]
