"""The backend registry: one place that knows which engines exist.

Constructing a backend is cheap -- every adapter's ``__init__`` does nothing but
attempt its SDK import and remember the failure -- so the registry is built once
at import time and reused. That is what makes ``GET /v1/backends`` a pure lookup
rather than a series of import attempts on the request path.

The native NumPy engine is always present and always available; the other four
report ``available: false`` with the import error attached when their SDK is
missing, and :func:`resolve` falls back to the native engine when a caller asks
for something absent rather than failing the request.
"""

from __future__ import annotations

from typing import Iterable

from app.backends.aer import AerBackend
from app.backends.base import Backend, BackendInfo, BackendUnavailable, SimOptions, SimResult
from app.backends.cirq_backend import CirqBackend
from app.backends.density import DensityBackend
from app.backends.native import NativeBackend
from app.backends.pennylane_backend import PennyLaneBackend

#: Declaration order, which is also the order ``GET /v1/backends`` reports and
#: the order :func:`first_available` prefers.
BACKEND_ORDER: tuple[str, ...] = ("native", "density", "aer", "cirq", "pennylane")

#: The engine that must never be unavailable; ``GET /readyz`` asserts it.
DEFAULT_BACKEND = "native"

_REGISTRY: dict[str, Backend] = {}


def _build() -> dict[str, Backend]:
    backends: list[Backend] = [
        NativeBackend(),
        DensityBackend(),
        AerBackend(),
        CirqBackend(),
        PennyLaneBackend(),
    ]
    return {b.name: b for b in backends}


def registry() -> dict[str, Backend]:
    """The process-wide backend table, built on first use."""
    global _REGISTRY
    if not _REGISTRY:
        _REGISTRY = _build()
    return _REGISTRY


def names() -> tuple[str, ...]:
    return BACKEND_ORDER


def get(name: str) -> Backend:
    """Look up a backend by name, failing loudly on a typo."""
    table = registry()
    if name not in table:
        raise BackendUnavailable(
            f"unknown backend {name!r}; known backends: {', '.join(BACKEND_ORDER)}"
        )
    return table[name]


def is_available(name: str) -> bool:
    try:
        return get(name).info().available
    except BackendUnavailable:
        return False


def available_names() -> tuple[str, ...]:
    return tuple(n for n in BACKEND_ORDER if is_available(n))


def infos() -> list[BackendInfo]:
    table = registry()
    return [table[n].info() for n in BACKEND_ORDER if n in table]


def resolve(name: str | None, *, noisy: bool = False) -> Backend:
    """Pick a backend for a request, degrading rather than failing.

    An unnamed request goes to the density engine when the caller asked for
    noise and wants it exact, and to the native statevector engine otherwise.
    A *named* backend that is not installed falls back to native, because a
    learner whose lesson names ``aer`` should still see their circuit run on a
    pod that was built without the heavy wheels -- the response records the
    substitution in ``warnings``.
    """
    if name is None or name == "auto":
        return get("density") if noisy else get(DEFAULT_BACKEND)
    backend = get(name)
    if not backend.info().available:
        return get(DEFAULT_BACKEND)
    return backend


def first_available(candidates: Iterable[str]) -> Backend | None:
    for n in candidates:
        if is_available(n):
            return get(n)
    return None


__all__ = [
    "BACKEND_ORDER",
    "DEFAULT_BACKEND",
    "AerBackend",
    "Backend",
    "BackendInfo",
    "BackendUnavailable",
    "CirqBackend",
    "DensityBackend",
    "NativeBackend",
    "PennyLaneBackend",
    "SimOptions",
    "SimResult",
    "available_names",
    "first_available",
    "get",
    "infos",
    "is_available",
    "names",
    "registry",
    "resolve",
]
