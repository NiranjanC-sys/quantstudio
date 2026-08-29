"""The HTTP surface: contracts, caps, caching and the shape of every response."""

from __future__ import annotations

import json
import math
import os
import time

import pytest

from app.main import (
    CACHE,
    MAX_REQUEST_BYTES,
    PLANS,
    Plan,
    PlanDenied,
    ResultCache,
    cache_key,
    enforce_plan,
    resolve_plan,
    write_openapi,
)
from app.backends.base import SimOptions
from app.ir import Circuit
from app.noise import NoiseModel
from tests.conftest import S2, bell, ghz

BELL_JSON = {
    "version": 1,
    "name": "bell",
    "qubits": 2,
    "clbits": 2,
    "ops": [
        {"id": "a", "gate": "h", "targets": [0]},
        {"id": "b", "gate": "x", "targets": [1], "controls": [0]},
        {"id": "c", "gate": "measure", "targets": [0], "cbits": [0]},
    ],
}


# --------------------------------------------------------------------------
# Health and introspection
# --------------------------------------------------------------------------


def test_healthz_is_cheap_and_says_who_it_is(client) -> None:
    body = client.get("/healthz").json()
    assert body["status"] == "ok" and body["service"] == "quantum-kernel"


def test_readyz_actually_simulates(client) -> None:
    response = client.get("/readyz")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["backends"]["native"] is True


def test_metrics_exposes_the_domain_signals(client) -> None:
    client.post("/v1/simulate", json={"circuit": BELL_JSON})
    text = client.get("/metrics").text
    for name in ("sim_cache_hit_ratio", "sim_queue_depth", "kernel_requests_total"):
        assert name in text, f"{name} is missing from the exposition"


def test_backends_lists_every_engine_and_the_convention(client) -> None:
    body = client.get("/v1/backends").json()
    names = {b["name"] for b in body["backends"]}
    assert names == {"native", "density", "aer", "cirq", "pennylane"}
    assert any(b["name"] == "native" and b["available"] for b in body["backends"])
    assert "most significant bit" in body["convention"]
    assert body["plans"]["free"]["maxQubits"] == 16
    assert body["devices"] and body["dialects"]


def test_every_response_carries_a_request_id(client) -> None:
    response = client.get("/healthz", headers={"X-Request-Id": "abc123"})
    assert response.headers["x-request-id"] == "abc123"
    generated = client.get("/healthz").headers["x-request-id"]
    assert len(generated) == 32


# --------------------------------------------------------------------------
# Simulation
# --------------------------------------------------------------------------


def test_simulate_returns_the_bell_distribution(client) -> None:
    response = client.post(
        "/v1/simulate", json={"circuit": BELL_JSON, "options": {"shots": 512, "seed": 1}}
    )
    assert response.status_code == 200
    body = response.json()
    probs = body["result"]["probabilities"]
    assert probs[0] == pytest.approx(0.5) and probs[3] == pytest.approx(0.5)
    assert probs[1] == 0.0 and probs[2] == 0.0
    assert body["backend"] == "native"
    assert body["circuitHash"] and len(body["circuitHash"]) == 16
    assert sum(body["result"]["counts"].values()) == 512
    assert body["result"]["countsKind"] == "clbits"


def test_statevector_is_interleaved_re_im(client) -> None:
    body = client.post("/v1/simulate", json={"circuit": BELL_JSON}).json()
    flat = body["result"]["statevector"]
    assert len(flat) == 8
    assert flat[0] == pytest.approx(S2) and flat[1] == 0.0


def test_simulate_reports_metrics_and_bloch(client) -> None:
    body = client.post("/v1/simulate", json={"circuit": BELL_JSON}).json()
    assert body["metrics"]["twoQubitGates"] == 1
    assert len(body["result"]["bloch"]) == 2
    assert body["result"]["bloch"][0]["purity"] < 1e-9, "an entangled qubit is mixed"


def test_the_cache_serves_the_second_identical_request(client) -> None:
    payload = {"circuit": BELL_JSON, "options": {"shots": 64, "seed": 3}}
    first = client.post("/v1/simulate", json=payload).json()
    second = client.post("/v1/simulate", json=payload).json()
    assert first["cached"] is False and second["cached"] is True
    assert first["result"]["probabilities"] == second["result"]["probabilities"]


def test_commuting_reorder_hits_the_same_cache_entry(client) -> None:
    """Canonicalisation is what makes one lesson's traffic collapse to one entry."""
    a = {
        "version": 1, "qubits": 2, "clbits": 0,
        "ops": [{"gate": "h", "targets": [0]}, {"gate": "x", "targets": [1]}],
    }
    b = {
        "version": 1, "qubits": 2, "clbits": 0,
        "ops": [{"gate": "x", "targets": [1]}, {"gate": "h", "targets": [0]}],
    }
    assert client.post("/v1/simulate", json={"circuit": a}).json()["cached"] is False
    assert client.post("/v1/simulate", json={"circuit": b}).json()["cached"] is True


