"""The sandbox: what learner code may do, and what it may not.

These tests assert the *defence in depth* layer only. The real boundary in
production is gVisor plus an empty network namespace (system design section 10)
and none of that exists in a test process, so nothing here should be read as
"the sandbox is escape-proof". What is asserted is that the common hostile and
careless cases -- ``import os``, reaching for the network, an infinite loop, a
runaway allocation, a firehose of stdout -- are refused promptly, attributably,
and without taking the worker down.
"""

from __future__ import annotations

import multiprocessing
import os
import sys
import time
from typing import Any

import pytest

from app.sandbox import (
    _MAX_PAYLOAD_BYTES,
    _decode_payload,
    ADDRESS_SPACE_BYTES,
    CPU_SECONDS,
    DEFAULT_ALLOWED,
    DEFAULT_DENIED,
    MAX_PROCESSES,
    STDOUT_LIMIT_BYTES,
    SandboxLimits,
    SandboxPolicy,
    run_and_extract_circuit,
    run_untrusted,
)

pytestmark = pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="the resource limits this module asserts are POSIX/Linux specific",
)


# --------------------------------------------------------------------------
# The happy path
# --------------------------------------------------------------------------


def test_simple_code_runs_and_captures_stdout() -> None:
    result = run_untrusted("print('hello')\nRESULT = 6 * 7")
    assert result.ok and result.status == "ok"
    assert result.stdout == "hello\n"
    assert result.captured["RESULT"] == 42


def test_numpy_is_available_to_learner_code() -> None:
    result = run_untrusted("import numpy as np\nRESULT = np.arange(4).sum().item()")
    assert result.ok, result.error
    assert result.captured["RESULT"] == 6


def test_named_globals_can_be_captured() -> None:
    result = run_untrusted("answer = 'yes'\nother = 3", capture=("answer", "other"))
    assert result.captured["answer"] == "yes"
    assert result.captured["other"] == 3


def test_the_seed_is_handed_to_the_code_for_determinism() -> None:
    """Section 10 promises hidden tests are reproducible."""
    result = run_untrusted("RESULT = SEED", seed=1234)
    assert result.captured["RESULT"] == 1234


def test_runtime_error_reports_the_learners_line_not_ours() -> None:
    result = run_untrusted("def f():\n    return 1 / 0\n\nf()")
    assert not result.ok and result.status == "error"
    assert result.error_type == "ZeroDivisionError"
    assert "<submission>" in (result.traceback or "")
    assert "sandbox.py" not in (result.traceback or ""), (
        "the learner must not see the harness's frames"
    )


def test_syntax_error_reports_the_line() -> None:
    result = run_untrusted("def (")
    assert result.status == "error" and result.error_type == "SyntaxError"
    assert "line 1" in (result.error or "")


# --------------------------------------------------------------------------
# The import allowlist
# --------------------------------------------------------------------------


def test_import_os_is_denied() -> None:
    result = run_untrusted("import os\nprint(os.listdir('/'))")
    assert not result.ok
    assert result.status == "denied_import"
    assert "'os'" in (result.error or "")
    assert result.stdout == "", "nothing may run after a denied import"


@pytest.mark.parametrize(
    "module", ["os", "sys", "subprocess", "socket", "ctypes", "shutil", "pathlib"]
)
def test_every_named_denied_module_is_refused(module: str) -> None:
    result = run_untrusted(f"import {module}")
    assert result.status == "denied_import", f"{module} was not refused"
    assert module in (result.error or "")


@pytest.mark.parametrize(
    "source",
    [
        "import socket\ns = socket.socket()",
        "import urllib.request\nurllib.request.urlopen('http://example.com')",
        "from socket import create_connection\ncreate_connection(('1.1.1.1', 80))",
        "import http.client",
        "import ftplib",
        "import asyncio",
    ],
)
def test_network_access_is_denied_at_the_import(source: str) -> None:
    """The kernel-level guarantee is an empty network namespace; this layer
    refuses the import first so the learner gets a message instead of a
    connection timeout."""
    result = run_untrusted(source)
    assert result.status == "denied_import", f"{source!r} was not refused"


def test_a_module_that_is_merely_absent_from_the_allowlist_is_refused() -> None:
    result = run_untrusted("import json")
    assert result.status == "denied_import"
    assert "allows only" in (result.error or "")


