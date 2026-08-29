"""The FastAPI surface of ``quantum-kernel``.

Scope, from section 3 of the system design: this service owns simulation,
transpilation, noise, metrics and visual payloads. It **never** does auth,
entitlements or billing -- ``api-gateway`` has already done all three by the
time a request arrives, and it forwards the outcome in headers. That is why
``X-RedQuant-Plan`` is *trusted* here: the kernel is not reachable from the
internet, it sits behind the gateway on the cluster network, and a service that
re-derives entitlements from a token it cannot validate would be duplicating a
decision it is not authoritative for. The plan header decides only how large a
simulation may be, and the cap is applied on top of each backend's own ceiling,
so a forged header can at worst buy a 32-qubit request that the memory guard
then refuses anyway.

Endpoints
---------

======================================= ======================================
``POST /v1/simulate``                   synchronous, tier T-B, 900 ms budget
``POST /v1/simulate/async`` + ``/jobs`` tier T-C: heavy, noisy, density matrix
``POST /v1/transpile``                  decompose, layout, route, translate
``POST /v1/grade``                      run assertions against a circuit
``POST /v1/execute``                    run untrusted learner Python
``POST /v1/convert``                    IR <-> QASM3 / Qiskit / Cirq / PennyLane
``GET  /v1/backends``                   which engines this pod actually has
``GET  /healthz`` / ``/readyz``         liveness / readiness
``GET  /metrics``                       Prometheus exposition
======================================= ======================================

Everything shares one convention, stated here because it is the single fact an
API consumer most needs: **qubit 0 is the most significant bit of a basis
index**. ``probabilities[i]`` gives qubit ``q`` the value ``(i >> (n-1-q)) & 1``,
and a ``counts`` key with ``countsKind == "basis"`` reads left to right from
qubit 0. Classical-register keys (``countsKind == "clbits"``) put clbit 0 on the
*right*, because every SDK prints them that way and fighting that would confuse
more people than it helped.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Iterable, Literal

import numpy as np
import structlog
from fastapi import FastAPI, Header, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)
from pydantic import BaseModel, ConfigDict, Field

from app import backends as backend_registry
from app.backends.base import (
    AdmissionError,
    BackendUnavailable,
    SimOptions,
    SimResult,
)
from app.backends.native import circuit_unitary
from app.codegen import DIALECTS, from_qasm3, to_source
from app.grader import Assertion, grade
from app.ir import (
    Circuit,
    IRError,
    canonical_string,
    circuit_hash,
    metrics as circuit_metrics,
    validate,
)
from app.noise import DEVICE_NAMES, NoiseModel, device_model
from app.sandbox import SandboxLimits, SandboxPolicy, run_and_extract_circuit, run_untrusted
from app.transpile import TranspileTarget, transpile
from app.visual import VisualError, build_visual

SERVICE = "quantum-kernel"
VERSION = "1.0.0"
API_PREFIX = "/v1"

#: Request bodies above this are refused with 413 before parsing. A 30-qubit
#: circuit's IR is a few hundred kilobytes at worst; a megabyte is generous and
#: still small enough that a hostile client cannot make the pod allocate.
MAX_REQUEST_BYTES = int(os.environ.get("KERNEL_MAX_REQUEST_BYTES", 1 * 1024 * 1024))

#: Entries in the in-process result cache. Section 4 puts a Redis LRU behind
#: this one; the in-process tier absorbs the thundering herd of one lesson's
#: worth of learners running the identical circuit within the same second.
CACHE_CAPACITY = int(os.environ.get("KERNEL_CACHE_CAPACITY", 512))

#: Workers for the async (T-C) queue. One pod, a handful of heavy jobs.
JOB_WORKERS = int(os.environ.get("KERNEL_JOB_WORKERS", 2))

#: Finished jobs are dropped after this many seconds.
JOB_TTL_SECONDS = float(os.environ.get("KERNEL_JOB_TTL_SECONDS", 900.0))

#: Synchronous budget from section 4. Exceeding it is logged, not refused: a
#: request that is already computed should be returned, not thrown away.
SYNC_BUDGET_MS = 900.0


# --------------------------------------------------------------------------
# Plans (section 7)
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Plan:
    """Per-tier ceilings. The gateway decides *which* plan; we enforce its size."""

    name: str
    max_qubits: int
    #: 0 means noisy simulation is not entitled at all.
    max_noisy_qubits: int
    max_shots: int
    #: Whether this tier may enqueue tier T-C work.
    async_jobs: bool


PLANS: dict[str, Plan] = {
    "free": Plan("free", max_qubits=16, max_noisy_qubits=0, max_shots=8_192, async_jobs=False),
    "pro": Plan("pro", max_qubits=28, max_noisy_qubits=12, max_shots=100_000, async_jobs=True),
    "teams": Plan("teams", max_qubits=30, max_noisy_qubits=14, max_shots=1_000_000, async_jobs=True),
    "campus": Plan("campus", max_qubits=32, max_noisy_qubits=14, max_shots=1_000_000, async_jobs=True),
    #: Internal callers (the grader worker, contest replay) are not a customer
    #: tier; they get the engine's own ceiling and nothing more.
    "internal": Plan("internal", max_qubits=32, max_noisy_qubits=14, max_shots=1_000_000, async_jobs=True),
}

DEFAULT_PLAN = "free"


def resolve_plan(header: str | None) -> Plan:
    return PLANS.get((header or DEFAULT_PLAN).strip().lower(), PLANS[DEFAULT_PLAN])


class PlanDenied(Exception):
    """The request is larger than the caller's tier allows."""

    def __init__(self, message: str, plan: Plan) -> None:
        super().__init__(message)
        self.plan = plan


