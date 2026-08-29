"""Executing untrusted learner Python (system design, section 10).

**This module is not the security boundary, and must never be described as
one.** In production every call here runs inside a gVisor (``runsc``) sandbox
with an *empty network namespace* -- not a firewall rule, an absent interface --
a read-only root filesystem, a 64 MiB ``tmpfs`` scratch, and a seccomp profile
cut down to the ~60 syscalls CPython and NumPy actually need. The pod is
single-use and recycled after 50 executions. Everything in this file --
the separate process, the ``resource`` limits, the import allowlist, the
stripped builtins -- is **defence in depth** layered *inside* that boundary. It
turns the common failures (an infinite loop, a runaway allocation, a stray
``import os``) into clean, attributable error messages instead of a killed pod,
and it means a development machine without gVisor still refuses the obvious
things. A determined attacker can walk out of a CPython ``exec`` sandbox through
object introspection; that is precisely why the kernel-level isolation exists
and why this layer is never relied on alone.

The concrete measures, matching section 10:

* **Separate process**, started with the ``spawn`` method so the child does not
  inherit the parent's imported modules, file descriptors, threads or memory.
* **``resource`` limits** applied by the child before it touches learner code:
  CPU (soft :data:`CPU_SECONDS`, hard one second later so the ``SIGXCPU``
  handler can report cleanly), address space :data:`ADDRESS_SPACE_BYTES`,
  ``NPROC`` :data:`MAX_PROCESSES`, ``FSIZE``, and no core dumps.
* **Empty environment.** ``os.environ`` is cleared, then repopulated with the
  handful of thread-count knobs that stop BLAS from spawning a pool the
  ``NPROC`` limit would refuse anyway.
* **Temporary working directory**, created per call and removed afterwards.
* **Import allowlist** enforced by a replacement ``__import__``: see
  :func:`_guarded_import` for why it applies to learner code only.
* **Stdout capped** at :data:`STDOUT_LIMIT_BYTES`, in memory, with a truncation
  flag rather than a silent cut.
* **Wall-clock kill** at :data:`WALL_CLOCK_MULTIPLIER` times the CPU limit,
  because a process asleep in a syscall burns no CPU and would otherwise sit
  there forever.

A note on ``RLIMIT_AS``. Section 10 specifies 512 MiB of memory; this
implements it as an *address space* limit, which is strictly harsher than an
RSS limit because it counts every mapping, shared libraries included. NumPy,
SciPy and Qiskit fit comfortably. Cirq and PennyLane do not -- their import
graphs map more than 512 MiB of virtual address space -- so a lab that wants
them must raise :attr:`SandboxLimits.address_space_bytes` explicitly. Failing
loudly at the stated limit is better than quietly running with none.

Module scope here is **stdlib only, on purpose**: the ``spawn`` child imports
this module to find its entry point, and that import happens *before* the
environment is cleared and the limits are applied. Importing NumPy at module
scope would mean NumPy is loaded outside the sandbox's limits every time.
"""

from __future__ import annotations

import builtins
import contextlib
import io
import json
import multiprocessing
import os
import signal
import sys
import tempfile
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator, Literal, Sequence, get_args

# --------------------------------------------------------------------------
# Policy constants (section 10)
# --------------------------------------------------------------------------

#: CPU seconds for a lab or grader assertion. Projects get 10 (see SandboxLimits).
CPU_SECONDS = 2

#: 512 MiB of address space.
ADDRESS_SPACE_BYTES = 512 * 1024 * 1024

#: Processes/threads for the real uid. NumPy imports fine under this once the
#: BLAS thread knobs are set; anything trying to fork gets EAGAIN.
MAX_PROCESSES = 64

#: 4 MiB of captured stdout, per section 10.
STDOUT_LIMIT_BYTES = 4 * 1024 * 1024

#: Any single file the learner writes is capped at this. Generous next to the
#: 64 MiB tmpfs, tight enough that a runaway loop cannot fill a disk.
FILE_SIZE_BYTES = 8 * 1024 * 1024

#: Wall-clock kill at 3x the CPU limit: a sleeping process burns no CPU.
WALL_CLOCK_MULTIPLIER = 3.0

#: JSON payload cap for whatever the learner leaves in ``RESULT``.
VALUE_LIMIT_BYTES = 1 * 1024 * 1024

#: Exactly the allowlist in section 10. Submodules of these are allowed too, so
#: ``numpy.linalg`` and ``qiskit.circuit.library`` work without enumeration.
DEFAULT_ALLOWED: frozenset[str] = frozenset(
    {"numpy", "qiskit", "cirq", "pennylane", "scipy", "math", "itertools", "typing"}
)

#: Named explicitly so the denial message can say *why*, rather than the
#: generic "not on the allowlist". These are the ones people actually try.
DEFAULT_DENIED: frozenset[str] = frozenset(
    {
        "os", "sys", "subprocess", "socket", "ctypes", "shutil", "pathlib",
        "importlib", "builtins", "pickle", "marshal", "multiprocessing",
        "threading", "http", "urllib", "requests", "ftplib", "telnetlib",
        "asyncio", "signal", "resource", "pty", "fcntl", "mmap", "code",
        "codeop", "runpy", "gc", "inspect", "traceback", "tempfile", "glob",
    }
)

#: Not enabled by default. A lab that needs plotting-free plumbing can widen
#: the policy to this set; nothing here can reach the filesystem or a socket.
EXTRA_SAFE: frozenset[str] = frozenset(
    {"cmath", "fractions", "decimal", "functools", "operator", "collections",
     "random", "statistics", "json", "re", "string", "enum", "dataclasses",
     "abc", "numbers", "copy", "heapq", "bisect", "array"}
)