def test_a_different_seed_is_a_different_cache_entry(client) -> None:
    base = {"circuit": BELL_JSON, "options": {"shots": 64, "seed": 1}}
    other = {"circuit": BELL_JSON, "options": {"shots": 64, "seed": 2}}
    client.post("/v1/simulate", json=base)
    assert client.post("/v1/simulate", json=other).json()["cached"] is False


def test_invalid_circuit_is_a_422_with_the_issues(client) -> None:
    bad = {"version": 1, "qubits": 1, "ops": [{"gate": "h", "targets": [9]}]}
    response = client.post("/v1/simulate", json={"circuit": bad})
    assert response.status_code == 422
    body = response.json()
    assert body["error"] == "invalid_circuit"
    assert body["issues"] and "out of range" in body["issues"][0]["message"]


def test_unknown_gate_is_a_422(client) -> None:
    bad = {"version": 1, "qubits": 1, "ops": [{"gate": "frobnicate", "targets": [0]}]}
    assert client.post("/v1/simulate", json={"circuit": bad}).status_code == 422


def test_visual_payload_is_returned_on_request(client) -> None:
    body = client.post(
        "/v1/simulate", json={"circuit": BELL_JSON, "include_visual": True}
    ).json()
    visual = body["visual"]
    assert visual is not None
    assert len(visual["bloch"]) == 2
    assert {p["label"] for p in visual["qsphere"]} == {"00", "11"}
    assert visual["entanglement"]["edges"][0]["concurrence"] == pytest.approx(1.0, abs=1e-6)


def test_visual_is_omitted_by_default(client) -> None:
    body = client.post("/v1/simulate", json={"circuit": BELL_JSON}).json()
    assert body.get("visual") is None


# --------------------------------------------------------------------------
# Plans
# --------------------------------------------------------------------------


def big_circuit(n: int) -> dict:
    return {
        "version": 1,
        "qubits": n,
        "clbits": 0,
        "ops": [{"gate": "h", "targets": [q]} for q in range(n)],
    }


def test_free_plan_refuses_a_twenty_qubit_circuit(client) -> None:
    response = client.post(
        "/v1/simulate",
        json={"circuit": big_circuit(20)},
        headers={"X-RedQuant-Plan": "free"},
    )
    assert response.status_code == 402
    assert response.json()["error"] == "plan_limit"
    assert "free plan allows 16 qubits" in response.json()["message"]


def test_pro_plan_allows_it(client) -> None:
    response = client.post(
        "/v1/simulate",
        json={"circuit": big_circuit(18), "options": {"return_statevector": False}},
        headers={"X-RedQuant-Plan": "pro"},
    )
    assert response.status_code == 200


def test_an_unknown_plan_header_falls_back_to_free(client) -> None:
    assert resolve_plan("enterprise-platinum").name == "free"
    assert resolve_plan(None).name == "free"
    assert resolve_plan("PRO").name == "pro"


def test_noisy_simulation_is_not_in_the_free_plan(client) -> None:
    response = client.post(
        "/v1/simulate",
        json={"circuit": BELL_JSON, "options": {"noise": {"depolarizing1": 0.01}}},
        headers={"X-RedQuant-Plan": "free"},
    )
    assert response.status_code == 402
    assert "not included in the free plan" in response.json()["message"]


def test_plan_refuses_rather_than_silently_shrinking() -> None:
    """Silently clamping would make one circuit grade differently per tier."""
    circuit = Circuit.model_validate(big_circuit(4))
    with pytest.raises(PlanDenied, match="8192 shots"):
        enforce_plan(PLANS["free"], circuit, SimOptions(shots=100_000))


def test_plan_ceilings_match_the_design_table() -> None:
    assert PLANS["free"].max_qubits == 16
    assert PLANS["pro"].max_qubits == 28
    assert PLANS["teams"].max_qubits == 30
    assert PLANS["campus"].max_qubits == 32
    assert PLANS["pro"].max_noisy_qubits == 12
    assert PLANS["teams"].max_noisy_qubits == 14
    assert PLANS["free"].max_noisy_qubits == 0


# --------------------------------------------------------------------------
# Async jobs
# --------------------------------------------------------------------------