def enforce_plan(plan: Plan, circuit: Circuit, options: SimOptions) -> SimOptions:
    """Clamp a request to its tier, refusing rather than silently shrinking.

    Silently reducing shots or qubits would make a contest submission grade
    differently for a free user and a pro user with the same circuit, which is
    the kind of bug nobody ever finds. Refuse, name the tier, name the limit.
    """
    noisy = options.noise is not None and options.noise.active
    if circuit.qubits > plan.max_qubits:
        raise PlanDenied(
            f"the {plan.name} plan allows {plan.max_qubits} qubits; this circuit "
            f"needs {circuit.qubits}",
            plan,
        )
    if noisy and plan.max_noisy_qubits <= 0:
        raise PlanDenied(
            f"noisy simulation is not included in the {plan.name} plan", plan
        )
    if noisy and circuit.qubits > plan.max_noisy_qubits:
        raise PlanDenied(
            f"the {plan.name} plan allows noisy simulation up to "
            f"{plan.max_noisy_qubits} qubits; this circuit needs {circuit.qubits}",
            plan,
        )
    if options.shots > plan.max_shots:
        raise PlanDenied(
            f"the {plan.name} plan allows {plan.max_shots} shots; {options.shots} "
            f"were requested",
            plan,
        )
    return options.model_copy(update={"max_qubits": min(options.max_qubits, plan.max_qubits)})


# --------------------------------------------------------------------------
# Structured logging (section 11)
# --------------------------------------------------------------------------

_REQUEST_ID: threading.local = threading.local()


def current_request_id() -> str:
    return getattr(_REQUEST_ID, "value", "-")


def _add_request_id(_logger: Any, _name: str, event: dict[str, Any]) -> dict[str, Any]:
    event.setdefault("request_id", current_request_id())
    event.setdefault("service", SERVICE)
    return event


def configure_logging() -> None:
    """JSON to stdout, one object per line, ``request_id`` on every line.

    Loki ingests these directly; section 11 forbids PII in logs, which is easy
    to honour here because the kernel never sees a user -- only circuits.
    """
    logging.basicConfig(
        format="%(message)s", stream=sys.stdout, level=logging.INFO, force=True
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            _add_request_id,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )


log = structlog.get_logger(SERVICE)


# --------------------------------------------------------------------------
# Metrics (section 11)
# --------------------------------------------------------------------------

REQUESTS = Counter(
    "kernel_requests_total", "Requests served", ["endpoint", "method", "status"]
)
LATENCY = Histogram(
    "kernel_request_duration_seconds",
    "Request latency",
    ["endpoint"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.9, 2.0, 5.0, 30.0, 60.0),
)
SIM_QUBITS = Histogram(
    "kernel_sim_qubits",
    "Qubit count of simulated circuits",
    buckets=(1, 4, 8, 12, 14, 16, 20, 24, 28, 30, 32),
)
CACHE_HITS = Counter("kernel_sim_cache_hits_total", "In-process cache hits")
CACHE_MISSES = Counter("kernel_sim_cache_misses_total", "In-process cache misses")
CACHE_RATIO = Gauge(
    "sim_cache_hit_ratio", "In-process simulation cache hit ratio since start"
)
QUEUE_DEPTH = Gauge("sim_queue_depth", "Async simulation jobs queued or running")
SANDBOX_RUNS = Counter(
    "kernel_sandbox_runs_total", "Sandboxed executions", ["status"]
)
PLAN_DENIALS = Counter(
    "entitlement_denial_rate", "Requests refused by a plan ceiling", ["plan"]
)