#: Removed from the learner's builtins. Not a boundary -- ``__import__`` is the
#: one that matters -- but it turns "I accidentally called exit()" into a clear
#: NameError instead of a process that vanishes mid-grade.
STRIPPED_BUILTINS: tuple[str, ...] = (
    "open", "exec", "eval", "compile", "input", "breakpoint", "exit", "quit",
    "help", "license", "credits", "copyright", "memoryview",
)

#: The module name learner code runs as. Advisory only: it lives in the
#: learner's own globals, so learner code can rebind it. Nothing security
#: relevant may key off it -- see :func:`_raised_by_learner_code`.
SANDBOX_MODULE = "__redquant_submission__"

#: The ``co_filename`` every frame of learner code carries, fixed by the
#: ``compile()`` call in :func:`_child_main`. This *is* the thing the guards key
#: off, because unlike ``__name__`` it is not a name in a dict the learner owns,
#: and learner code has no ``compile`` with which to mint another one.
SUBMISSION_FILENAME = "<submission>"

#: PEP 578 audit events refused when the innermost Python frame raising them is
#: the learner's own. Prefix-matched, so a whole module's surface goes at once.
#: This is what makes the import policy bite even when learner code has reached
#: the *real* ``__import__`` or ``open`` through object introspection -- the
#: allowlist is then enforced by the interpreter at the point of effect, rather
#: than by a builtin the learner has routed around.
AUDIT_DENIED_PREFIXES: tuple[str, ...] = (
    "os.", "shutil.", "subprocess.", "socket.", "ctypes.", "importlib.",
    "pickle.", "marshal.", "urllib.", "ftplib.", "http.client.", "smtplib.",
    "webbrowser.", "glob.", "fcntl.", "mmap.", "pty.", "tempfile.", "code.",
    "signal.", "msvcrt.", "winreg.", "sys.set", "sys.add",
)

#: Deliberately *not* denied: ``sys._getframe``. It is introspection, not an
#: effect -- it reaches no file, socket or process -- and denying it broke
#: ``import numpy`` outright, because ``collections.namedtuple`` and half a
#: dozen other stdlib helpers call it while a learner's ``import`` statement is
#: still on the stack. Refusing harmless introspection to look thorough, at the
#: cost of the one import every lab needs, would be a bad trade.

#: Audit events refused outright, by exact name, from a learner frame.
AUDIT_DENIED_EXACT: frozenset[str] = frozenset(
    {
        "open", "exec", "compile", "builtins.input", "setopencodehook",
        "ensurepip.bootstrap", "cpython.run_file", "cpython.run_module",
        "cpython.run_command", "cpython.run_string", "cpython.run_stdin",
    }
)

Status = Literal[
    "ok",
    "error",
    "denied_import",
    "denied_operation",
    "cpu_limit",
    "timeout",
    "memory",
    "killed",
]

#: Every legal :data:`Status`, used to validate what comes back over the pipe.
_STATUS_VALUES: frozenset[str] = frozenset(get_args(Status))


class SandboxError(RuntimeError):
    """The sandbox itself could not run, as opposed to the code failing."""


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class SandboxLimits:
    """Resource ceilings for one execution. Defaults are the section 10 numbers."""

    cpu_seconds: int = CPU_SECONDS
    address_space_bytes: int = ADDRESS_SPACE_BYTES
    max_processes: int = MAX_PROCESSES
    file_size_bytes: int = FILE_SIZE_BYTES
    stdout_limit_bytes: int = STDOUT_LIMIT_BYTES
    value_limit_bytes: int = VALUE_LIMIT_BYTES
    #: Overrides the ``WALL_CLOCK_MULTIPLIER * cpu_seconds`` default when set.
    wall_clock_seconds: float | None = None

    @property
    def wall_clock(self) -> float:
        if self.wall_clock_seconds is not None:
            return float(self.wall_clock_seconds)
        return WALL_CLOCK_MULTIPLIER * float(self.cpu_seconds)

    @staticmethod
    def for_project() -> "SandboxLimits":
        """The looser tier section 10 grants multi-file projects: 10 CPU seconds."""
        return SandboxLimits(cpu_seconds=10)


@dataclass(frozen=True)
class SandboxPolicy:
    """Which imports the learner's own code may perform."""

    allowed: frozenset[str] = DEFAULT_ALLOWED
    denied: frozenset[str] = DEFAULT_DENIED

    def widen(self, *modules: str) -> "SandboxPolicy":
        return SandboxPolicy(
            allowed=self.allowed | frozenset(modules), denied=self.denied
        )

    def verdict(self, name: str) -> str | None:
        """``None`` when the import is allowed, else the reason to refuse it."""
        root = name.split(".", 1)[0]
        if root in self.denied:
            return (
                f"import of {name!r} is denied: {root!r} can reach the host "
                f"(filesystem, processes or network) and the sandbox has none"
            )
        if root in self.allowed:
            return None
        return (
            f"import of {name!r} is not permitted; this sandbox allows only "
            f"{', '.join(sorted(self.allowed))}"
        )


