'use client';

/**
 * Tier B and C of the simulation design, exposed in the lab.
 *
 * The browser handles up to 14 qubits with no round trip. This panel is how a
 * learner goes past that, runs a density matrix, or checks the same circuit on
 * Aer, Cirq and PennyLane to see that they agree. Which is the point: the
 * cross-SDK comparison is a lesson, not a convenience.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { metrics } from '@redquant/qir';
import { useCircuit } from '@/lib/circuit-store';
import {
  listBackends, probabilityRows, simulateOnServer,
  type KernelBackend, type KernelBackendInfo, type KernelResponse,
} from '@/lib/kernel';

type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; res: KernelResponse }
  | { kind: 'failed'; detail: string; kindOf: 'plan' | 'auth' | 'network' | 'server' };

export function ServerRun() {
  const circuit = useCircuit((s) => s.circuit);
  const shots = useCircuit((s) => s.shots);
  const seed = useCircuit((s) => s.seed);
  const bindings = useCircuit((s) => s.bindings);
  const noiseEnabled = useCircuit((s) => s.noiseEnabled);
  const noise = useCircuit((s) => s.noise);

  const [backends, setBackends] = useState<KernelBackendInfo[] | null>(null);
  const [backend, setBackend] = useState<KernelBackend>('native');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    void listBackends().then((b) => { if (live) setBackends(b); });
    return () => { live = false; };
  }, []);

  const run = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ kind: 'running' });
    const out = await simulateOnServer(circuit, {
      backend, shots, seed, bindings,
      ...(noiseEnabled ? { noise } : {}),
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    setState(out.ok
      ? { kind: 'done', res: out.data }
      : { kind: 'failed', detail: out.detail, kindOf: out.kind });
  }, [circuit, backend, shots, seed, bindings, noiseEnabled, noise]);

  const available = backends?.filter((b) => b.available) ?? [];
  const offline = backends !== null && available.length === 0;
  const stats = metrics(circuit);

  return (
    <div className="rq-server">
      <header className="rq-panel-head">
        <span className="rq-eyebrow">Server backends</span>
        <div className="rq-panel-actions">
          <select
            className="rq-input"
            aria-label="Simulation backend"
            value={backend}
            onChange={(e) => setBackend(e.target.value as KernelBackend)}
            disabled={offline}
          >
            {(available.length ? available : [{ name: 'native', maxQubits: 30 } as KernelBackendInfo]).map((b) => (
              <option key={b.name} value={b.name}>
                {b.name} {b.maxQubits ? `(max ${b.maxQubits}q)` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rq-btn rq-btn-primary rq-btn-sm"
            onClick={() => void run()}
            disabled={state.kind === 'running' || offline}
          >
            {state.kind === 'running' ? 'Running...' : 'Run'}
          </button>
        </div>
      </header>

      <div className="rq-server-body" tabIndex={0} role="region" aria-label="Server run output">
        {offline && (
          <p className="rq-remote rq-remote-error">
            No server backends are reachable. The gateway proxies to the kernel, so both need to
            be running: <code className="rq-lesson-code">pnpm --filter @redquant/api dev</code> and{' '}
            <code className="rq-lesson-code">
              cd apps/quantum-kernel &amp;&amp; .venv/bin/uvicorn app.main:app --port 8100
            </code>
            . The browser engine still handles up to 14 qubits without either.
          </p>
        )}

        {!offline && state.kind === 'idle' && (
          <p className="rq-empty">
            {stats.qubits} qubits, depth {stats.depth}. The browser engine covers up to 14 qubits;
            run here for larger circuits, a density matrix, or to check that Aer, Cirq and PennyLane
            agree.
          </p>
        )}

        {state.kind === 'running' && <p className="rq-remote rq-remote-loading">Simulating on the server...</p>}

        {state.kind === 'failed' && (
          <>
            <div
              className={`rq-verdict ${state.kindOf === 'plan' || state.kindOf === 'auth' ? 'rq-verdict-warn' : 'rq-verdict-error'}`}
              role="status"
            >
              <span className="rq-mono">{state.detail}</span>
            </div>
            {state.kindOf === 'auth' && (
              <p className="rq-note rq-note-plain">
                <a className="rq-lesson-a" href="/login">Sign in</a> to run on the server. The browser
                engine keeps working up to 14 qubits either way.
              </p>
            )}
            {state.kindOf === 'plan' && (
              <p className="rq-note rq-note-plain">
                <a className="rq-lesson-a" href="/pricing">Compare plans</a> for higher qubit ceilings.
              </p>
            )}
          </>
        )}

        {state.kind === 'done' && <ServerResult res={state.res} />}
      </div>
    </div>
  );
}

function ServerResult({ res }: { res: KernelResponse }) {
  const r = res.result;
  const rows = probabilityRows(r, 32);
  const total = r.counts ? Object.values(r.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      <ul className="rq-server-stats">
        <li><span>backend</span><span className="rq-numeric">{r.backend}</span></li>
        <li><span>method</span><span className="rq-numeric">{r.method}</span></li>
        <li><span>qubits</span><span className="rq-numeric">{r.qubits}</span></li>
        <li><span>wall</span><span className="rq-numeric">{(r.timings.totalMs ?? 0).toFixed(0)} ms</span></li>
        <li><span>cached</span><span className="rq-numeric">{res.cached ? 'yes' : 'no'}</span></li>
        <li><span>hash</span><span className="rq-numeric">{res.circuitHash.slice(0, 10)}</span></li>
      </ul>

      {r.probabilitiesTruncated && (
        <p className="rq-note rq-note-plain">
          Showing the {rows.length} largest amplitudes. The remaining basis states hold{' '}
          <span className="rq-numeric">{((r.probabilitiesResidual ?? 0) * 100).toFixed(4)}%</span> of the
          probability between them, so the full vector is not transferred.
        </p>
      )}

      <table className="rq-amp-table">
        <caption className="rq-sr-only">Largest amplitudes from the server run</caption>
        <thead>
          <tr>
            <th scope="col">state</th>
            {r.statevector ? <th scope="col">amplitude</th> : null}
            <th scope="col">probability</th>
            {r.counts ? <th scope="col">counts</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const label = row.index.toString(2).padStart(r.qubits, '0');
            return (
              <tr key={row.index}>
                <th scope="row" className="rq-mono">|{label}⟩</th>
                {r.statevector ? (
                  <td className="rq-numeric">
                    {(row.re ?? 0).toFixed(4)}
                    {(row.im ?? 0) >= 0 ? ' + ' : ' - '}
                    {Math.abs(row.im ?? 0).toFixed(4)}i
                  </td>
                ) : null}
                <td>
                  <span className="rq-bar-wrap">
                    <span className="rq-bar" style={{ width: `${row.p * 100}%` }} />
                    <span className="rq-numeric rq-bar-value">{(row.p * 100).toFixed(2)}%</span>
                  </span>
                </td>
                {r.counts ? (
                  <td className="rq-numeric">{r.counts[label] ?? 0}</td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>

      {r.warnings.length > 0 && (
        <ul className="rq-server-warnings">
          {r.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      {total > 0 && <p className="rq-note rq-note-plain">{total.toLocaleString('en')} shots sampled.</p>}
    </>
  );
}