# --------------------------------------------------------------------------
# The result cache (section 4)
# --------------------------------------------------------------------------


def cache_key(
    circuit: Circuit, backend: str, options: SimOptions, extras: str = ""
) -> str:
    """``sha256(canonical_ir || backend || shots || noise || seed)``, per section 4.

    Built from :func:`app.ir.canonical_string`, so two circuits that differ only
    by the order in which independent gates were dragged onto the canvas share
    an entry -- the collision is the point, not a hazard.
    """
    noise = options.noise.model_dump_json() if options.noise else "none"
    bindings = json.dumps(options.bindings, sort_keys=True)
    material = "\x1f".join(
        [
            canonical_string(circuit),
            backend,
            options.method,
            str(options.shots),
            noise,
            str(options.seed),
            bindings,
            json.dumps(options.expectations, sort_keys=True),
            json.dumps(options.reduced_density, sort_keys=True),
            str(options.return_statevector),
            extras,
        ]
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


class ResultCache:
    """A small thread-safe LRU. Values are finished JSON payloads.

    Caching the *payload* rather than the ``SimResult`` is deliberate: the
    serialisation of a 2**24 amplitude array is a real cost, a cache hit should
    skip it too, and a payload dict cannot be mutated into inconsistency by a
    later caller the way a shared NumPy array could.
    """

    def __init__(self, capacity: int = CACHE_CAPACITY) -> None:
        self._data: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._capacity = capacity
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            value = self._data.get(key)
            if value is None:
                self.misses += 1
                CACHE_MISSES.inc()
                self._publish()
                return None
            self._data.move_to_end(key)
            self.hits += 1
            CACHE_HITS.inc()
            self._publish()
            return value

    def put(self, key: str, value: dict[str, Any]) -> None:
        with self._lock:
            self._data[key] = value
            self._data.move_to_end(key)
            while len(self._data) > self._capacity:
                self._data.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()
            self.hits = self.misses = 0
            self._publish()

    def _publish(self) -> None:
        total = self.hits + self.misses
        CACHE_RATIO.set(self.hits / total if total else 0.0)

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


CACHE = ResultCache()


# --------------------------------------------------------------------------
# The async job store (tier T-C)
# --------------------------------------------------------------------------

JobState = Literal["queued", "running", "succeeded", "failed"]


@dataclass
class Job:
    id: str
    state: JobState
    submitted_at: float
    request_id: str
    started_at: float | None = None
    finished_at: float | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    error_kind: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "state": self.state,
            "submittedAt": self.submitted_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "durationMs": (
                (self.finished_at - self.started_at) * 1000.0
                if self.started_at and self.finished_at
                else None
            ),
            "requestId": self.request_id,
            "result": self.result,
            "error": self.error,
            "errorKind": self.error_kind,
        }


class JobStore:
    """In-process job table plus a small thread pool.

    Section 4 puts tier T-C behind a real queue with WebSocket streaming. That
    queue lives in ``api-gateway``/Redis; what the kernel owns is the execution
    slot, and a pod-local pool is the honest implementation of that -- it makes
    the job id meaningful for exactly as long as the pod that accepted it is
    alive, which is why the gateway, not the browser, is the component that
    retries. Jobs do not survive a restart, and ``GET /v1/jobs/{id}`` returns
    404 for an unknown id rather than pretending.
    """

    def __init__(self, workers: int = JOB_WORKERS, ttl: float = JOB_TTL_SECONDS) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._workers = workers
        self._pool: ThreadPoolExecutor | None = None
        self._ttl = ttl

    def _ensure_pool(self) -> ThreadPoolExecutor:
        """Create the pool on first use, and again after a shutdown.

        A ``ThreadPoolExecutor`` cannot be restarted, and this store is a
        module-level singleton that the lifespan shuts down. Building it lazily
        is what lets the app be started more than once in one process -- which
        the test suite does on every test, and which ``uvicorn --reload`` does
        on every save.
        """
        with self._lock:
            if self._pool is None:
                self._pool = ThreadPoolExecutor(
                    max_workers=self._workers, thread_name_prefix="job"
                )
            return self._pool

    def submit(self, fn: Any, request_id: str) -> Job:
        pool = self._ensure_pool()
        job = Job(
            id=uuid.uuid4().hex,
            state="queued",
            submitted_at=time.time(),
            request_id=request_id,
        )
        with self._lock:
            self._jobs[job.id] = job
        QUEUE_DEPTH.inc()
        pool.submit(self._run, job, fn)
        return job

    def _run(self, job: Job, fn: Any) -> None:
        token = getattr(_REQUEST_ID, "value", None)
        _REQUEST_ID.value = job.request_id
        job.state = "running"
        job.started_at = time.time()
        try:
            job.result = fn()
            job.state = "succeeded"
        except Exception as exc:  # noqa: BLE001 -- the job records its own failure
            job.state = "failed"
            job.error = str(exc)
            job.error_kind = type(exc).__name__
            log.warning("job.failed", job_id=job.id, error=str(exc), kind=job.error_kind)
        finally:
            job.finished_at = time.time()
            QUEUE_DEPTH.dec()
            if token is not None:
                _REQUEST_ID.value = token
            self._reap()

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def _reap(self) -> None:
        cutoff = time.time() - self._ttl
        with self._lock:
            stale = [
                jid
                for jid, j in self._jobs.items()
                if j.finished_at is not None and j.finished_at < cutoff
            ]
            for jid in stale:
                del self._jobs[jid]

    def shutdown(self) -> None:
        with self._lock:
            pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)