def test_the_allowlist_is_exactly_what_the_design_says() -> None:
    assert DEFAULT_ALLOWED == frozenset(
        {"numpy", "qiskit", "cirq", "pennylane", "scipy", "math", "itertools", "typing"}
    )
    for denied in ("os", "sys", "subprocess", "socket", "ctypes"):
        assert denied in DEFAULT_DENIED


def test_allowed_submodules_work() -> None:
    result = run_untrusted("import numpy.linalg\nRESULT = 1")
    assert result.ok, result.error


def test_libraries_may_import_what_learners_may_not() -> None:
    """NumPy itself imports ``os``. Enforcing the list on library internals
    would make the one import every lab needs fail, so the check keys on the
    *importing module* being the learner's."""
    result = run_untrusted("import numpy\nRESULT = numpy.__name__")
    assert result.ok, result.error
    assert result.captured["RESULT"] == "numpy"


def test_a_lab_can_widen_the_policy() -> None:
    result = run_untrusted("import json\nRESULT = json.dumps([1])", policy=SandboxPolicy().widen("json"))
    assert result.ok, result.error
    assert result.captured["RESULT"] == "[1]"


def test_dangerous_builtins_are_absent() -> None:
    for name in ("open", "exec", "eval", "compile", "input"):
        result = run_untrusted(f"{name}")
        assert result.status == "error" and result.error_type == "NameError", name


# --------------------------------------------------------------------------
# Resource limits
# --------------------------------------------------------------------------


@pytest.mark.slow
def test_an_infinite_loop_is_killed_by_the_cpu_limit() -> None:
    started = time.perf_counter()
    result = run_untrusted("while True:\n    pass", limits=SandboxLimits(cpu_seconds=1))
    elapsed = time.perf_counter() - started
    assert not result.ok
    assert result.status == "cpu_limit", f"got {result.status}: {result.error}"
    assert "CPU limit" in (result.error or "")
    assert elapsed < 5.0, "the limit must bite promptly, not at the wall clock"


@pytest.mark.slow
def test_a_native_loop_is_also_killed() -> None:
    """A tight loop inside NumPy runs no Python bytecode, so the SIGXCPU
    handler cannot fire until it returns. The hard limit one second later is
    the backstop, and this is the test that proves it exists."""
    result = run_untrusted(
        "import numpy as np\n"
        "a = np.random.rand(300, 300)\n"
        "while True:\n"
        "    a = a @ a / 1e3",
        limits=SandboxLimits(cpu_seconds=1),
    )
    assert result.status in ("cpu_limit", "killed", "timeout"), result.error


@pytest.mark.slow
def test_sleeping_code_is_killed_by_the_wall_clock() -> None:
    """A process asleep in a syscall burns no CPU, so only the wall clock
    catches it."""
    result = run_untrusted(
        "import numpy\n"
        "numpy.__name__\n"
        "while True:\n"
        "    pass\n",
        limits=SandboxLimits(cpu_seconds=30, wall_clock_seconds=1.5),
    )
    assert result.status in ("timeout", "cpu_limit"), result.error


def test_a_runaway_allocation_is_refused() -> None:
    result = run_untrusted(f"x = bytearray({ADDRESS_SPACE_BYTES * 2})")
    assert not result.ok
    assert result.status in ("memory", "killed"), result.error


def test_stdout_is_capped_and_says_so() -> None:
    result = run_untrusted("print('x' * 1000)", limits=SandboxLimits(stdout_limit_bytes=100))
    assert result.ok
    assert result.stdout_truncated is True
    assert len(result.stdout) <= 100


def test_the_stdout_cap_defaults_to_four_megabytes() -> None:
    assert STDOUT_LIMIT_BYTES == 4 * 1024 * 1024
    assert CPU_SECONDS == 2
    assert MAX_PROCESSES == 64
    assert ADDRESS_SPACE_BYTES == 512 * 1024 * 1024


def test_a_large_but_legal_payload_survives_the_pipe() -> None:
    """The child's report can exceed a pipe buffer, so the parent has to drain
    it before joining. If that ordering were wrong this would deadlock."""
    result = run_untrusted("print('y' * 300000)")
    assert result.ok
    assert len(result.stdout) >= 300000