@dataclass
class SandboxResult:
    """What one execution produced. Always returned; never raises for user error."""

    status: Status
    stdout: str = ""
    stdout_truncated: bool = False
    error: str | None = None
    error_type: str | None = None
    traceback: str | None = None
    #: JSON-safe values of the globals named in ``capture``, plus ``RESULT``.
    captured: dict[str, Any] = field(default_factory=dict)
    duration_ms: float = 0.0
    cpu_seconds: float = 0.0
    exit_code: int | None = None

    @property
    def ok(self) -> bool:
        return self.status == "ok"

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "ok": self.ok,
            "stdout": self.stdout,
            "stdoutTruncated": self.stdout_truncated,
            "error": self.error,
            "errorType": self.error_type,
            "traceback": self.traceback,
            "captured": self.captured,
            "durationMs": self.duration_ms,
            "cpuSeconds": self.cpu_seconds,
            "exitCode": self.exit_code,
        }


# --------------------------------------------------------------------------
# Child-side machinery
# --------------------------------------------------------------------------


class _CappedWriter(io.TextIOBase):
    """A stdout replacement that stops at a byte budget and remembers it did.

    Buffered in memory rather than streamed to a file, because the cap has to
    hold even if the learner's very first statement is
    ``print('x' * 10**9)`` -- a file would grow to the FSIZE limit first.
    """

    def __init__(self, limit: int) -> None:
        self._chunks: list[str] = []
        self._size = 0
        self._limit = limit
        self.truncated = False

    def write(self, s: str) -> int:  # type: ignore[override]
        if not isinstance(s, str):
            raise TypeError("write() argument must be str")
        n = len(s.encode("utf-8", "replace"))
        if self._size >= self._limit:
            self.truncated = True
            return len(s)
        if self._size + n > self._limit:
            room = self._limit - self._size
            cut = s.encode("utf-8", "replace")[:room].decode("utf-8", "ignore")
            self._chunks.append(cut)
            self._size = self._limit
            self.truncated = True
            return len(s)
        self._chunks.append(s)
        self._size += n
        return len(s)

    def writable(self) -> bool:  # type: ignore[override]
        return True

    def flush(self) -> None:  # type: ignore[override]
        return None

    def getvalue(self) -> str:
        return "".join(self._chunks)


class _DeniedImport(ImportError):
    """Raised by the guarded ``__import__``. Distinguished so the report can be
    specific: "you tried to import os" is a teachable message, "ImportError" is
    not."""


#: See the re-entrancy guard in :func:`_audit_hook`.
_HOOK_REENTRY = threading.local()


class _DeniedOperation(PermissionError):
    """Raised by the audit hook for a non-import operation -- opening a file,
    creating a socket, forking -- attempted directly by learner code."""


#: Frames belonging to the import machinery. An event raised from inside one of
#: these is the interpreter loading a module the policy has *already* passed --
#: reading ``numpy/__init__.py`` off disk, for instance -- not learner code
#: reaching for a file.
_IMPORT_MACHINERY_PREFIXES: tuple[str, ...] = (
    "<frozen importlib", "<frozen zipimport", "<frozen runpy",
)

#: ``co_filename`` -> "is this file part of an allowed library?", memoised
#: because the audit hook asks the question thousands of times during a single
#: ``import qiskit``.
_LIBRARY_FILE_CACHE: dict[str, bool] = {}


def _is_allowed_library_frame(filename: str, allowed: frozenset[str]) -> bool:
    """True when ``filename`` lives inside a package the policy allows.

    Decided on the *path*, not on the frame's ``__name__``: a module's
    ``__name__`` is a writable attribute, so learner code that has reached
    ``shutil`` could set ``shutil.__name__ = "numpy"`` and launder every call it
    makes through it. Learner code cannot move a file into NumPy's directory,
    and cannot get code loaded from a path of its choosing without an import the
    policy already vetted.
    """
    cached = _LIBRARY_FILE_CACHE.get(filename)
    if cached is not None:
        return cached
    parts = filename.replace("\\", "/").split("/")
    verdict = any(
        part in allowed or part.split(".", 1)[0] in allowed for part in parts
    )
    if len(_LIBRARY_FILE_CACHE) < 4096:
        _LIBRARY_FILE_CACHE[filename] = verdict
    return verdict


def _learner_initiated(depth: int, allowed: frozenset[str]) -> bool:
    """True when learner code caused this operation with nothing allowed between.

    Walking the stack, rather than looking only at the innermost frame, is what
    makes the check survive contact with the standard library. Half of it is a
    thin Python wrapper over a C call, and the audit event fires from inside the
    wrapper: ``shutil.copy`` raises ``open`` from ``shutil.py``'s frame and
    ``socket.socket()`` raises ``socket.__new__`` from ``socket.py``'s, so a
    check that asked only "is the innermost frame the learner's?" answered no to
    both and let them through. Measured, not reasoned about: both of those were
    live escapes against the first version of this function.

    So the walk goes outward from the raising frame and stops at the first frame
    that settles the question:

    * ``<submission>`` -- learner code, with only transparent stdlib plumbing in
      between. Apply the policy.
    * a file inside an allowed library -- NumPy opening its own data files, and
      not something to refuse. Allow.
    * the import machinery -- the interpreter loading a module whose name the
      policy already passed. Allow.

    Anything else (a stdlib wrapper) is transparent and the walk continues
    through it, which is exactly what closes the ``shutil.copy`` hole.

    The residual gap is deliberate and unclosable here: learner code can still
    ask an allowed library to touch the filesystem on its behalf --
    ``numpy.fromfile("/etc/passwd")`` resolves to a NumPy frame and is allowed.
    That is gVisor's read-only rootfs to refuse, not this function's.
    """
    try:
        frame: Any = sys._getframe(depth)
    except (ValueError, AttributeError):  # pragma: no cover - not CPython
        return False
    while frame is not None:
        filename = frame.f_code.co_filename
        if filename == SUBMISSION_FILENAME:
            return True
        if filename.startswith(_IMPORT_MACHINERY_PREFIXES):
            return False
        if _is_allowed_library_frame(filename, allowed):
            return False
        frame = frame.f_back
    return False