JOBS = JobStore()


# --------------------------------------------------------------------------
# Wire models
# --------------------------------------------------------------------------


class SimulateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    backend: str = Field(
        default="auto",
        description="native, density, aer, cirq, pennylane, or auto",
    )
    options: SimOptions = Field(default_factory=SimOptions)
    #: Adds the Bloch traces, Q-sphere, heatmap, timeline and entanglement graph.
    include_visual: bool = False


class SimulateResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    result: dict[str, Any]
    circuitHash: str
    cached: bool
    backend: str
    warnings: list[str] = Field(default_factory=list)
    visual: dict[str, Any] | None = None


class TranspileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    target: TranspileTarget = Field(default_factory=TranspileTarget)
    #: Verify the transpiled circuit against the original on the full unitary.
    #: Only meaningful for small circuits; ignored above 10 qubits.
    verify: bool = False


class GradeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    circuit: Circuit
    assertions: list[Assertion] = Field(default_factory=list)
    bindings: dict[str, float] = Field(default_factory=dict)
    backend: str = "native"


class ExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str = Field(max_length=256 * 1024)
    #: Names to lift out of the submission's globals, in addition to ``RESULT``.
    capture: list[str] = Field(default_factory=list)
    #: Pull a Qiskit circuit out of the submission and return it as IR.
    extract_circuit: bool = True
    cpu_seconds: int = Field(default=2, ge=1, le=10)
    seed: int = Field(default=0, ge=0)


class ConvertRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: Exactly one of these two.
    circuit: Circuit | None = None
    qasm: str | None = Field(default=None, max_length=256 * 1024)
    #: Target dialects when converting from IR.
    dialects: list[str] = Field(default_factory=lambda: ["qasm3"])
    bindings: dict[str, float] = Field(default_factory=dict)


# --------------------------------------------------------------------------
# Application
# --------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    infos = backend_registry.infos()
    log.info(
        "startup",
        version=VERSION,
        backends={i.name: i.available for i in infos},
        cache_capacity=CACHE_CAPACITY,
    )
    if os.environ.get("KERNEL_WRITE_OPENAPI", "1") != "0":
        try:
            path = write_openapi(app)
            log.info("openapi.written", path=path)
        except OSError as exc:  # pragma: no cover - read-only root filesystem
            log.warning("openapi.write_failed", error=str(exc))
    try:
        yield
    finally:
        JOBS.shutdown()
        log.info("shutdown")


app = FastAPI(
    title="RedQuant quantum-kernel",
    version=VERSION,
    summary="Statevector, density-matrix and noisy quantum simulation, "
    "transpilation, grading and sandboxed execution.",
    description=__doc__,
    lifespan=lifespan,
    openapi_url=f"{API_PREFIX}/openapi.json",
    docs_url="/docs",
)


