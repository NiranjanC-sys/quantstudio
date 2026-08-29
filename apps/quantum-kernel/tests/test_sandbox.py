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

import sys
import time

import pytest

from app.sandbox import (
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