def _raised_by_learner_code(depth: int) -> bool:
    """True when the Python frame ``depth`` levels below us is the learner's.

    This replaces the obvious-looking check, which was to read ``__name__`` out
    of the ``globals`` CPython hands ``__import__``. That check was spoofable in
    one line: ``__name__`` is an ordinary entry in the learner's own globals
    dict, so ``__name__ = "numpy"`` followed by ``import os`` made every
    subsequent import look to the guard like NumPy importing its own
    dependencies. Calling ``__import__("os", {"__name__": "numpy"})`` directly
    spoofed it just as cheaply, without even rebinding anything.

    A frame's ``co_filename`` is not spoofable that way. It is stamped onto the
    code object by the ``compile()`` call in :func:`_child_main`, learner code
    has no ``compile`` or ``exec`` with which to mint another code object
    carrying that name, and the frame stack is not a namespace the learner can
    assign into.

    Frames are the right question in both directions: an import performed *by*
    NumPy has a NumPy frame here and passes, which is the whole reason the
    allowlist can coexist with libraries that import ``os`` themselves.
    """
    try:
        frame = sys._getframe(depth)
    except (ValueError, AttributeError):  # pragma: no cover - not CPython
        return False
    return frame.f_code.co_filename == SUBMISSION_FILENAME


def _audit_hook(policy: SandboxPolicy) -> Any:
    """Build the PEP 578 hook that enforces the policy at the point of effect.

    The import allowlist alone only governs the ``__import__`` *this module
    installs*. Learner code that reaches CPython's real builtins through object
    introspection -- ``typing.__builtins__["open"]``, or the classic walk over
    ``object.__subclasses__()`` -- bypasses that builtin entirely and always
    will; it is a property of ``exec``-based sandboxes, not a bug that can be
    patched out. An audit hook is enforced by the interpreter itself, cannot be
    removed once installed (CPython provides no API to do so), and fires on the
    *operation* rather than on the name used to reach it, so the same policy
    now covers both routes.

    Like the import guard it acts only on events raised from a learner frame,
    for exactly the same reason: NumPy opens files, and must go on being able
    to. That leaves a real gap -- learner code can still ask an allowed library
    to touch the filesystem on its behalf, ``numpy.fromfile`` being the obvious
    one -- and closing that gap is not this layer's job. gVisor's empty network
    namespace and read-only rootfs are.
    """

    def hook(event: str, args: tuple[Any, ...]) -> None:
        # Re-entrancy guard, and it is load-bearing rather than an
        # optimisation: `sys._getframe` itself raises the `sys._getframe` audit
        # event, so a hook that looks at frames re-enters itself once per frame
        # lookup and recurses until the interpreter dies -- silently, since the
        # crash is a stack overflow rather than a Python exception. Thread-local
        # rather than a module global so a second thread's events are still
        # examined while this one is inside the hook.
        if getattr(_HOOK_REENTRY, "busy", False):
            return
        _HOOK_REENTRY.busy = True
        try:
            # 0 is `_learner_initiated`, 1 is this hook, 2 is the raiser.
            if not _learner_initiated(2, policy.allowed):
                return
            if event == "import":
                name = args[0] if args else ""
                reason = policy.verdict(str(name))
                if reason is not None:
                    raise _DeniedImport(reason, name=str(name))
                return
            if event in AUDIT_DENIED_EXACT or event.startswith(
                AUDIT_DENIED_PREFIXES
            ):
                raise _DeniedOperation(
                    f"{event!r} is not permitted in this sandbox: learner code "
                    f"may not reach the filesystem, the network or other "
                    f"processes"
                )
        finally:
            _HOOK_REENTRY.busy = False

    return hook


def _guarded_import(policy: SandboxPolicy, real_import: Any) -> Any:
    """Build the ``__import__`` replacement installed for learner code.

    The subtlety that makes an allowlist work at all: NumPy itself imports
    ``os``, ``sys``, ``ctypes`` and a dozen other denied names. Enforcing the
    list unconditionally would make ``import numpy`` -- the one import every
    lab needs -- fail. So the check applies **only when the importing code is
    the learner's own**, decided by :func:`_raised_by_learner_code`. Imports
    performed from inside an already-loaded library pass through untouched.

    This is a correctness mechanism, not a containment one: learner code can
    reach a denied module through an allowed one's attributes
    (``numpy.core.os``, say). Containment is gVisor's job. What this buys is a
    clear, immediate, attributable error for the overwhelmingly common case,
    and -- with the audit hook of :func:`_audit_hook` behind it -- a policy that
    still applies when the learner has gone around this function entirely.
    """

    def guarded(
        name: str,
        globals: dict[str, Any] | None = None,
        locals: dict[str, Any] | None = None,
        fromlist: Sequence[str] = (),
        level: int = 0,
    ) -> Any:
        # Frame 0 is `guarded`; frame 1 is the code performing the import.
        if _raised_by_learner_code(2):
            reason = policy.verdict(name)
            if reason is not None:
                raise _DeniedImport(reason, name=name)
        return real_import(name, globals, locals, fromlist, level)

    return guarded