def test_process_creation_is_capped() -> None:
    """``NPROC`` is a per-uid limit, so a thread bomb gets EAGAIN rather than
    a worker with 10,000 threads."""
    result = run_untrusted("import os\nos.fork()")
    assert result.status == "denied_import"


def test_project_tier_gets_ten_cpu_seconds() -> None:
    assert SandboxLimits.for_project().cpu_seconds == 10
    assert SandboxLimits.for_project().wall_clock == 30.0


# --------------------------------------------------------------------------
# Isolation
# --------------------------------------------------------------------------


def test_the_environment_is_empty() -> None:
    """No PATH, no HOME, no service credentials, no OTel endpoint."""
    result = run_untrusted(
        "import numpy\n"
        "RESULT = sorted(numpy.__name__ for _ in [0])",
        capture=(),
    )
    assert result.ok
    # The only way to observe the environment is through a denied module, which
    # is itself the assertion: os is unreachable, so os.environ is unreachable.
    denied = run_untrusted("import os\nRESULT = dict(os.environ)")
    assert denied.status == "denied_import"


def test_the_parent_process_is_unaffected_by_the_child() -> None:
    """The child sets its own rlimits; the worker must keep serving requests."""
    import resource

    before = resource.getrlimit(resource.RLIMIT_AS)
    run_untrusted("x = 1", limits=SandboxLimits(address_space_bytes=64 * 1024 * 1024))
    assert resource.getrlimit(resource.RLIMIT_AS) == before


def test_the_parent_working_directory_is_restored() -> None:
    import os

    before = os.getcwd()
    run_untrusted("x = 1")
    assert os.getcwd() == before


def test_repeated_runs_do_not_leak_state() -> None:
    first = run_untrusted("SHARED = 1\nRESULT = 'first'")
    second = run_untrusted("RESULT = 'SHARED' in dir()")
    assert first.captured["RESULT"] == "first"
    assert second.captured["RESULT"] is False


# --------------------------------------------------------------------------
# Circuit extraction
# --------------------------------------------------------------------------


def test_a_qiskit_circuit_can_be_lifted_out_of_a_submission() -> None:
    from app import backends as registry

    if not registry.is_available("aer"):
        pytest.skip("qiskit is not installed")
    result = run_and_extract_circuit(
        "from qiskit import QuantumCircuit\n"
        "qc = QuantumCircuit(2)\n"
        "qc.h(0)\n"
        "qc.cx(0, 1)\n"
    )
    assert result.ok, result.error
    payload = result.captured["RESULT"]
    assert payload["kind"] == "circuit"
    dialect, ir = payload["payload"]
    assert dialect == "qiskit"
    assert ir["qubits"] == 2
    assert [o["gate"] for o in ir["ops"]] == ["h", "cx"]


def test_extraction_reverses_the_qiskit_wires() -> None:
    """The learner wrote Qiskit, where wire 0 is the least significant bit, so
    ``qc.h(0)`` is a Hadamard on *our* qubit ``n-1``."""
    from app import backends as registry

    if not registry.is_available("aer"):
        pytest.skip("qiskit is not installed")
    result = run_and_extract_circuit(
        "from qiskit import QuantumCircuit\nqc = QuantumCircuit(3)\nqc.h(0)\n"
    )
    _, ir = result.captured["RESULT"]["payload"]
    assert ir["ops"][0]["targets"] == [2]


def test_extraction_of_a_submission_with_no_circuit_is_not_an_error() -> None:
    result = run_and_extract_circuit("x = 1")
    assert result.ok
    assert result.captured["RESULT"]["payload"] == [None, None]


# --------------------------------------------------------------------------
# Attempted escapes
#
# One test per escape actually tried against this module during the security
# review of 2026-08-29, whether or not it worked. The ones that worked are
# marked with what they yielded; the fixes are in `app/sandbox.py`. Keeping the
# failed attempts alongside the successful ones is the point -- a regression
# here is silent otherwise, and "we tried that and it held" is only worth
# anything if the attempt is still being made.
#
# None of this makes the module a boundary. gVisor is the boundary (§10). What
# these assert is that the defence-in-depth layer costs an attacker more than
# two lines, which before the review it did not.
# --------------------------------------------------------------------------


