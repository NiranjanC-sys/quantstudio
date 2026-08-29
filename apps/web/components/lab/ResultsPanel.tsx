'use client';

/**
 * What the circuit actually did.
 *
 * Amplitudes are shown with magnitude as bar length and phase as a disc filled
 * from the cyclic colormap, because phase is the half of the state that a bare
 * probability histogram throws away, and every algorithm in the curriculum runs
 * on phase.
 */

import { useMemo, useState } from 'react';
import type { SimResult } from '@redquant/qir';
import { useCircuit } from '@/lib/circuit-store';
import { BlochSphere } from '@/components/instruments/BlochSphere';

type Tab = 'amplitudes' | 'probabilities' | 'bloch' | 'counts';

export function ResultsPanel() {
  const result = useCircuit((s) => s.result);
  const simError = useCircuit((s) => s.simError);
  const simMs = useCircuit((s) => s.simMs);
  const stats = useCircuit((s) => s.stats);
  const [tab, setTab] = useState<Tab>('amplitudes');

  return (
    <div className="rq-results">
      <header className="rq-panel-head">
        <span className="rq-eyebrow">State</span>
        <div className="rq-tabs" role="tablist" aria-label="Result view">
          {(['amplitudes', 'probabilities', 'bloch', 'counts'] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`rq-tab${tab === t ? ' is-active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </header>

      {simError ? (
        <div className="rq-verdict rq-verdict-error" role="status">
          <span className="rq-mono">{simError}</span>
        </div>
      ) : result ? (
        <>
          <div className="rq-results-body">
            {tab === 'amplitudes' && <Amplitudes result={result} />}
            {tab === 'probabilities' && <Probabilities result={result} />}
            {tab === 'bloch' && <BlochGrid result={result} />}
            {tab === 'counts' && <Counts result={result} />}
          </div>
          <footer className="rq-results-foot">
            <Stat label="qubits" value={stats.qubits} />
            <Stat label="depth" value={stats.depth} />
            <Stat label="gates" value={stats.size} />
            <Stat label="2q" value={stats.twoQubitGates} />
            <Stat label="T" value={stats.tCount} />
            <Stat label="clifford" value={stats.clifford ? 'yes' : 'no'} />
            <Stat label="sim" value={`${simMs.toFixed(1)} ms`} />
          </footer>
        </>
      ) : (
        <p className="rq-empty">Nothing to show yet.</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="rq-stat">
      <span className="rq-stat-label">{label}</span>
      <span className="rq-numeric">{value}</span>
    </span>
  );
}

/** Cyclic phase colormap from DESIGN.md, interpolated in sRGB stops. */
const PHASE_STOPS = ['#5B8FF0', '#3FBFA8', '#9BD146', '#F2C230', '#F2703A', '#D6539E', '#7B5BD6', '#5B8FF0'];

export function phaseColor(radians: number): string {
  const twoPi = Math.PI * 2;
  let t = radians % twoPi;
  if (t < 0) t += twoPi;
  const scaled = (t / twoPi) * (PHASE_STOPS.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  const a = hexToRgb(PHASE_STOPS[i]!);
  const b = hexToRgb(PHASE_STOPS[Math.min(i + 1, PHASE_STOPS.length - 1)]!);
  const mix = a.map((v, k) => Math.round(v + (b[k]! - v) * f));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function hexToRgb(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const MAX_ROWS = 64;

function Amplitudes({ result }: { result: SimResult }) {
  const rows = useMemo(() => {
    const sv = result.statevector;
    const n = result.qubits;
    const out: { basis: string; re: number; im: number; prob: number; phase: number }[] = [];
    for (let i = 0; i < result.probabilities.length; i++) {
      const p = result.probabilities[i]!;
      if (p < 1e-12) continue;
      const re = sv ? sv[2 * i]! : Math.sqrt(p);
      const im = sv ? sv[2 * i + 1]! : 0;
      out.push({ basis: i.toString(2).padStart(n, '0'), re, im, prob: p, phase: Math.atan2(im, re) });
    }
    return out.sort((a, b) => b.prob - a.prob).slice(0, MAX_ROWS);
  }, [result]);

  if (!result.statevector) {
    return (
      <p className="rq-note">
        This run was stochastic, so there is no single statevector. Magnitudes below come from the
        averaged distribution over {result.trajectories} trajectories, and phase is not observable.
      </p>
    );
  }

  return (
    <table className="rq-amp-table">
      <caption className="rq-sr-only">Amplitudes by basis state, largest first</caption>
      <thead>
        <tr>
          <th scope="col">state</th>
          <th scope="col">amplitude</th>
          <th scope="col">probability</th>
          <th scope="col">phase</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.basis}>
            <th scope="row" className="rq-mono">|{r.basis}⟩</th>
            <td className="rq-numeric">
              {r.re.toFixed(4)}
              {r.im >= 0 ? ' + ' : ' - '}
              {Math.abs(r.im).toFixed(4)}i
            </td>
            <td>
              <span className="rq-bar-wrap">
                <span className="rq-bar" style={{ width: `${r.prob * 100}%` }} />
                <span className="rq-numeric rq-bar-value">{(r.prob * 100).toFixed(2)}%</span>
              </span>
            </td>
            <td>
              <span
                className="rq-phase-disc"
                style={{ background: phaseColor(r.phase) }}
                title={`${(r.phase / Math.PI).toFixed(3)} pi`}
              >
                <span
                  className="rq-phase-tick"
                  style={{ transform: `rotate(${(r.phase * 180) / Math.PI}deg)` }}
                />
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Probabilities({ result }: { result: SimResult }) {
  const n = result.qubits;
  const rows = Array.from(result.probabilities)
    .map((p, i) => ({ basis: i.toString(2).padStart(n, '0'), p }))
    .filter((r) => r.p > 1e-12)
    .sort((a, b) => b.p - a.p)
    .slice(0, MAX_ROWS);
  return (
    <ul className="rq-prob-list">
      {rows.map((r) => (
        <li key={r.basis}>
          <span className="rq-mono">|{r.basis}⟩</span>
          <span className="rq-bar-wrap">
            <span className="rq-bar" style={{ width: `${r.p * 100}%` }} />
          </span>
          <span className="rq-numeric">{(r.p * 100).toFixed(2)}%</span>
        </li>
      ))}
    </ul>
  );
}

function BlochGrid({ result }: { result: SimResult }) {
  return (
    <div className="rq-bloch-grid">
      {result.bloch.map((b, q) => (
        <BlochSphere
          key={q}
          vector={b}
          purity={b.purity}
          label={`q${q}${b.purity < 0.999 ? ` (r = ${b.purity.toFixed(3)})` : ''}`}
          size={200}
        />
      ))}
    </div>
  );
}

function Counts({ result }: { result: SimResult }) {
  if (!result.counts) return <p className="rq-empty">Set a shot count above zero to sample outcomes.</p>;
  const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
  const rows = Object.entries(result.counts).sort((a, b) => b[1] - a[1]).slice(0, MAX_ROWS);
  return (
    <ul className="rq-prob-list">
      {rows.map(([k, v]) => {
        const p = v / total;
        // One standard deviation of a binomial proportion, the honest error bar.
        const sigma = Math.sqrt((p * (1 - p)) / total);
        return (
          <li key={k}>
            <span className="rq-mono">{k}</span>
            <span className="rq-bar-wrap">
              <span className="rq-bar" style={{ width: `${p * 100}%` }} />
            </span>
            <span className="rq-numeric">
              {v} <span className="rq-dim">± {(sigma * total).toFixed(0)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