def _apply_limits(limits: SandboxLimits) -> None:
    """Install the ``resource`` ceilings. POSIX only; a no-op elsewhere."""
    try:
        import resource
    except ImportError:  # pragma: no cover - Windows, which we do not ship on
        return

    def cap(what: int, soft: int, hard: int | None = None) -> None:
        hard_v = soft if hard is None else hard
        try:
            cur_soft, cur_hard = resource.getrlimit(what)
        except (ValueError, OSError):  # pragma: no cover - unknown resource
            return
        if cur_hard != resource.RLIM_INFINITY:
            soft = min(soft, cur_hard)
            hard_v = min(hard_v, cur_hard)
        try:
            resource.setrlimit(what, (soft, hard_v))
        except (ValueError, OSError):  # pragma: no cover - refused by the kernel
            pass

    # Soft one second below hard, so SIGXCPU lands while there is still budget
    # to unwind, format a traceback and report. The hard limit is the backstop
    # for code sitting in a C loop where no Python handler can run.
    cap(resource.RLIMIT_CPU, limits.cpu_seconds, limits.cpu_seconds + 1)
    cap(resource.RLIMIT_AS, limits.address_space_bytes)
    cap(resource.RLIMIT_NPROC, limits.max_processes)
    cap(resource.RLIMIT_FSIZE, limits.file_size_bytes)
    cap(resource.RLIMIT_CORE, 0)


def _scrub_environment() -> None:
    """Empty ``os.environ``, then restore only thread-count knobs.

    Nothing the learner's code can read should carry information from the pod:
    no ``PATH``, no ``HOME``, no service credentials, no OTel endpoint. The
    three variables put back are thread-pool caps, set before NumPy is ever
    imported so BLAS builds a one-thread pool rather than asking for a thread
    per core and colliding with the ``NPROC`` limit.
    """
    os.environ.clear()
    os.environ["OMP_NUM_THREADS"] = "1"
    os.environ["OPENBLAS_NUM_THREADS"] = "1"
    os.environ["MKL_NUM_THREADS"] = "1"


def _jsonable(value: Any, depth: int = 0) -> Any:
    """Best-effort conversion to JSON-safe data, without importing NumPy.

    NumPy arrays and scalars expose ``tolist``/``item``, so they convert by
    duck typing; anything else falls back to ``repr``. Keeping this
    import-free is what lets the module stay stdlib-only at scope.
    """
    if depth > 6:
        return repr(value)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, complex):
        return {"re": value.real, "im": value.imag}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v, depth + 1) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v, depth + 1) for k, v in value.items()}
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        try:
            return _jsonable(tolist(), depth + 1)
        except Exception:
            pass
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _jsonable(item(), depth + 1)
        except Exception:
            pass
    return repr(value)


def _child_main(
    conn: Any,
    source: str,
    limits: SandboxLimits,
    policy: SandboxPolicy,
    capture: tuple[str, ...],
    seed: int,
) -> None:
    """The whole of the child process. Sends exactly one dict, then returns.

    Ordering matters and is not arbitrary: limits and the environment scrub
    come first, so nothing the learner triggers -- including the very first
    ``import numpy`` -- ever runs outside them.
    """
    _scrub_environment()
    _apply_limits(limits)

    def on_xcpu(signum: int, frame: Any) -> None:
        raise TimeoutError(
            f"CPU limit of {limits.cpu_seconds}s exceeded"
        )

    try:
        signal.signal(signal.SIGXCPU, on_xcpu)
    except (AttributeError, ValueError, OSError):  # pragma: no cover
        pass

    out = _CappedWriter(limits.stdout_limit_bytes)
    real_stdout, real_stderr = sys.stdout, sys.stderr
    sys.stdout = out  # type: ignore[assignment]
    sys.stderr = out  # type: ignore[assignment]

    safe_builtins = {
        k: v for k, v in vars(builtins).items() if k not in STRIPPED_BUILTINS
    }
    safe_builtins["__import__"] = _guarded_import(policy, builtins.__import__)

    glb: dict[str, Any] = {
        "__name__": SANDBOX_MODULE,
        "__builtins__": safe_builtins,
        "__doc__": None,
        # Determinism: section 10 promises hidden tests are reproducible, so the
        # seed is handed to the code rather than left to the clock.
        "SEED": int(seed),
        "RESULT": None,
    }

    status: Status = "ok"
    error = error_type = tb_text = None
    started = time.perf_counter()
    try:
        code = compile(source, SUBMISSION_FILENAME, "exec")
        # Last thing before learner code runs, and deliberately after the
        # compile above: an audit hook cannot be uninstalled, so everything the
        # sandbox itself still needs to do must either already have happened or
        # run from a frame the hook lets through.
        sys.addaudithook(_audit_hook(policy))
        exec(code, glb)  # noqa: S102 -- the entire point of this module
    except _DeniedImport as exc:
        status, error_type = "denied_import", "ImportError"
        error = str(exc)
    except _DeniedOperation as exc:
        status, error_type = "denied_operation", "PermissionError"
        error = str(exc)
    except TimeoutError as exc:
        status, error_type = "cpu_limit", "TimeoutError"
        error = str(exc)
    except MemoryError as exc:
        status, error_type = "memory", "MemoryError"
        error = str(exc) or f"exceeded the {limits.address_space_bytes} byte memory limit"
    except SyntaxError as exc:
        status, error_type = "error", "SyntaxError"
        error = f"{exc.msg} (line {exc.lineno})"
        tb_text = "".join(traceback.format_exception_only(type(exc), exc))
    except BaseException as exc:  # noqa: BLE001 -- everything is reportable
        status, error_type = "error", type(exc).__name__
        error = str(exc)
        tb_text = _user_traceback(exc)
    duration_ms = (time.perf_counter() - started) * 1000.0

    captured: dict[str, Any] = {}
    for name in ("RESULT", *capture):
        if name in glb:
            captured[name] = _jsonable(glb[name])
    payload_json = json.dumps(captured, default=repr)
    if len(payload_json) > limits.value_limit_bytes:
        captured = {
            "RESULT": f"<omitted: {len(payload_json)} bytes exceeds the "
            f"{limits.value_limit_bytes} byte capture limit>"
        }

    cpu = 0.0
    try:
        import resource

        usage = resource.getrusage(resource.RUSAGE_SELF)
        cpu = float(usage.ru_utime + usage.ru_stime)
    except Exception:  # pragma: no cover
        pass

    sys.stdout, sys.stderr = real_stdout, real_stderr
    try:
        # `send_bytes`, not `send`. `Connection.send` pickles, and
        # `Connection.recv` on the other end unpickles -- which would mean the
        # trusted parent running `pickle.loads` on bytes produced inside the
        # process whose entire purpose is to host hostile code. Anything that
        # escaped far enough to write to this pipe would then have arbitrary
        # code execution in the worker, outside every limit this module
        # applies. JSON has no such reduction step, and the parent validates
        # the shape besides (see `_decode_payload`).
        conn.send_bytes(
            json.dumps(
                {
                    "status": status,
                    "stdout": out.getvalue(),
                    "stdout_truncated": out.truncated,
                    "error": error,
                    "error_type": error_type,
                    "traceback": tb_text,
                    "captured": captured,
                    "duration_ms": duration_ms,
                    "cpu_seconds": cpu,
                },
                default=repr,
            ).encode("utf-8", "replace")
        )
    except Exception:  # pragma: no cover - parent already gone
        pass
    finally:
        conn.close()


