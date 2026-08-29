"""The autograder: assertions over a learner's circuit, and why they failed.

A grader that answers "wrong" teaches nothing. Every assertion in this module
returns a :class:`AssertionOutcome` whose ``message`` names the specific
quantity that disagreed and by how much -- *"expected amplitude 0.7071 on |01>,
got 0.0000"* -- because that sentence is the entire pedagogical payload of a
failed submission.

Seven kinds, covering what labs and contests actually assert:

============================ ==================================================
``statevector_equals``       amplitudes match, optionally up to a global phase
``unitary_equals``           the whole 2**n x 2**n operator matches
``distribution_close``       sampled counts match a target distribution
``counts_contains``          named outcomes appear (a weaker, shot-robust check)
``resource_bound``           depth / 2-qubit gates / qubits / T-count ceilings
``gate_set_subset``          only the gates this lesson has taught
``custom_python``            arbitrary learner-visible check, in the sandbox
============================ ==================================================

Statistical assertions are two-sided on purpose. ``distribution_close``
reports **both** total variation distance (a bounded, interpretable "how far
apart are these distributions" a learner can reason about) and a chi-square
goodness-of-fit p-value (which knows how many shots were taken, so 520/480 on
1,000 shots passes and 520/480 on 1,000,000 shots does not). A contest that
graded on TVD alone would let a sloppy circuit pass at low shot counts; one
that graded on p-value alone would fail a *correct* circuit roughly once in
twenty runs. Requiring both is what makes a seeded rerun reproducible and a
marginal submission arguable.

Global phase: physically unobservable, so ``statevector_equals`` and
``unitary_equals`` default to ignoring it. A lesson specifically *about* phase
kickback can set ``up_to_global_phase: false`` and get the strict comparison.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal, Sequence, Union

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from app.backends.base import (
    SimOptions,
    SimResult,
    basis_label,
    probabilities_from_state,
)
from app.backends.native import (
    NativeBackend,
    circuit_unitary,
    equal_up_to_global_phase,
)
from app.gates import GATES
from app.ir import Circuit, IRError, gate_set, metrics, validate_or_raise
from app.sandbox import SandboxLimits, SandboxPolicy, SandboxResult, run_untrusted

#: Default numeric tolerance. Loose enough for a 20-gate circuit's accumulated
#: rounding, tight enough that a wrong angle fails.
DEFAULT_TOLERANCE = 1e-6

#: Default ceiling on total variation distance for a sampled comparison.
DEFAULT_TVD = 0.05

#: Default chi-square significance. A correct circuit fails at this rate by
#: chance, which is why the seed is pinned for contests.
DEFAULT_ALPHA = 0.01

#: How many mismatching amplitudes a failure message lists before it summarises.
MAX_REPORTED_MISMATCHES = 4

#: Unitary assertions materialise 2**n x 2**n; the same ceiling the transpiler's
#: equivalence proofs use.
UNITARY_MAX_QUBITS = 10


class GradeError(ValueError):
    """The assertion itself is malformed -- an author error, not a learner one."""


# --------------------------------------------------------------------------
# Wire types for expected values
# --------------------------------------------------------------------------

#: An expected state, in either of the two spellings labs actually write:
#: a dense interleaved ``[re0, im0, re1, im1, ...]`` array (what the TypeScript
#: engine produces), or a sparse ``{"01": [re, im]}`` map keyed by basis label,
#: which is how a human writes "one over root two on |00> and on |11>".
ExpectedState = Union[list[float], dict[str, list[float]]]


def parse_expected_state(expected: ExpectedState, n: int) -> np.ndarray:
    """Normalise either spelling into a complex vector of length ``2**n``."""
    dim = 1 << n
    if isinstance(expected, dict):
        vec = np.zeros(dim, dtype=np.complex128)
        for label, value in expected.items():
            key = label.strip().strip("|>")
            if len(key) != n or any(ch not in "01" for ch in key):
                raise GradeError(
                    f"basis label {label!r} is not {n} bits of 0/1; remember qubit 0 "
                    f"is the leftmost character"
                )
            idx = int(key, 2)
            re, im = _pair(value, label)
            vec[idx] = complex(re, im)
        return vec
    flat = list(expected)
    if len(flat) == dim:
        # A real-valued state written without imaginary parts.
        return np.array([complex(v, 0.0) for v in flat], dtype=np.complex128)
    if len(flat) != 2 * dim:
        raise GradeError(
            f"expected statevector has {len(flat)} numbers; a {n}-qubit state needs "
            f"{2 * dim} (interleaved re/im) or {dim} (real only)"
        )
    return np.array(
        [complex(flat[2 * i], flat[2 * i + 1]) for i in range(dim)], dtype=np.complex128
    )


def _pair(value: Any, label: str) -> tuple[float, float]:
    if isinstance(value, (int, float)):
        return float(value), 0.0
    if isinstance(value, (list, tuple)) and len(value) == 2:
        return float(value[0]), float(value[1])
    raise GradeError(
        f"amplitude for {label!r} must be a number or a [re, im] pair, got {value!r}"
    )


def parse_expected_matrix(expected: dict[str, Any] | list[list[float]], n: int) -> np.ndarray:
    """Normalise an expected unitary into a complex ``2**n x 2**n`` matrix.

    Accepts the ``{"re": [[...]], "im": [[...]]}`` payload the kernel itself
    emits, so a lab author can round-trip a reference circuit's unitary
    straight out of ``POST /v1/simulate`` and into an assertion.
    """
    dim = 1 << n
    if isinstance(expected, dict):
        re = np.asarray(expected.get("re", []), dtype=np.float64)
        im = np.asarray(expected.get("im", np.zeros_like(re)), dtype=np.float64)
        if re.shape != (dim, dim):
            raise GradeError(
                f"expected unitary is {re.shape}, but a {n}-qubit operator is "
                f"{dim}x{dim}"
            )
        return re + 1j * im
    m = np.asarray(expected, dtype=np.complex128)
    if m.shape != (dim, dim):
        raise GradeError(
            f"expected unitary is {m.shape}, but a {n}-qubit operator is {dim}x{dim}"
        )
    return m


# --------------------------------------------------------------------------
# Assertion models
# --------------------------------------------------------------------------


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: Shown to the learner above the diff. Defaults to a description of the kind.
    name: str = ""
    #: Contribution to the score when it passes.
    points: float = Field(default=1.0, ge=0.0)
    #: A hint revealed only on failure. Contests leave this empty.
    hint: str | None = None


class StatevectorEquals(_Base):
    kind: Literal["statevector_equals"] = "statevector_equals"
    expected: ExpectedState
    tolerance: float = Field(default=DEFAULT_TOLERANCE, gt=0.0)
    up_to_global_phase: bool = True
    #: Bindings for a symbolic circuit, so one assertion can pin an ansatz.
    bindings: dict[str, float] = Field(default_factory=dict)


class UnitaryEquals(_Base):
    kind: Literal["unitary_equals"] = "unitary_equals"
    expected: dict[str, Any] | list[list[float]]
    tolerance: float = Field(default=DEFAULT_TOLERANCE, gt=0.0)
    up_to_global_phase: bool = True
    bindings: dict[str, float] = Field(default_factory=dict)


class DistributionClose(_Base):
    kind: Literal["distribution_close"] = "distribution_close"
    #: Target probabilities keyed by outcome label. Need not sum to 1: the
    #: grader normalises and says so, because "0.5 on 00, 0.5 on 11" is how
    #: people write a Bell state and demanding 1.0000000001 helps nobody.
    expected: dict[str, float]
    shots: int = Field(default=4096, ge=1, le=1_000_000)
    max_tvd: float = Field(default=DEFAULT_TVD, ge=0.0, le=1.0)
    #: Chi-square significance level; ``None`` skips the test entirely.
    alpha: float | None = Field(default=DEFAULT_ALPHA, gt=0.0, lt=1.0)
    seed: int | None = Field(default=None, ge=0)


class CountsContains(_Base):
    kind: Literal["counts_contains"] = "counts_contains"
    #: Outcomes that must appear, each with a minimum share of the shots.
    outcomes: dict[str, float] = Field(default_factory=dict)
    #: Outcomes that must NOT appear above ``max_fraction``.
    forbidden: dict[str, float] = Field(default_factory=dict)
    shots: int = Field(default=4096, ge=1, le=1_000_000)
    seed: int | None = Field(default=None, ge=0)


class ResourceBound(_Base):
    kind: Literal["resource_bound"] = "resource_bound"
    max_depth: int | None = Field(default=None, ge=0)
    max_two_qubit_gates: int | None = Field(default=None, ge=0)
    max_qubits: int | None = Field(default=None, ge=1)
    max_size: int | None = Field(default=None, ge=0)
    max_t_count: int | None = Field(default=None, ge=0)


class GateSetSubset(_Base):
    kind: Literal["gate_set_subset"] = "gate_set_subset"
    allowed: list[str] = Field(min_length=1)
    #: ``barrier`` and ``measure`` are structural, not pedagogical; allowed by
    #: default so a lesson restricted to {h, cx} does not have to list them.
    allow_structural: bool = True


class CustomPython(_Base):
    kind: Literal["custom_python"] = "custom_python"
    #: Source evaluated in the sandbox. It receives ``PROBABILITIES``,
    #: ``STATEVECTOR`` (interleaved), ``COUNTS``, ``METRICS`` and ``GATES``, and
    #: must set ``PASSED`` to a bool and may set ``MESSAGE`` to a string.
    source: str
    shots: int = Field(default=0, ge=0, le=1_000_000)
    seed: int | None = Field(default=None, ge=0)
    cpu_seconds: int = Field(default=2, ge=1, le=10)


Assertion = Annotated[
    Union[
        StatevectorEquals,
        UnitaryEquals,
        DistributionClose,
        CountsContains,
        ResourceBound,
        GateSetSubset,
        CustomPython,
    ],
    Field(discriminator="kind"),
]

_DEFAULT_NAMES: dict[str, str] = {
    "statevector_equals": "final statevector",
    "unitary_equals": "circuit unitary",
    "distribution_close": "measurement distribution",
    "counts_contains": "required outcomes",
    "resource_bound": "resource budget",
    "gate_set_subset": "permitted gates",
    "custom_python": "custom check",
}


# --------------------------------------------------------------------------
# Results
# --------------------------------------------------------------------------


@dataclass
class AssertionOutcome:
    kind: str
    name: str
    passed: bool
    #: One human sentence. On failure this is the diff the learner reads.
    message: str
    points: float
    earned: float
    #: Machine-readable specifics: distances, offending indices, actual metrics.
    detail: dict[str, Any] = field(default_factory=dict)
    hint: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "kind": self.kind,
            "name": self.name,
            "passed": self.passed,
            "message": self.message,
            "points": self.points,
            "earned": self.earned,
            "detail": self.detail,
        }
        if self.hint and not self.passed:
            out["hint"] = self.hint
        return out


@dataclass
class GradeReport:
    passed: bool
    score: float
    max_score: float
    outcomes: list[AssertionOutcome]
    metrics: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    @property
    def fraction(self) -> float:
        return self.score / self.max_score if self.max_score else 1.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "score": self.score,
            "maxScore": self.max_score,
            "fraction": self.fraction,
            "assertions": [o.to_dict() for o in self.outcomes],
            "metrics": self.metrics,
            "warnings": self.warnings,
        }


# --------------------------------------------------------------------------
# Formatting helpers -- the part that does the teaching
# --------------------------------------------------------------------------


def format_amplitude(z: complex) -> str:
    """Render an amplitude the way a lesson writes one."""
    re, im = float(z.real), float(z.imag)
    if abs(im) < 1e-12:
        return f"{re:.4f}"
    if abs(re) < 1e-12:
        return f"{im:+.4f}i"
    return f"{re:.4f}{im:+.4f}i"


def _ket(index: int, n: int) -> str:
    return f"|{basis_label(index, n)}>"


def describe_state_mismatch(
    actual: np.ndarray, expected: np.ndarray, n: int, tolerance: float
) -> tuple[bool, str, dict[str, Any]]:
    """Compare two amplitude vectors and describe the first few disagreements."""
    diff = np.abs(actual - expected)
    bad = [int(i) for i in np.nonzero(diff > tolerance)[0]]
    if not bad:
        return True, f"all {actual.size} amplitudes match to {tolerance:g}", {}
    shown = bad[:MAX_REPORTED_MISMATCHES]
    parts = [
        f"expected amplitude {format_amplitude(complex(expected[i]))} on {_ket(i, n)}, "
        f"got {format_amplitude(complex(actual[i]))}"
        for i in shown
    ]
    extra = len(bad) - len(shown)
    if extra > 0:
        parts.append(f"and {extra} more amplitude(s) differ")
    return (
        False,
        "; ".join(parts),
        {
            "mismatches": len(bad),
            "maxAbsoluteError": float(diff.max()),
            "worstIndex": int(np.argmax(diff)),
            "worstLabel": basis_label(int(np.argmax(diff)), n),
        },
    )


def total_variation_distance(p: dict[str, float], q: dict[str, float]) -> float:
    """``0.5 * sum |p - q|`` over the union of the two supports.

    Bounded in [0, 1] and directly interpretable: 0.05 means "at most 5% of the
    probability mass would have to move", which is a sentence a learner can act
    on in a way that a p-value is not.
    """
    keys = set(p) | set(q)
    return 0.5 * sum(abs(p.get(k, 0.0) - q.get(k, 0.0)) for k in keys)


def chi_square_pvalue(
    observed: dict[str, int], expected_p: dict[str, float], shots: int
) -> tuple[float, float, int]:
    """Pearson chi-square goodness of fit. Returns ``(statistic, p, dof)``.

    Categories whose expected count is below five are pooled into one "other"
    bucket, the standard remedy: the chi-square approximation to the
    multinomial breaks down on rare categories, and a 3-qubit circuit with one
    outcome at p=0.001 has plenty of those.

    ``scipy`` supplies the survival function when it is installed; the fallback
    is a series expansion of the regularised upper incomplete gamma, because
    refusing to grade a submission over an optional dependency is not
    acceptable.
    """
    keys = sorted(set(observed) | set(expected_p))
    cells: list[tuple[float, float]] = []
    pooled_obs = 0.0
    pooled_exp = 0.0
    for k in keys:
        e = expected_p.get(k, 0.0) * shots
        o = float(observed.get(k, 0))
        if e < 5.0:
            pooled_obs += o
            pooled_exp += e
        else:
            cells.append((o, e))
    if pooled_exp > 0.0 or pooled_obs > 0.0:
        cells.append((pooled_obs, max(pooled_exp, 1e-12)))
    if len(cells) < 2:
        return 0.0, 1.0, 0
    stat = sum((o - e) ** 2 / e for o, e in cells)
    dof = len(cells) - 1
    return float(stat), _chi2_sf(float(stat), dof), dof


def _chi2_sf(stat: float, dof: int) -> float:
    """Upper tail of the chi-square distribution."""
    if dof <= 0:
        return 1.0
    try:
        from scipy.stats import chi2  # type: ignore[import-untyped]

        return float(chi2.sf(stat, dof))
    except Exception:  # pragma: no cover - only when SciPy is absent
        return _gammaincc(dof / 2.0, stat / 2.0)


def _gammaincc(a: float, x: float) -> float:
    """Regularised upper incomplete gamma ``Q(a, x)``, Numerical Recipes 6.2.

    Series below the crossover, continued fraction above it; both converge
    geometrically in the region where they are used.
    """
    if x < 0.0 or a <= 0.0:
        return 1.0
    if x == 0.0:
        return 1.0
    if x < a + 1.0:
        # Series for P(a, x), then Q = 1 - P.
        ap = a
        total = 1.0 / a
        term = total
        for _ in range(1000):
            ap += 1.0
            term *= x / ap
            total += term
            if abs(term) < abs(total) * 1e-15:
                break
        return 1.0 - total * math.exp(-x + a * math.log(x) - math.lgamma(a))
    # Lentz's continued fraction for Q(a, x).
    tiny = 1e-300
    b = x + 1.0 - a
    c = 1.0 / tiny
    d = 1.0 / b
    h = d
    for i in range(1, 1000):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < tiny:
            d = tiny
        c = b + an / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-15:
            break
    return h * math.exp(-x + a * math.log(x) - math.lgamma(a))


# --------------------------------------------------------------------------
# The evaluation context
# --------------------------------------------------------------------------


@dataclass
class GradeContext:
    """One evolution of the circuit, shared by every assertion in a submission.

    Built lazily: a submission whose assertions are all ``resource_bound`` never
    simulates anything, and one with three statevector assertions simulates once.
    """

    circuit: Circuit
    backend: Any = None
    bindings: dict[str, float] = field(default_factory=dict)
    _state: np.ndarray | None = None
    _unitary: np.ndarray | None = None
    _counts: dict[tuple[int, int | None], dict[str, int]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.backend is None:
            self.backend = NativeBackend()

    def state(self, bindings: dict[str, float] | None = None) -> np.ndarray:
        """The final statevector, measurements deferred."""
        if bindings:
            return self._simulate(bindings).statevector  # type: ignore[return-value]
        if self._state is None:
            result = self._simulate(self.bindings)
            if result.statevector is None:
                raise GradeError(
                    "this backend returned no statevector; a statevector assertion "
                    "needs an exact engine"
                )
            self._state = result.statevector
        return self._state

    def _simulate(self, bindings: dict[str, float]) -> SimResult:
        return self.backend.run(
            self.circuit,
            SimOptions(
                shots=0,
                bindings=dict(bindings),
                return_statevector=True,
                return_bloch=False,
                max_qubits=32,
            ),
        )

    def unitary(self, bindings: dict[str, float] | None = None) -> np.ndarray:
        if bindings:
            return circuit_unitary(self.circuit, bindings, UNITARY_MAX_QUBITS)
        if self._unitary is None:
            self._unitary = circuit_unitary(
                self.circuit, self.bindings, UNITARY_MAX_QUBITS
            )
        return self._unitary

    def counts(self, shots: int, seed: int | None) -> dict[str, int]:
        """Sampled counts, memoised per ``(shots, seed)`` so two distribution
        assertions over the same run do not resample and disagree."""
        key = (shots, seed)
        if key not in self._counts:
            result = self.backend.run(
                self.circuit,
                SimOptions(
                    shots=shots,
                    seed=seed,
                    bindings=dict(self.bindings),
                    return_statevector=False,
                    return_bloch=False,
                    max_qubits=32,
                ),
            )
            self._counts[key] = result.counts or {}
        return self._counts[key]


# --------------------------------------------------------------------------
# The assertion implementations
# --------------------------------------------------------------------------


def _check_statevector(a: StatevectorEquals, ctx: GradeContext) -> AssertionOutcome:
    n = ctx.circuit.qubits
    expected = parse_expected_state(a.expected, n)
    actual = ctx.state(a.bindings)

    if a.up_to_global_phase:
        aligned = _align_phase(actual, expected)
        ok, message, detail = describe_state_mismatch(aligned, expected, n, a.tolerance)
        if not ok:
            # Say whether phase alone was the problem: it is the single most
            # common near-miss and the one most worth naming.
            strict_ok, _, _ = describe_state_mismatch(actual, expected, n, a.tolerance)
            detail["globalPhaseIgnored"] = True
            if strict_ok:  # pragma: no cover - alignment makes this unreachable
                ok, message = True, "matches up to a global phase"
    else:
        ok, message, detail = describe_state_mismatch(actual, expected, n, a.tolerance)
        if not ok and equal_up_to_global_phase(actual, expected, a.tolerance):
            message = (
                "the amplitudes match up to a global phase, but this assertion "
                "requires the exact phase: " + message
            )
            detail["globalPhaseOnly"] = True
    detail["tolerance"] = a.tolerance
    return _outcome(a, ok, message, detail)


def _align_phase(actual: np.ndarray, expected: np.ndarray) -> np.ndarray:
    """Rotate ``actual`` onto ``expected``'s phase convention.

    Anchored on ``expected``'s largest-magnitude entry rather than its first
    non-zero one: dividing by a near-zero amplitude turns 1e-17 of rounding
    into a wild phase and a nonsense diff.
    """
    k = int(np.argmax(np.abs(expected)))
    if abs(expected[k]) < 1e-12 or abs(actual[k]) < 1e-12:
        return actual
    phase = expected[k] / actual[k]
    mag = abs(phase)
    if mag < 1e-12:
        return actual
    return actual * (phase / mag)


def _check_unitary(a: UnitaryEquals, ctx: GradeContext) -> AssertionOutcome:
    n = ctx.circuit.qubits
    if n > UNITARY_MAX_QUBITS:
        raise GradeError(
            f"unitary_equals is limited to {UNITARY_MAX_QUBITS} qubits, got {n}; "
            f"assert on the statevector or the distribution instead"
        )
    expected = parse_expected_matrix(a.expected, n)
    actual = ctx.unitary(a.bindings)

    if a.up_to_global_phase:
        ok = equal_up_to_global_phase(actual, expected, a.tolerance)
        compare = _align_phase(actual.ravel(), expected.ravel()).reshape(actual.shape)
    else:
        ok = bool(np.allclose(actual, expected, atol=a.tolerance))
        compare = actual

    diff = np.abs(compare - expected)
    detail: dict[str, Any] = {
        "maxAbsoluteError": float(diff.max()),
        "tolerance": a.tolerance,
        "upToGlobalPhase": a.up_to_global_phase,
    }
    if ok:
        return _outcome(
            a, True, f"the {1 << n}x{1 << n} unitary matches to {a.tolerance:g}", detail
        )
    i, j = np.unravel_index(int(np.argmax(diff)), diff.shape)
    detail["worstEntry"] = [int(i), int(j)]
    message = (
        f"expected {format_amplitude(complex(expected[i, j]))} at row {_ket(int(i), n)}, "
        f"column {_ket(int(j), n)}, got {format_amplitude(complex(compare[i, j]))} "
        f"({int((diff > a.tolerance).sum())} of {diff.size} entries differ)"
    )
    if not a.up_to_global_phase and equal_up_to_global_phase(actual, expected, a.tolerance):
        message = "the operator matches up to a global phase, but not exactly: " + message
        detail["globalPhaseOnly"] = True
    return _outcome(a, False, message, detail)


def _normalise(dist: dict[str, float]) -> tuple[dict[str, float], bool]:
    total = sum(dist.values())
    if total <= 0:
        raise GradeError("expected distribution sums to zero")
    if abs(total - 1.0) < 1e-9:
        return dict(dist), False
    return {k: v / total for k, v in dist.items()}, True


def _check_distribution(a: DistributionClose, ctx: GradeContext) -> AssertionOutcome:
    expected, renormalised = _normalise(a.expected)
    counts = ctx.counts(a.shots, a.seed)
    total = sum(counts.values()) or 1
    observed = {k: v / total for k, v in counts.items()}

    tvd = total_variation_distance(observed, expected)
    stat, p, dof = chi_square_pvalue(counts, expected, total)

    detail: dict[str, Any] = {
        "tvd": tvd,
        "maxTvd": a.max_tvd,
        "chiSquare": stat,
        "pValue": p,
        "degreesOfFreedom": dof,
        "shots": total,
        "observed": dict(sorted(counts.items())),
        "renormalisedExpected": renormalised,
    }

    tvd_ok = tvd <= a.max_tvd
    chi_ok = a.alpha is None or p >= a.alpha
    if tvd_ok and chi_ok:
        return _outcome(
            a,
            True,
            f"distribution matches over {total} shots (total variation distance "
            f"{tvd:.4f} <= {a.max_tvd:g}"
            + (f", chi-square p = {p:.3f})" if a.alpha is not None else ")"),
            detail,
        )

    # `sorted` before `max` is not cosmetic: on a tie `max` returns the first
    # maximal element in iteration order, and set iteration order depends on
    # PYTHONHASHSEED. Without it, a two-outcome distribution that is equally
    # wrong on both could name a different outcome on a rerun of the same
    # seeded contest submission.
    worst = max(
        sorted(set(observed) | set(expected)),
        key=lambda k: abs(observed.get(k, 0.0) - expected.get(k, 0.0)),
    )
    parts = [
        f"expected P({worst}) = {expected.get(worst, 0.0):.4f}, "
        f"got {observed.get(worst, 0.0):.4f} "
        f"({counts.get(worst, 0)} of {total} shots)"
    ]
    if not tvd_ok:
        parts.append(f"total variation distance {tvd:.4f} exceeds {a.max_tvd:g}")
    if not chi_ok:
        parts.append(
            f"chi-square p = {p:.4g} below alpha = {a.alpha:g}, so the difference is "
            f"larger than sampling noise explains"
        )
    return _outcome(a, False, "; ".join(parts), detail)


def _check_counts_contains(a: CountsContains, ctx: GradeContext) -> AssertionOutcome:
    counts = ctx.counts(a.shots, a.seed)
    total = sum(counts.values()) or 1
    problems: list[str] = []
    for label, min_fraction in a.outcomes.items():
        got = counts.get(label, 0)
        share = got / total
        if share < min_fraction:
            problems.append(
                f"expected outcome {label} in at least {min_fraction:.1%} of shots, "
                f"got {got} of {total} ({share:.1%})"
            )
    for label, max_fraction in a.forbidden.items():
        got = counts.get(label, 0)
        share = got / total
        if share > max_fraction:
            problems.append(
                f"outcome {label} should appear in at most {max_fraction:.1%} of "
                f"shots, got {got} of {total} ({share:.1%})"
            )
    detail = {"shots": total, "observed": dict(sorted(counts.items()))}
    if problems:
        return _outcome(a, False, "; ".join(problems), detail)
    names = ", ".join(sorted(a.outcomes)) or "(none required)"
    return _outcome(a, True, f"every required outcome appeared: {names}", detail)


def _check_resource_bound(a: ResourceBound, ctx: GradeContext) -> AssertionOutcome:
    m = metrics(ctx.circuit)
    checks = (
        ("depth", m.depth, a.max_depth, "depth"),
        ("twoQubitGates", m.two_qubit_gates, a.max_two_qubit_gates, "two-qubit gates"),
        ("qubits", m.qubits, a.max_qubits, "qubits"),
        ("size", m.size, a.max_size, "gates"),
        ("tCount", m.t_count, a.max_t_count, "T gates"),
    )
    problems: list[str] = []
    satisfied: list[str] = []
    detail: dict[str, Any] = {"actual": m.to_dict()}
    for key, actual, limit, noun in checks:
        if limit is None:
            continue
        detail.setdefault("limits", {})[key] = limit
        if actual > limit:
            problems.append(
                f"expected at most {limit} {noun}, got {actual} "
                f"({actual - limit} over budget)"
            )
        else:
            satisfied.append(f"{actual}/{limit} {noun}")
    if not satisfied and not problems:
        raise GradeError("resource_bound assertion sets no limits")
    if problems:
        return _outcome(a, False, "; ".join(problems), detail)
    return _outcome(a, True, "within budget: " + ", ".join(satisfied), detail)


_STRUCTURAL = frozenset({"barrier", "measure", "reset", "id"})


def _check_gate_set(a: GateSetSubset, ctx: GradeContext) -> AssertionOutcome:
    allowed = set(a.allowed)
    unknown = sorted(g for g in allowed if g not in GATES)
    if unknown:
        raise GradeError(
            f"gate_set_subset names gate(s) that do not exist: {', '.join(unknown)}"
        )
    if a.allow_structural:
        allowed |= _STRUCTURAL
    used = gate_set(ctx.circuit)
    extra = sorted(used - allowed)
    detail = {"used": sorted(used), "allowed": sorted(allowed), "disallowed": extra}
    if extra:
        return _outcome(
            a,
            False,
            f"this exercise allows only {{{', '.join(sorted(a.allowed))}}}, but the "
            f"circuit uses {', '.join(extra)}",
            detail,
        )
    return _outcome(
        a, True, f"uses only permitted gates: {', '.join(sorted(used)) or '(none)'}", detail
    )


#: Prelude injected before a ``custom_python`` assertion. Everything the check
#: can see about the submission arrives as plain data, so the assertion runs
#: under the same import allowlist as learner code and cannot reach the kernel.
_CUSTOM_PRELUDE = """PASSED = False
MESSAGE = ''
"""

_CUSTOM_EPILOGUE = """
RESULT = {'passed': bool(PASSED), 'message': str(MESSAGE)}
"""


def _check_custom_python(a: CustomPython, ctx: GradeContext) -> AssertionOutcome:
    n = ctx.circuit.qubits
    state = ctx.state()
    probs = probabilities_from_state(state)
    counts = ctx.counts(a.shots, a.seed) if a.shots else {}
    payload = {
        "N": n,
        "PROBABILITIES": [float(p) for p in probs],
        "STATEVECTOR": [
            float(v) for pair in zip(state.real, state.imag) for v in pair
        ],
        "LABELS": [basis_label(i, n) for i in range(state.size)],
        "COUNTS": counts,
        "METRICS": metrics(ctx.circuit).to_dict(),
        "GATES": sorted(gate_set(ctx.circuit)),
    }
    header = "\n".join(f"{k} = {v!r}" for k, v in payload.items())
    source = header + "\n" + _CUSTOM_PRELUDE + a.source + _CUSTOM_EPILOGUE

    sandbox_result: SandboxResult = run_untrusted(
        source,
        limits=SandboxLimits(cpu_seconds=a.cpu_seconds),
        policy=SandboxPolicy(),
        capture=("RESULT",),
        seed=a.seed or 0,
    )
    detail: dict[str, Any] = {
        "sandboxStatus": sandbox_result.status,
        "stdout": sandbox_result.stdout,
        "cpuSeconds": sandbox_result.cpu_seconds,
    }
    if not sandbox_result.ok:
        detail["sandboxError"] = sandbox_result.error
        return _outcome(
            a,
            False,
            f"the check did not run ({sandbox_result.status}): {sandbox_result.error}",
            detail,
        )
    raw = sandbox_result.captured.get("RESULT")
    if not isinstance(raw, dict) or "passed" not in raw:
        return _outcome(
            a,
            False,
            "the check did not set PASSED to a boolean",
            detail,
        )
    passed = bool(raw["passed"])
    message = str(raw.get("message") or "").strip()
    if not message:
        message = "custom check passed" if passed else "custom check failed"
    return _outcome(a, passed, message, detail)


_CHECKS: dict[str, Any] = {
    "statevector_equals": _check_statevector,
    "unitary_equals": _check_unitary,
    "distribution_close": _check_distribution,
    "counts_contains": _check_counts_contains,
    "resource_bound": _check_resource_bound,
    "gate_set_subset": _check_gate_set,
    "custom_python": _check_custom_python,
}


def _outcome(
    a: Any, passed: bool, message: str, detail: dict[str, Any]
) -> AssertionOutcome:
    return AssertionOutcome(
        kind=a.kind,
        name=a.name or _DEFAULT_NAMES.get(a.kind, a.kind),
        passed=passed,
        message=message,
        points=float(a.points),
        earned=float(a.points) if passed else 0.0,
        detail=detail,
        hint=a.hint,
    )


# --------------------------------------------------------------------------
# The driver
# --------------------------------------------------------------------------


def check(assertion: Any, ctx: GradeContext) -> AssertionOutcome:
    """Run one assertion. Author errors surface as a failed outcome, not a 500.

    A malformed assertion is a content bug, and a content bug must not take the
    grading endpoint down mid-contest -- it must produce a failure that names
    the assertion and says the lab is broken, so the learner is not left
    staring at a spinner.
    """
    fn = _CHECKS.get(assertion.kind)
    if fn is None:  # pragma: no cover - the union makes this unreachable
        raise GradeError(f"unknown assertion kind {assertion.kind!r}")
    try:
        return fn(assertion, ctx)
    except GradeError as exc:
        return _outcome(assertion, False, f"this assertion is misconfigured: {exc}", {})
    except IRError as exc:
        return _outcome(assertion, False, f"the circuit is not valid: {exc}", {})
    except Exception as exc:  # noqa: BLE001
        return _outcome(
            assertion,
            False,
            f"the assertion could not be evaluated: {type(exc).__name__}: {exc}",
            {},
        )


def grade(
    circuit: Circuit,
    assertions: Sequence[Any],
    *,
    bindings: dict[str, float] | None = None,
    backend: Any = None,
) -> GradeReport:
    """Evaluate every assertion against one circuit and total the score.

    Every assertion runs even after one fails: a learner deserves the full list
    of what is wrong, not just the first thing.
    """
    warnings: list[str] = []
    try:
        validate_or_raise(circuit)
    except IRError as exc:
        return GradeReport(
            passed=False,
            score=0.0,
            max_score=float(sum(a.points for a in assertions)),
            outcomes=[
                AssertionOutcome(
                    kind="circuit",
                    name="circuit validity",
                    passed=False,
                    message=f"the circuit is not valid: {exc}",
                    points=0.0,
                    earned=0.0,
                    detail={"opId": exc.op_id},
                )
            ],
            metrics=metrics(circuit).to_dict(),
            warnings=warnings,
        )

    ctx = GradeContext(circuit=circuit, backend=backend, bindings=dict(bindings or {}))
    outcomes = [check(a, ctx) for a in assertions]
    score = sum(o.earned for o in outcomes)
    max_score = sum(o.points for o in outcomes)
    return GradeReport(
        passed=all(o.passed for o in outcomes),
        score=float(score),
        max_score=float(max_score),
        outcomes=outcomes,
        metrics=metrics(circuit).to_dict(),
        warnings=warnings,
    )


__all__ = [
    "DEFAULT_ALPHA",
    "DEFAULT_TOLERANCE",
    "DEFAULT_TVD",
    "MAX_REPORTED_MISMATCHES",
    "UNITARY_MAX_QUBITS",
    "Assertion",
    "AssertionOutcome",
    "CountsContains",
    "CustomPython",
    "DistributionClose",
    "GateSetSubset",
    "GradeContext",
    "GradeError",
    "GradeReport",
    "ResourceBound",
    "StatevectorEquals",
    "UnitaryEquals",
    "check",
    "chi_square_pvalue",
    "describe_state_mismatch",
    "format_amplitude",
    "grade",
    "parse_expected_matrix",
    "parse_expected_state",
    "total_variation_distance",
]