def test_async_job_runs_to_completion(client) -> None:
    response = client.post(
        "/v1/simulate/async",
        json={"circuit": BELL_JSON, "options": {"shots": 32, "seed": 1}},
        headers={"X-RedQuant-Plan": "pro"},
    )
    assert response.status_code == 202
    job_id = response.json()["jobId"]
    assert response.json()["pollUrl"] == f"/v1/jobs/{job_id}"

    for _ in range(200):
        body = client.get(f"/v1/jobs/{job_id}").json()
        if body["state"] in ("succeeded", "failed"):
            break
        time.sleep(0.02)
    assert body["state"] == "succeeded", body.get("error")
    assert body["result"]["result"]["probabilities"][0] == pytest.approx(0.5)
    assert body["durationMs"] is not None


def test_async_is_not_in_the_free_plan(client) -> None:
    response = client.post(
        "/v1/simulate/async", json={"circuit": BELL_JSON}, headers={"X-RedQuant-Plan": "free"}
    )
    assert response.status_code == 402


def test_unknown_job_is_a_404_that_explains_itself(client) -> None:
    response = client.get("/v1/jobs/deadbeef")
    assert response.status_code == 404
    assert "pod-local" in response.json()["message"]


def test_async_validates_before_enqueuing(client) -> None:
    bad = {"version": 1, "qubits": 1, "ops": [{"gate": "h", "targets": [4]}]}
    response = client.post(
        "/v1/simulate/async", json={"circuit": bad}, headers={"X-RedQuant-Plan": "pro"}
    )
    assert response.status_code == 422


# --------------------------------------------------------------------------
# Transpile, grade, convert, execute
# --------------------------------------------------------------------------


def test_transpile_reports_before_and_after(client) -> None:
    body = client.post(
        "/v1/transpile",
        json={"circuit": BELL_JSON, "target": {"basis": "ibm", "layout": "none", "route": False}},
    ).json()
    assert body["before"]["size"] == 3  # h, cx and the measurement
    assert body["after"]["size"] >= 3
    assert "decompose" in body["passes"]
    assert set(body["basis"]) == {"rz", "sx", "x", "cx"}
    assert "delta" in body


def test_transpile_can_verify_equivalence(client) -> None:
    circuit = {
        "version": 1, "qubits": 2, "clbits": 0,
        "ops": [{"gate": "h", "targets": [0]}, {"gate": "cx", "targets": [0, 1]}],
    }
    body = client.post(
        "/v1/transpile",
        json={
            "circuit": circuit,
            "target": {"basis": "ibm", "layout": "none", "route": False},
            "verify": True,
        },
    ).json()
    assert body["verification"]["checked"] is True
    assert body["verification"]["equivalent"] is True


def test_transpile_for_an_unknown_device_lists_the_real_ones(client) -> None:
    response = client.post(
        "/v1/transpile", json={"circuit": BELL_JSON, "target": {"device": "ibm_imaginary"}}
    )
    assert response.status_code == 400
    assert response.json()["knownDevices"]


def test_grade_scores_a_submission(client) -> None:
    body = client.post(
        "/v1/grade",
        json={
            "circuit": BELL_JSON,
            "assertions": [
                {"kind": "statevector_equals", "expected": {"00": [S2, 0.0], "11": [S2, 0.0]}},
                {"kind": "gate_set_subset", "allowed": ["h"]},
            ],
        },
    ).json()
    assert body["score"] == 1.0 and body["maxScore"] == 2.0
    assert body["passed"] is False
    assert body["assertions"][0]["passed"] is True
    assert "uses x" in body["assertions"][1]["message"]


def test_grade_rejects_an_unknown_assertion_kind(client) -> None:
    response = client.post(
        "/v1/grade",
        json={"circuit": BELL_JSON, "assertions": [{"kind": "vibes_check"}]},
    )
    assert response.status_code == 422


def test_convert_emits_every_dialect(client) -> None:
    body = client.post(
        "/v1/convert",
        json={"circuit": BELL_JSON, "dialects": ["qasm3", "qiskit", "cirq", "pennylane"]},
    ).json()
    assert set(body["sources"]) == {"qasm3", "qiskit", "cirq", "pennylane"}
    assert body["failures"] == {}
    assert "OPENQASM 3.0;" in body["sources"]["qasm3"]


def test_convert_parses_qasm_back_to_ir(client) -> None:
    qasm = client.post(
        "/v1/convert", json={"circuit": BELL_JSON, "dialects": ["qasm3"]}
    ).json()["sources"]["qasm3"]
    body = client.post("/v1/convert", json={"qasm": qasm}).json()
    assert body["circuit"]["qubits"] == 2
    assert [o["gate"] for o in body["circuit"]["ops"]] == ["h", "cx", "measure"]


def test_convert_needs_exactly_one_input(client) -> None:
    assert client.post("/v1/convert", json={}).status_code == 400
    assert (
        client.post("/v1/convert", json={"circuit": BELL_JSON, "qasm": "qubit[1] q;"}).status_code
        == 400
    )