def _user_traceback(exc: BaseException) -> str:
    """A traceback with the sandbox's own frames removed.

    A learner debugging their circuit should see their line numbers, not
    ``app/sandbox.py``'s. Frames are kept only where the filename is the
    ``<submission>`` we compiled.
    """
    frames = [
        f
        for f in traceback.extract_tb(exc.__traceback__)
        if f.filename == "<submission>"
    ]
    head = "Traceback (most recent call last):\n" if frames else ""
    body = "".join(traceback.format_list(frames))
    tail = "".join(traceback.format_exception_only(type(exc), exc))
    return head + body + tail


# --------------------------------------------------------------------------
# Parent-side driver
# --------------------------------------------------------------------------


def _context() -> Any:
    """The ``spawn`` context. Never ``fork``: a forked child would inherit the
    parent's imported SDKs, open sockets to Redis and Postgres, and its memory,
    which defeats both the memory limit and the isolation."""
    return multiprocessing.get_context("spawn")


#: Ceiling on the child's report: the stdout cap, the capture cap, and room for
#: the JSON framing and a traceback. ``recv_bytes`` refuses anything larger
#: rather than letting the child dictate an allocation in the worker.
_MAX_PAYLOAD_BYTES = STDOUT_LIMIT_BYTES + VALUE_LIMIT_BYTES + 1024 * 1024

#: ``os.chdir`` and the ``__main__`` blanking below are both process-global, and
#: FastAPI runs synchronous endpoints on a thread pool. One launch at a time.
_LAUNCH_LOCK = threading.Lock()


@contextlib.contextmanager
def _minimal_child_bootstrap(workdir: str) -> Iterator[None]:
    """Make the spawn child start in ``workdir`` and skip ``__main__`` entirely.

    Two process-global facts about ``multiprocessing.spawn`` drive this.

    First, ``get_preparation_data`` records ``os.getcwd()`` and the child
    chdirs to it, so setting the parent's cwd for the duration of ``start()``
    is how the child gets a private scratch directory -- there is no per-Process
    cwd argument.

    Second, that same function tells the child to re-import the parent's
    ``__main__``: by module name if ``__main__.__spec__`` is not ``None``, else
    by running ``__main__.__file__`` through ``runpy``. Neither is wanted here.
    The child needs exactly one module -- this one, to unpickle the entry point
    -- and re-running the parent's entry point means importing pytest, or the
    whole FastAPI app, into every sandbox; under ``python -c`` or a REPL, where
    ``__file__`` is ``<stdin>``, it fails outright. Setting ``__spec__`` to
    ``None`` and removing ``__file__`` for the duration of ``start()`` is the
    condition under which CPython skips main-module initialisation entirely,
    and ``start()`` is synchronous, so the window is as small as it can be.
    ``__spec__`` is *set* rather than deleted because ``get_preparation_data``
    reads the attribute directly and would raise if it were absent.
    """
    main = sys.modules.get("__main__")
    had_spec = main is not None and hasattr(main, "__spec__")
    saved_spec = getattr(main, "__spec__", None) if main is not None else None
    saved_file: Any = None
    had_file = main is not None and hasattr(main, "__file__")
    previous_cwd = os.getcwd()
    with _LAUNCH_LOCK:
        if main is not None:
            main.__spec__ = None  # type: ignore[attr-defined]
            if had_file:
                saved_file = main.__file__
                del main.__file__
        try:
            os.chdir(workdir)
            yield
        finally:
            os.chdir(previous_cwd)
            if main is not None:
                if had_spec:
                    main.__spec__ = saved_spec  # type: ignore[attr-defined]
                else:  # pragma: no cover - every real __main__ has one
                    del main.__spec__
                if had_file:
                    main.__file__ = saved_file