#: The object-introspection walk out of the ``exec`` namespace to CPython's
#: real builtins. It still works and always will -- that is a property of
#: ``exec`` sandboxes, not a bug with a patch. Several tests below start from
#: it deliberately, to assert that what it yields is no longer useful.
_VIA_INTROSPECTION = (
    "def __get__(name):\n"
    "    for c in ().__class__.__mro__[-1].__subclasses__():\n"
    "        if c.__name__ == 'catch_warnings':\n"
    "            return c()._module.__builtins__['__import__'](name)\n"
)


def test_rebinding_dunder_name_does_not_defeat_the_import_guard() -> None:
    """The escape the review opened with, and it was two lines.

    The guard used to read ``__name__`` out of the globals CPython hands
    ``__import__`` and skip the allowlist when it was not the sandbox's. But
    ``__name__`` is an ordinary entry in the learner's own globals dict, so
    assigning to it made every later import look like NumPy importing its own
    dependencies. It yielded ``os``, and from there ``os.getuid()``,
    ``socket.connect`` to the internet, and the filesystem.
    """
    result = run_untrusted(
        "__name__ = 'numpy'\n"
        "import os\n"
        "RESULT = os.getcwd()\n"
    )
    assert result.status == "denied_import", result.error
    assert "'os'" in (result.error or "")


def test_calling_import_with_a_forged_globals_dict_is_refused() -> None:
    """The same spoof without even the assignment: the guarded ``__import__``
    is an ordinary callable, so the learner could pass whatever ``globals``
    they liked straight to it."""
    result = run_untrusted("os = __import__('os', {'__name__': 'numpy'})")
    assert result.status == "denied_import", result.error


def test_real_builtins_reached_through_an_allowed_module_cannot_open_a_file() -> None:
    """``typing`` is on the allowlist, and a module's ``__builtins__`` is the
    real builtins dict -- ``open``, ``eval``, the genuine ``__import__``. This
    walks around the replaced builtin entirely and always will; the audit hook
    is what stops it, on the operation rather than on the name."""
    result = run_untrusted(
        "import typing\n"
        "RESULT = typing.__builtins__['open']('/etc/passwd').read()\n"
    )
    assert result.status == "denied_operation", result.error
    assert "open" in (result.error or "")


def test_the_subclasses_walk_cannot_reach_the_filesystem() -> None:
    """The classic ``object.__subclasses__()`` walk to ``catch_warnings`` and
    out through its module's builtins. It still yields the real builtins --
    that cannot be fixed inside an ``exec`` sandbox -- so what is asserted is
    that what it yields is no longer useful."""
    result = run_untrusted(
        "for c in ().__class__.__mro__[-1].__subclasses__():\n"
        "    if c.__name__ == 'catch_warnings':\n"
        "        b = c()._module.__builtins__\n"
        "        RESULT = b['open']('/etc/passwd').read()\n"
        "        break\n"
    )
    assert result.status == "denied_operation", result.error


@pytest.mark.parametrize(
    ("name", "source"),
    [
        (
            "os.fork",
            "os = __get__('os')\nRESULT = os.fork()",
        ),
        (
            "os.system",
            "os = __get__('os')\nRESULT = os.system('touch /tmp/redquant-escape')",
        ),
        (
            "os.listdir",
            "os = __get__('os')\nRESULT = os.listdir('/')",
        ),
        (
            "os.open",
            "os = __get__('os')\nRESULT = os.read(os.open('/etc/passwd', 0), 16)",
        ),
        (
            "os.kill the parent",
            "os = __get__('os')\nRESULT = os.kill(os.getppid(), 9)",
        ),
        (
            "socket",
            "s = __get__('socket')\nRESULT = repr(s.socket())",
        ),
        (
            "subprocess",
            "sp = __get__('subprocess')\nRESULT = sp.run(['/bin/echo', 'x'])",
        ),
        (
            "shutil.copy",
            "sh = __get__('shutil')\n"
            "RESULT = sh.copy('/etc/passwd', '/tmp/redquant-escape')",
        ),
    ],
)
def test_a_module_taken_from_the_interpreter_cache_is_still_inert(
    name: str, source: str
) -> None:
    """The audit hook has to hold for modules the allowlist never saw.

    ``sys.modules`` already holds ``os``, ``socket`` and the rest -- this very
    module imported them -- and CPython raises the ``import`` audit event only
    on an actual load, so pulling a cached module out through the real
    ``__import__`` raises nothing at all. The policy therefore cannot live on
    the import; it lives on what the module is then asked to *do*.

    ``shutil.copy`` and ``socket.socket()`` in this list are not padding. Both
    were live escapes against the first version of the fix, because both are
    thin Python wrappers over a C call: the audit event fires from *their*
    frame, so a check that looked only at the innermost frame saw ``shutil.py``
    rather than ``<submission>`` and let them through. That is why the check
    walks the stack.
    """
    result = run_untrusted(_VIA_INTROSPECTION + source)
    assert result.status in ("denied_operation", "denied_import"), (
        f"{name} was not refused: {result.status} / {result.error} / "
        f"{result.captured}"
    )