@app.middleware("http")
async def request_context(request: Request, call_next: Any) -> Response:
    """Request id, size limit, latency metric and one structured access line."""
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
    _REQUEST_ID.value = request_id
    structlog.contextvars.bind_contextvars(request_id=request_id)
    endpoint = request.scope.get("route").path if request.scope.get("route") else request.url.path

    length = request.headers.get("content-length")
    if length is not None:
        try:
            too_big = int(length) > MAX_REQUEST_BYTES
        except ValueError:
            too_big = False
        if too_big:
            REQUESTS.labels(request.url.path, request.method, "413").inc()
            log.warning("request.too_large", bytes=length, path=request.url.path)
            return JSONResponse(
                status_code=413,
                content={
                    "error": "request_too_large",
                    "message": f"request body exceeds {MAX_REQUEST_BYTES} bytes",
                    "requestId": request_id,
                },
                headers={"x-request-id": request_id},
            )

    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        elapsed = time.perf_counter() - started
        LATENCY.labels(request.url.path).observe(elapsed)
        REQUESTS.labels(request.url.path, request.method, "500").inc()
        log.exception("request.unhandled", path=request.url.path)
        raise
    finally:
        structlog.contextvars.unbind_contextvars("request_id")
    elapsed = time.perf_counter() - started
    path = request.scope.get("route").path if request.scope.get("route") else request.url.path
    LATENCY.labels(path).observe(elapsed)
    REQUESTS.labels(path, request.method, str(response.status_code)).inc()
    response.headers["x-request-id"] = request_id
    if request.url.path not in ("/metrics", "/healthz", "/readyz"):
        log.info(
            "request",
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            duration_ms=round(elapsed * 1000.0, 2),
        )
    return response


def _error(code: int, kind: str, message: str, **extra: Any) -> JSONResponse:
    body: dict[str, Any] = {
        "error": kind,
        "message": message,
        "requestId": current_request_id(),
    }
    body.update(extra)
    return JSONResponse(status_code=code, content=body)


# --------------------------------------------------------------------------
# Simulation
# --------------------------------------------------------------------------


def _validation_errors(circuit: Circuit) -> list[dict[str, Any]]:
    return [i.to_dict() for i in validate(circuit) if i.severity == "error"]


def _run_simulation(
    req: SimulateRequest, plan: Plan
) -> tuple[dict[str, Any], bool, str, list[str]]:
    """Shared by the sync and async paths. Returns ``(payload, cached, backend, warnings)``."""
    circuit = req.circuit
    options = enforce_plan(plan, circuit, req.options)
    noisy = options.noise is not None and options.noise.active

    requested = req.backend
    backend = backend_registry.resolve(requested, noisy=noisy)
    warnings: list[str] = []
    if requested not in ("auto", backend.name):
        warnings.append(
            f"backend {requested!r} is not available on this pod; ran on "
            f"{backend.name!r} instead"
        )

    key = cache_key(circuit, backend.name, options, extras=str(req.include_visual))
    cached_payload = CACHE.get(key)
    if cached_payload is not None:
        return cached_payload, True, backend.name, warnings

    SIM_QUBITS.observe(circuit.qubits)
    result: SimResult = backend.run(circuit, options)
    payload: dict[str, Any] = {
        "result": result.to_payload(include_statevector=options.return_statevector),
        "metrics": circuit_metrics(circuit).to_dict(),
    }
    if req.include_visual:
        try:
            payload["visual"] = build_visual(circuit, options.bindings).to_dict()
        except VisualError as exc:
            payload["visual"] = None
            warnings.append(str(exc))
    payload["warnings"] = list(result.warnings)
    CACHE.put(key, payload)
    return payload, False, backend.name, warnings


@app.post(f"{API_PREFIX}/simulate", tags=["simulation"])
def simulate(
    req: SimulateRequest,
    x_redquant_plan: str | None = Header(default=None),
) -> Response:
    """Run a circuit synchronously (tier T-B). Budget: 900 ms."""
    plan = resolve_plan(x_redquant_plan)
    errors = _validation_errors(req.circuit)
    if errors:
        return _error(422, "invalid_circuit", "the circuit is not valid", issues=errors)
    started = time.perf_counter()
    try:
        payload, cached, backend_name, warnings = _run_simulation(req, plan)
    except PlanDenied as exc:
        PLAN_DENIALS.labels(plan.name).inc()
        return _error(402, "plan_limit", str(exc), plan=plan.name)
    except AdmissionError as exc:
        return _error(413, "too_large", str(exc))
    except BackendUnavailable as exc:
        return _error(503, "backend_unavailable", str(exc))
    except IRError as exc:
        return _error(422, "invalid_circuit", str(exc), opId=exc.op_id)
    except ValueError as exc:
        return _error(400, "bad_request", str(exc))

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    if elapsed_ms > SYNC_BUDGET_MS and not cached:
        log.warning(
            "simulate.over_budget",
            duration_ms=round(elapsed_ms, 1),
            budget_ms=SYNC_BUDGET_MS,
            qubits=req.circuit.qubits,
            backend=backend_name,
        )
        warnings.append(
            f"this run took {elapsed_ms:.0f} ms, over the {SYNC_BUDGET_MS:.0f} ms "
            f"synchronous budget; submit it to /v1/simulate/async instead"
        )
    body = dict(payload)
    body.update(
        {
            "circuitHash": circuit_hash(req.circuit),
            "cached": cached,
            "backend": backend_name,
            "plan": plan.name,
            "warnings": [*payload.get("warnings", []), *warnings],
        }
    )
    return JSONResponse(content=body)