def run_untrusted(
    source: str,
    *,
    limits: SandboxLimits | None = None,
    policy: SandboxPolicy | None = None,
    capture: Iterable[str] = (),
    seed: int = 0,
) -> SandboxResult:
    """Run ``source`` in a locked-down child process and report what happened.

    Never raises for anything the learner's code did -- a syntax error, an
    infinite loop and a denied import all come back as a
    :class:`SandboxResult` with a status and a message. :class:`SandboxError`
    is reserved for the sandbox failing to start at all, which is an operator
    problem rather than a learner one.
    """
    limits = limits or SandboxLimits()
    policy = policy or SandboxPolicy()
    capture_t = tuple(capture)

    ctx = _context()
    parent_conn, child_conn = ctx.Pipe(duplex=False)
    workdir = tempfile.mkdtemp(prefix="redquant-sbx-")
    started = time.perf_counter()
    proc: Any = None

    try:
        proc = ctx.Process(
            target=_child_main,
            args=(child_conn, source, limits, policy, capture_t, seed),
            daemon=True,
        )
        with _minimal_child_bootstrap(workdir):
            proc.start()
        child_conn.close()

        payload = _await_payload(parent_conn, proc, limits.wall_clock)
        elapsed_ms = (time.perf_counter() - started) * 1000.0

        if payload is None:
            return _post_mortem(proc, limits, elapsed_ms)

        # The child sent its report and is on its way out; a short join makes
        # `exit_code` meaningful instead of None-because-we-asked-too-early.
        proc.join(1.0)
        return SandboxResult(
            status=payload["status"],
            stdout=payload["stdout"],
            stdout_truncated=payload["stdout_truncated"],
            error=payload["error"],
            error_type=payload["error_type"],
            traceback=payload["traceback"],
            captured=payload["captured"],
            duration_ms=payload["duration_ms"],
            cpu_seconds=payload["cpu_seconds"],
            exit_code=proc.exitcode,
        )
    finally:
        if proc is not None and proc.is_alive():  # pragma: no cover - race
            _terminate(proc)
        try:
            parent_conn.close()
        except Exception:  # pragma: no cover
            pass
        _rmtree(workdir)