def test_an_allowed_library_may_still_do_what_the_learner_may_not() -> None:
    """The other half of the audit hook: NumPy opens files, and has to go on
    being able to. A hook that refused every ``open`` would refuse
    ``import numpy``, which is the one import every lab needs."""
    result = run_untrusted(
        "import numpy as np\n"
        "RESULT = float(np.linalg.norm(np.arange(9).reshape(3, 3)))\n"
    )
    assert result.ok, result.error
    assert abs(result.captured["RESULT"] - 14.2828568570857) < 1e-9


def test_qiskit_still_imports_under_the_audit_hook() -> None:
    result = run_untrusted(
        "from qiskit import QuantumCircuit\n"
        "qc = QuantumCircuit(2)\n"
        "qc.h(0)\n"
        "qc.cx(0, 1)\n"
        "RESULT = qc.depth()\n"
    )
    assert result.ok, result.error
    assert result.captured["RESULT"] == 2


def test_introspection_alone_is_not_treated_as_an_escape() -> None:
    """``sys._getframe`` is introspection, not an effect. It was on the denied
    list briefly and took ``import numpy`` down with it, because
    ``collections.namedtuple`` calls it while the learner's ``import``
    statement is still on the stack."""
    result = run_untrusted(
        "for c in ().__class__.__mro__[-1].__subclasses__():\n"
        "    if c.__name__ == 'catch_warnings':\n"
        "        sysmod = c()._module.__builtins__['__import__']('sys')\n"
        "        RESULT = sysmod._getframe(0).f_code.co_filename\n"
        "        break\n"
    )
    assert result.ok, result.error
    assert result.captured["RESULT"] == "<submission>"


def test_the_parent_never_unpickles_the_childs_report() -> None:
    """The escalation that mattered most, and the one an escape made free.

    ``multiprocessing.Connection.send``/``recv`` is pickle on both ends, so the
    worker was calling ``pickle.loads`` on bytes produced inside the process
    whose entire job is to host hostile code. Anything that got far enough to
    write to that pipe -- and everything above got that far -- had arbitrary
    code execution in the *parent*, outside every limit this module applies.

    This drives the parent's reader directly with a pickle that would execute
    on load, because reproducing it through learner code no longer gets that
    far.
    """
    import pickle
    import struct

    ctx = multiprocessing.get_context("spawn")
    parent_conn, child_conn = ctx.Pipe(duplex=False)
    marker = tmp_path_marker = "/tmp/redquant-pickle-should-not-run"

    class _Detonator:
        def __reduce__(self) -> Any:
            import os as _os

            return (_os.system, (f"touch {marker}",))

    blob = pickle.dumps(_Detonator())
    # Exactly the framing `Connection.send` would have written.
    os.write(child_conn.fileno(), struct.pack("!i", len(blob)) + blob)

    decoded = _decode_payload(parent_conn.recv_bytes(_MAX_PAYLOAD_BYTES))
    assert decoded is None, "a pickle must not decode as a report"
    assert not os.path.exists(tmp_path_marker), "the pickle executed in the parent"

    parent_conn.close()
    child_conn.close()