@app.post(f"{API_PREFIX}/simulate/async", status_code=202, tags=["simulation"])
def simulate_async(
    req: SimulateRequest,
    x_redquant_plan: str | None = Header(default=None),
) -> Response:
    """Enqueue a heavy or noisy run (tier T-C) and return a job id immediately."""
    plan = resolve_plan(x_redquant_plan)
    if not plan.async_jobs:
        PLAN_DENIALS.labels(plan.name).inc()
        return _error(
            402,
            "plan_limit",
            f"the {plan.name} plan does not include queued simulation",
            plan=plan.name,
        )
    errors = _validation_errors(req.circuit)
    if errors:
        return _error(422, "invalid_circuit", "the circuit is not valid", issues=errors)
    try:
        enforce_plan(plan, req.circuit, req.options)
    except PlanDenied as exc:
        PLAN_DENIALS.labels(plan.name).inc()
        return _error(402, "plan_limit", str(exc), plan=plan.name)

    request_id = current_request_id()

    def work() -> dict[str, Any]:
        payload, cached, backend_name, warnings = _run_simulation(req, plan)
        body = dict(payload)
        body.update(
            {
                "circuitHash": circuit_hash(req.circuit),
                "cached": cached,
                "backend": backend_name,
                "plan": plan.name,
                "warnings": [*payload.get("warnings", []), *warnings],
            }
        )
        return body

    job = JOBS.submit(work, request_id)
    log.info("job.submitted", job_id=job.id, qubits=req.circuit.qubits)
    return JSONResponse(
        status_code=202,
        content={
            "jobId": job.id,
            "state": job.state,
            "pollUrl": f"{API_PREFIX}/jobs/{job.id}",
        },
    )


@app.get(f"{API_PREFIX}/jobs/{{job_id}}", tags=["simulation"])
def get_job(job_id: str) -> Response:
    """Poll an async job. 404 once it has expired or if the pod restarted."""
    job = JOBS.get(job_id)
    if job is None:
        return _error(
            404,
            "unknown_job",
            f"no job {job_id!r} on this pod; jobs are pod-local and expire after "
            f"{JOB_TTL_SECONDS:.0f}s",
        )
    return JSONResponse(content=job.to_dict())


# --------------------------------------------------------------------------
# Transpilation
# --------------------------------------------------------------------------


@app.post(f"{API_PREFIX}/transpile", tags=["compilation"])
def transpile_endpoint(req: TranspileRequest) -> Response:
    errors = _validation_errors(req.circuit)
    if errors:
        return _error(422, "invalid_circuit", "the circuit is not valid", issues=errors)
    try:
        result = transpile(req.circuit, req.target)
    except KeyError as exc:
        return _error(
            400,
            "unknown_device",
            str(exc).strip("'"),
            knownDevices=list(DEVICE_NAMES),
        )
    except IRError as exc:
        return _error(422, "invalid_circuit", str(exc), opId=exc.op_id)
    except ValueError as exc:
        return _error(400, "bad_request", str(exc))

    body = result.to_dict()
    if req.verify:
        body["verification"] = _verify_transpile(req.circuit, result)
    return JSONResponse(content=body)


def _verify_transpile(original: Circuit, result: Any) -> dict[str, Any]:
    """Compare the two unitaries up to a global phase, when small enough.

    Only valid when routing did not run: SABRE permutes qubits, so the
    transpiled operator equals the original conjugated by that permutation, and
    the honest thing is to say "not checked" rather than to report a mismatch
    the learner cannot act on.
    """
    if original.qubits > 10:
        return {"checked": False, "reason": "over 10 qubits"}
    if result.swaps_added or result.circuit.qubits != original.qubits:
        return {
            "checked": False,
            "reason": "routing permuted the qubits; compare on the routed layout instead",
        }
    try:
        a = circuit_unitary(original)
        b = circuit_unitary(result.circuit)
    except (ValueError, AdmissionError) as exc:
        return {"checked": False, "reason": str(exc)}
    from app.backends.native import equal_up_to_global_phase

    same = equal_up_to_global_phase(a, b, 1e-8)
    return {
        "checked": True,
        "equivalent": bool(same),
        "maxAbsoluteError": float(np.abs(a - b).max()),
        "upToGlobalPhase": True,
    }