def _decode_payload(raw: Any) -> dict[str, Any] | None:
    """Parse and validate the child's report. Never trusts its shape.

    The child is the untrusted side of this pipe, so every field is checked and
    coerced rather than used as it arrives: a status that is not a real
    :data:`Status`, a stdout that is not a string, a captured value that is not
    a mapping. A hostile child can still *lie* -- it owns the file descriptor
    and can say "ok" whatever happened -- and no amount of validation here
    changes that, which is why grading integrity rests on gVisor rather than on
    this. What validation buys is that a lie cannot become anything worse than
    a wrong answer: not an exception in the worker, and not a type the caller
    did not expect.
    """
    if not isinstance(raw, (bytes, bytearray)):  # pragma: no cover
        return None
    try:
        data = json.loads(bytes(raw).decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    if data.get("status") not in _STATUS_VALUES:
        return None

    def text(key: str) -> str | None:
        value = data.get(key)
        return value if isinstance(value, str) else None

    captured = data.get("captured")
    return {
        "status": data["status"],
        "stdout": text("stdout") or "",
        "stdout_truncated": bool(data.get("stdout_truncated")),
        "error": text("error"),
        "error_type": text("error_type"),
        "traceback": text("traceback"),
        "captured": {str(k): v for k, v in captured.items()}
        if isinstance(captured, dict)
        else {},
        "duration_ms": float(data.get("duration_ms") or 0.0)
        if isinstance(data.get("duration_ms"), (int, float))
        else 0.0,
        "cpu_seconds": float(data.get("cpu_seconds") or 0.0)
        if isinstance(data.get("cpu_seconds"), (int, float))
        else 0.0,
    }


def _await_payload(conn: Any, proc: Any, wall_clock: float) -> dict[str, Any] | None:
    """Poll for the child's single message until it arrives, dies or times out.

    Reading *before* joining is deliberate: the message can be four megabytes
    of stdout, which is far more than a pipe buffer holds, so the child blocks
    mid-send until someone drains it. A ``join()`` first would deadlock on
    exactly the payloads that matter.
    """
    deadline = time.perf_counter() + wall_clock
    while True:
        remaining = deadline - time.perf_counter()
        if remaining <= 0:
            _terminate(proc)
            return None
        if conn.poll(min(remaining, 0.05)):
            try:
                return _decode_payload(conn.recv_bytes(_MAX_PAYLOAD_BYTES))
            except (EOFError, OSError):  # pragma: no cover - child died mid-send
                return None
        if not proc.is_alive():
            # It exited without sending: killed by the hard CPU limit, the OOM
            # killer, or a segfault. One last poll in case the message landed
            # in the same instant the process ended.
            if conn.poll(0):
                try:
                    return _decode_payload(conn.recv_bytes(_MAX_PAYLOAD_BYTES))
                except (EOFError, OSError):
                    return None
            return None


def _post_mortem(proc: Any, limits: SandboxLimits, elapsed_ms: float) -> SandboxResult:
    """Classify a child that died without reporting, from its exit signal."""
    code = proc.exitcode
    if code is None:  # pragma: no cover - terminate() raced us
        code = -signal.SIGKILL
    sig = -code if code is not None and code < 0 else None
    if sig == getattr(signal, "SIGXCPU", None):
        return SandboxResult(
            status="cpu_limit",
            error=f"killed after exceeding the {limits.cpu_seconds}s CPU limit",
            error_type="CPUTimeExceeded",
            duration_ms=elapsed_ms,
            exit_code=code,
        )
    if elapsed_ms >= limits.wall_clock * 1000.0 - 1.0:
        return SandboxResult(
            status="timeout",
            error=f"killed after exceeding the {limits.wall_clock:g}s wall-clock limit",
            error_type="WallClockExceeded",
            duration_ms=elapsed_ms,
            exit_code=code,
        )
    if sig == getattr(signal, "SIGKILL", None) and elapsed_ms >= (
        limits.cpu_seconds * 1000.0
    ):
        # The hard CPU limit is one second past the soft one and lands as
        # SIGKILL, which is indistinguishable from an OOM kill by signal alone.
        # Elapsed time separates them: code that ran at least as long as its
        # CPU budget before dying ran out of CPU, and saying "memory limit"
        # there sent people off optimising allocations for a timeout.
        return SandboxResult(
            status="cpu_limit",
            error=(
                f"killed after exceeding the {limits.cpu_seconds}s CPU limit "
                f"(the hard limit, one second past the soft one, so no handler "
                f"could report)"
            ),
            error_type="CPUTimeExceeded",
            duration_ms=elapsed_ms,
            exit_code=code,
        )
    if sig in (getattr(signal, "SIGKILL", None), getattr(signal, "SIGSEGV", None)):
        return SandboxResult(
            status="killed",
            error=(
                f"the sandboxed process was killed by signal {sig} without "
                f"reporting; this is usually the memory limit "
                f"({limits.address_space_bytes // (1024 * 1024)} MiB) being hit "
                f"inside a native library"
            ),
            error_type="Killed",
            duration_ms=elapsed_ms,
            exit_code=code,
        )
    return SandboxResult(
        status="killed",
        error=f"the sandboxed process exited with code {code} without reporting",
        error_type="Killed",
        duration_ms=elapsed_ms,
        exit_code=code,
    )


def _terminate(proc: Any) -> None:
    """SIGTERM, then SIGKILL. Never leave a runaway child behind."""
    try:
        proc.terminate()
        proc.join(0.5)
        if proc.is_alive():
            proc.kill()
            proc.join(0.5)
    except Exception:  # pragma: no cover
        pass


def _rmtree(path: str) -> None:
    """Remove the scratch directory without importing ``shutil`` at module scope."""
    import shutil

    try:
        shutil.rmtree(path, ignore_errors=True)
    except Exception:  # pragma: no cover
        pass


# --------------------------------------------------------------------------
# Convenience wrappers used by the grader and POST /v1/execute
# --------------------------------------------------------------------------

#: Appended to a submission that is expected to leave a circuit behind, so the
#: kernel can pull the IR back out. Kept as source rather than a post-exec hook
#: because the conversion has to happen inside the sandbox: a Qiskit object
#: cannot cross the process boundary, but its IR JSON can.
_EXTRACT_CIRCUIT = """
def __redquant_extract__():
    for name in ("qc", "circuit", "CIRCUIT", "RESULT"):
        obj = globals().get(name)
        if obj is None:
            continue
        if hasattr(obj, "data") and hasattr(obj, "num_qubits"):
            return ("qiskit", _redquant_qiskit_json(obj))
    return (None, None)


def _redquant_qiskit_json(qc):
    n = int(qc.num_qubits)
    index = {bit: i for i, bit in enumerate(qc.qubits)}
    cindex = {bit: i for i, bit in enumerate(qc.clbits)}
    ops = []
    for inst in qc.data:
        wires = [n - 1 - index[b] for b in inst.qubits]
        params = [float(p) for p in (inst.operation.params or [])]
        entry = {"gate": inst.operation.name.lower(), "targets": wires,
                 "params": params}
        if inst.clbits:
            entry["cbits"] = [cindex[b] for b in inst.clbits]
        ops.append(entry)
    return {"version": 1, "name": qc.name or "submission", "qubits": n,
            "clbits": int(qc.num_clbits), "ops": ops}


RESULT = {"kind": "circuit", "payload": __redquant_extract__()}
"""


def run_and_extract_circuit(
    source: str,
    *,
    limits: SandboxLimits | None = None,
    policy: SandboxPolicy | None = None,
    seed: int = 0,
) -> SandboxResult:
    """Execute learner code and pull a Qiskit circuit back out as IR JSON.

    Backs ``POST /v1/execute``. The circuit is serialised *inside* the sandbox
    because a ``QuantumCircuit`` cannot be pickled across the boundary safely
    (or at all, under the import allowlist) but its IR can.
    """
    return run_untrusted(
        source + "\n" + _EXTRACT_CIRCUIT,
        limits=limits,
        policy=policy,
        capture=("RESULT",),
        seed=seed,
    )


__all__ = [
    "ADDRESS_SPACE_BYTES",
    "CPU_SECONDS",
    "DEFAULT_ALLOWED",
    "DEFAULT_DENIED",
    "EXTRA_SAFE",
    "FILE_SIZE_BYTES",
    "MAX_PROCESSES",
    "SANDBOX_MODULE",
    "STDOUT_LIMIT_BYTES",
    "STRIPPED_BUILTINS",
    "VALUE_LIMIT_BYTES",
    "WALL_CLOCK_MULTIPLIER",
    "SandboxError",
    "SandboxLimits",
    "SandboxPolicy",
    "SandboxResult",
    "Status",
    "run_and_extract_circuit",
    "run_untrusted",
]