def test_a_forged_report_cannot_smuggle_an_unexpected_shape() -> None:
    """A child that has escaped owns the file descriptor and can lie about the
    outcome; no validation changes that, which is why grading integrity rests
    on gVisor. What validation buys is that the lie stays a wrong answer rather
    than becoming a type the caller never expected."""
    assert _decode_payload(b'{"status": "root"}') is None
    assert _decode_payload(b"not json at all") is None
    assert _decode_payload(b'["ok"]') is None
    decoded = _decode_payload(
        b'{"status": "ok", "stdout": 5, "captured": "nope", "cpu_seconds": "x"}'
    )
    assert decoded is not None
    assert decoded["stdout"] == "" and decoded["captured"] == {}
    assert decoded["cpu_seconds"] == 0.0


def test_the_learner_cannot_raise_the_resource_limits_it_was_given() -> None:
    """Not an escape -- this one held from the start, and the test records
    that it did. ``_apply_limits`` sets the hard limit equal to the soft one
    (one second apart for CPU), and only a privileged process may raise a hard
    limit."""
    result = run_untrusted(
        _VIA_INTROSPECTION
        + "res = __get__('resource')\n"
        "out = {}\n"
        "for nm in ('RLIMIT_AS', 'RLIMIT_NPROC', 'RLIMIT_FSIZE'):\n"
        "    w = getattr(res, nm)\n"
        "    try:\n"
        "        res.setrlimit(w, (res.RLIM_INFINITY, res.RLIM_INFINITY))\n"
        "        out[nm] = 'raised'\n"
        "    except Exception as exc:\n"
        "        out[nm] = type(exc).__name__\n"
        "RESULT = out\n"
    )
    assert result.ok, result.error
    assert set(result.captured["RESULT"].values()) == {"ValueError"}


@pytest.mark.slow
def test_ignoring_sigterm_does_not_survive_the_wall_clock() -> None:
    """The wall-clock kill escalates to ``SIGKILL``, so a handler that eats
    ``SIGTERM`` buys half a second, not immortality."""
    result = run_untrusted(
        _VIA_INTROSPECTION
        + "sig = __get__('signal')\n"
        "sig.signal(sig.SIGTERM, sig.SIG_IGN)\n"
        "sig.signal(sig.SIGXCPU, sig.SIG_IGN)\n"
        "while True:\n"
        "    pass\n",
        limits=SandboxLimits(cpu_seconds=30, wall_clock_seconds=1.5),
    )
    assert result.status == "timeout", result.error


@pytest.mark.slow
def test_a_hard_cpu_kill_is_not_reported_as_a_memory_problem() -> None:
    """Swallowing ``SIGXCPU`` gets the process to the hard limit one second
    later, which arrives as ``SIGKILL`` -- indistinguishable from an OOM kill
    by signal alone. Elapsed time separates them, and saying "memory limit"
    here sent people optimising allocations for what was a timeout."""
    result = run_untrusted(
        "n = 0\n"
        "while True:\n"
        "    try:\n"
        "        for _ in range(10 ** 7):\n"
        "            n += 1\n"
        "    except BaseException:\n"
        "        pass\n",
        limits=SandboxLimits(cpu_seconds=1),
    )
    assert result.status == "cpu_limit", f"{result.status}: {result.error}"
    assert "CPU limit" in (result.error or "")


def test_the_documented_residue_is_still_reachable() -> None:
    """Honesty test. Some of the ``os`` surface raises no audit event at all --
    ``getuid``, ``getcwd``, ``stat`` -- so learner code that has walked out
    through introspection can still probe for a file's existence and read the
    scrubbed environment. That is the residue this layer does not close, and
    gVisor's read-only rootfs is what makes it uninteresting. If a future
    change closes it, this test should fail and be deleted."""
    result = run_untrusted(
        "for c in ().__class__.__mro__[-1].__subclasses__():\n"
        "    if c.__name__ == 'catch_warnings':\n"
        "        os = c()._module.__builtins__['__import__']('os')\n"
        "        break\n"
        "RESULT = {'environ': dict(os.environ), 'exists': os.path.exists('/etc')}\n"
    )
    assert result.ok, result.error
    assert result.captured["RESULT"]["exists"] is True
    # The environment scrub still holds: only the BLAS thread knobs survive.
    assert set(result.captured["RESULT"]["environ"]) == {
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
    }