# --------------------------------------------------------------------------
# Grading
# --------------------------------------------------------------------------


@app.post(f"{API_PREFIX}/grade", tags=["grading"])
def grade_endpoint(req: GradeRequest) -> Response:
    try:
        backend = backend_registry.resolve(req.backend)
    except BackendUnavailable as exc:
        return _error(400, "unknown_backend", str(exc))
    report = grade(
        req.circuit, req.assertions, bindings=req.bindings, backend=backend
    )
    log.info(
        "grade",
        passed=report.passed,
        score=report.score,
        max_score=report.max_score,
        assertions=len(req.assertions),
    )
    return JSONResponse(content=report.to_dict())


# --------------------------------------------------------------------------
# Sandboxed execution
# --------------------------------------------------------------------------


@app.post(f"{API_PREFIX}/execute", tags=["sandbox"])
def execute(req: ExecuteRequest) -> Response:
    """Run untrusted learner Python. See ``app/sandbox.py`` for the threat model."""
    limits = SandboxLimits(cpu_seconds=req.cpu_seconds)
    if req.extract_circuit:
        result = run_and_extract_circuit(
            req.source, limits=limits, policy=SandboxPolicy(), seed=req.seed
        )
    else:
        result = run_untrusted(
            req.source,
            limits=limits,
            policy=SandboxPolicy(),
            capture=req.capture,
            seed=req.seed,
        )
    SANDBOX_RUNS.labels(result.status).inc()

    body = result.to_dict()
    body["circuit"] = None
    if req.extract_circuit and result.ok:
        body["circuit"] = _circuit_from_capture(result.captured.get("RESULT"))
    log.info("execute", status=result.status, cpu_seconds=result.cpu_seconds)
    return JSONResponse(content=body)


def _circuit_from_capture(raw: Any) -> dict[str, Any] | None:
    """Validate the IR the sandbox extracted, discarding anything malformed.

    The payload crossed a trust boundary, so it is re-parsed through the same
    Pydantic model as any other request body rather than trusted as-is.
    """
    if not isinstance(raw, dict) or raw.get("kind") != "circuit":
        return None
    payload = raw.get("payload")
    if not isinstance(payload, list) or len(payload) != 2 or payload[1] is None:
        return None
    try:
        return Circuit.model_validate(payload[1]).model_dump()
    except Exception:
        return None


# --------------------------------------------------------------------------
# Conversion
# --------------------------------------------------------------------------


@app.post(f"{API_PREFIX}/convert", tags=["compilation"])
def convert(req: ConvertRequest) -> Response:
    """IR to source in any dialect, or OpenQASM 3 text back to IR."""
    if (req.circuit is None) == (req.qasm is None):
        return _error(
            400, "bad_request", "provide exactly one of 'circuit' or 'qasm'"
        )
    if req.qasm is not None:
        try:
            circuit = from_qasm3(req.qasm)
        except IRError as exc:
            return _error(422, "invalid_qasm", str(exc), opId=exc.op_id)
        except (ValueError, SyntaxError) as exc:
            return _error(422, "invalid_qasm", str(exc))
        return JSONResponse(
            content={
                "circuit": circuit.model_dump(),
                "circuitHash": circuit_hash(circuit),
                "metrics": circuit_metrics(circuit).to_dict(),
                "issues": [i.to_dict() for i in validate(circuit)],
            }
        )

    circuit = req.circuit
    assert circuit is not None
    unknown = [d for d in req.dialects if d not in DIALECTS]
    if unknown:
        return _error(
            400,
            "unknown_dialect",
            f"unknown dialect(s): {', '.join(unknown)}",
            knownDialects=list(DIALECTS),
        )
    sources: dict[str, str] = {}
    failures: dict[str, str] = {}
    for dialect in req.dialects:
        try:
            sources[dialect] = to_source(circuit, dialect, req.bindings)
        except IRError as exc:
            failures[dialect] = str(exc)
    return JSONResponse(
        content={
            "sources": sources,
            "failures": failures,
            "circuitHash": circuit_hash(circuit),
            "metrics": circuit_metrics(circuit).to_dict(),
        }
    )


# --------------------------------------------------------------------------
# Introspection and health
# --------------------------------------------------------------------------