def test_convert_rejects_an_unknown_dialect(client) -> None:
    response = client.post("/v1/convert", json={"circuit": BELL_JSON, "dialects": ["brainfuck"]})
    assert response.status_code == 400
    assert response.json()["knownDialects"]


def test_convert_reports_malformed_qasm(client) -> None:
    response = client.post("/v1/convert", json={"qasm": "this is not qasm"})
    assert response.status_code == 422


def test_execute_runs_learner_code(client) -> None:
    body = client.post(
        "/v1/execute", json={"source": "print('hi')\nRESULT = 2 + 2", "extract_circuit": False}
    ).json()
    assert body["status"] == "ok" and body["ok"] is True
    assert body["stdout"] == "hi\n"
    assert body["captured"]["RESULT"] == 4


def test_execute_refuses_a_denied_import(client) -> None:
    body = client.post("/v1/execute", json={"source": "import os"}).json()
    assert body["status"] == "denied_import"
    assert "'os'" in body["error"]


def test_execute_returns_the_learners_circuit_as_ir(client) -> None:
    from app import backends as registry

    if not registry.is_available("aer"):
        pytest.skip("qiskit is not installed")
    body = client.post(
        "/v1/execute",
        json={
            "source": "from qiskit import QuantumCircuit\nqc = QuantumCircuit(2)\nqc.h(0)\nqc.cx(0,1)"
        },
    ).json()
    assert body["status"] == "ok"
    assert body["circuit"]["qubits"] == 2
    assert [o["gate"] for o in body["circuit"]["ops"]] == ["h", "cx"]


def test_execute_source_is_length_limited(client) -> None:
    response = client.post("/v1/execute", json={"source": "x = 1\n" * 100_000})
    assert response.status_code == 422


# --------------------------------------------------------------------------
# Request limits, cache internals, OpenAPI
# --------------------------------------------------------------------------


def test_an_oversized_body_is_refused_before_parsing(client) -> None:
    response = client.post(
        "/v1/simulate",
        json={"circuit": BELL_JSON},
        headers={"Content-Length": str(MAX_REQUEST_BYTES + 1)},
    )
    assert response.status_code == 413
    assert response.json()["error"] == "request_too_large"


def test_cache_is_lru_and_bounded() -> None:
    cache = ResultCache(capacity=2)
    cache.put("a", {"v": 1})
    cache.put("b", {"v": 2})
    assert cache.get("a") == {"v": 1}  # refreshes 'a'
    cache.put("c", {"v": 3})
    assert len(cache) == 2
    assert cache.get("b") is None, "the least recently used entry must be evicted"
    assert cache.get("a") is not None


def test_cache_key_covers_everything_the_design_lists() -> None:
    circuit = bell()
    base = SimOptions(shots=100, seed=1)
    assert cache_key(circuit, "native", base) == cache_key(circuit, "native", base)
    assert cache_key(circuit, "native", base) != cache_key(circuit, "aer", base)
    assert cache_key(circuit, "native", base) != cache_key(
        circuit, "native", base.model_copy(update={"shots": 200})
    )
    assert cache_key(circuit, "native", base) != cache_key(
        circuit, "native", base.model_copy(update={"seed": 2})
    )
    assert cache_key(circuit, "native", base) != cache_key(
        circuit, "native", base.model_copy(update={"noise": NoiseModel(depolarizing1=0.1)})
    )
    assert cache_key(circuit, "native", base) != cache_key(ghz(3), "native", base)


def test_openapi_is_written_to_disk(tmp_path) -> None:
    """Section 3: the TypeScript/Python contract is generated, never hand-kept."""
    from app.main import app

    path = write_openapi(app, str(tmp_path / "openapi.json"))
    document = json.loads(open(path).read())
    assert document["info"]["title"] == "RedQuant quantum-kernel"
    for route in (
        "/v1/simulate", "/v1/simulate/async", "/v1/jobs/{job_id}", "/v1/transpile",
        "/v1/grade", "/v1/execute", "/v1/convert", "/v1/backends", "/healthz", "/readyz",
    ):
        assert route in document["paths"], f"{route} is missing from the schema"


def test_openapi_lands_in_the_repository_at_startup(client) -> None:
    from app.main import OPENAPI_PATH

    assert os.path.exists(OPENAPI_PATH), "the lifespan must write the contract to disk"


def test_the_app_can_be_started_more_than_once_in_a_process(client) -> None:
    """A ThreadPoolExecutor cannot be restarted, and the job store is a
    module-level singleton the lifespan shuts down. The pool is therefore
    built lazily -- otherwise the second startup in a process (every test
    after the first, and every ``uvicorn --reload`` save) could not enqueue."""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as second:
        response = second.post(
            "/v1/simulate/async",
            json={"circuit": BELL_JSON},
            headers={"X-RedQuant-Plan": "pro"},
        )
        assert response.status_code == 202