@app.get(f"{API_PREFIX}/backends", tags=["introspection"])
def list_backends() -> Response:
    """Which engines this pod has, and the ceilings each one enforces."""
    return JSONResponse(
        content={
            "backends": [i.to_dict() for i in backend_registry.infos()],
            "default": backend_registry.DEFAULT_BACKEND,
            "devices": [device_model(n).to_dict() for n in DEVICE_NAMES],
            "dialects": list(DIALECTS),
            "plans": {
                p.name: {
                    "maxQubits": p.max_qubits,
                    "maxNoisyQubits": p.max_noisy_qubits,
                    "maxShots": p.max_shots,
                    "asyncJobs": p.async_jobs,
                }
                for p in PLANS.values()
            },
            "convention": (
                "qubit 0 is the most significant bit of a basis index: for n "
                "qubits, index i gives qubit q the value (i >> (n-1-q)) & 1"
            ),
        }
    )


@app.get("/healthz", tags=["health"])
def healthz() -> dict[str, Any]:
    """Liveness: the process is up. Deliberately does no work."""
    return {"status": "ok", "service": SERVICE, "version": VERSION}


@app.get("/readyz", tags=["health"])
def readyz() -> Response:
    """Readiness: the native engine can actually simulate.

    Runs a real two-qubit Bell circuit rather than checking a flag, because the
    failure this guards against -- a broken NumPy/BLAS install in a rebuilt
    image -- shows up only when something is multiplied.
    """
    try:
        native = backend_registry.get(backend_registry.DEFAULT_BACKEND)
        from app.ir import Op

        probe = Circuit(
            qubits=2,
            ops=[Op(gate="h", targets=[0]), Op(gate="x", targets=[1], controls=[0])],
        )
        result = native.run(probe, SimOptions(shots=0, return_bloch=False))
        ok = abs(float(result.probabilities[0]) - 0.5) < 1e-9
    except Exception as exc:  # noqa: BLE001
        log.error("readyz.failed", error=str(exc))
        return _error(503, "not_ready", f"native backend probe failed: {exc}")
    if not ok:
        return _error(503, "not_ready", "native backend probe returned wrong amplitudes")
    return JSONResponse(
        content={
            "status": "ready",
            "backends": {i.name: i.available for i in backend_registry.infos()},
            "cacheEntries": len(CACHE),
        }
    )


@app.get("/metrics", tags=["health"], include_in_schema=False)
def metrics_endpoint() -> Response:
    return PlainTextResponse(
        content=generate_latest().decode("utf-8"), media_type=CONTENT_TYPE_LATEST
    )


# --------------------------------------------------------------------------
# OpenAPI on disk (section 3: the TS<->Python contract)
# --------------------------------------------------------------------------

OPENAPI_PATH = os.environ.get(
    "KERNEL_OPENAPI_PATH",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "openapi.json"),
)


def write_openapi(target_app: FastAPI | None = None, path: str | None = None) -> str:
    """Write the generated OpenAPI document to disk.

    Section 3 requires this schema to be the typed contract between the
    TypeScript services and this one, checked in and drift-tested in CI. The
    kernel generates it rather than hand-maintaining it, so the contract cannot
    disagree with the code that serves it.
    """
    target = target_app or app
    destination = path or OPENAPI_PATH
    document = target.openapi()
    with open(destination, "w", encoding="utf-8") as fh:
        json.dump(document, fh, indent=2, sort_keys=True)
        fh.write("\n")
    return destination


def run() -> None:  # pragma: no cover - the console-script entry point
    """``quantum-kernel`` console script: serve, or dump the schema and exit."""
    parser = argparse.ArgumentParser(prog="quantum-kernel")
    parser.add_argument("--host", default="0.0.0.0")  # noqa: S104 -- in-cluster only
    parser.add_argument("--port", type=int, default=8100)
    parser.add_argument(
        "--write-openapi",
        action="store_true",
        help="write openapi.json and exit without serving",
    )
    args = parser.parse_args()
    configure_logging()
    if args.write_openapi:
        print(write_openapi())
        return
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_config=None)


__all__ = [
    "API_PREFIX",
    "CACHE",
    "CACHE_CAPACITY",
    "JOBS",
    "MAX_REQUEST_BYTES",
    "OPENAPI_PATH",
    "PLANS",
    "SYNC_BUDGET_MS",
    "ConvertRequest",
    "ExecuteRequest",
    "GradeRequest",
    "Job",
    "JobStore",
    "Plan",
    "PlanDenied",
    "ResultCache",
    "SimulateRequest",
    "TranspileRequest",
    "app",
    "cache_key",
    "configure_logging",
    "enforce_plan",
    "resolve_plan",
    "run",
    "write_openapi",
]
