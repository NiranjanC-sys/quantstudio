'use client';

/**
 * An embedded circuit inside a lesson.
 *
 * This is the same simulator the lab runs, so a lesson can never state a
 * number the product disagrees with: the figure is computed at read time from
 * the IR in the page. It renders as an inset Instrument panel with its own
 * ground, visibly framed, so it does not bleed into the Monograph prose.
 */

import { useMemo, useState } from 'react';
import {
  simulate, metrics, toQasm3, type Circuit, type SimResult,
} from '@redquant/qir';
import { BlochSphere } from '@/components/instruments/BlochSphere';
import { phaseColor } from '@/components/lab/ResultsPanel';

export interface LessonCircuitProps {
  /** The circuit IR, as JSON in the MDX source. */
  ir: Circuit;
  caption?: string;
  /**
   * Which readouts to offer. Authors may write a single view as a bare string
   * (`show="probabilities"`), which is the common case, or a list to get tabs.
   */
  show?: LessonView | LessonView[];
  shots?: number;
  height?: number;
  /** Author commentary rendered beneath the live result. */
  children?: React.ReactNode;
}

export type LessonView = 'amplitudes' | 'probabilities' | 'bloch' | 'qasm';

export function LessonCircuit({
  ir,
  caption,
  show = ['amplitudes'],
  shots = 0,
  height,
  children,
}: LessonCircuitProps) {
  const views = useMemo<LessonView[]>(() => (Array.isArray(show) ? show : [show]), [show]);
  const [view, setView] = useState<LessonView>(views[0] ?? 'amplitudes');
  const result = useMemo<SimResult | null>(() => {
    try {
      return simulate(ir, { shots, seed: 20260829 });
    } catch {
      return null;
    }
  }, [ir, shots]);
  const stats = useMemo(() => metrics(ir), [ir]);

  return (
    <figure className="rq-lesson-figure" data-register="instrument">
      <div className="rq-lesson-figure-head">
        <span className="rq-eyebrow">{ir.name || 'circuit'}</span>
        {views.length > 1 && (
          <div className="rq-tabs" role="tablist" aria-label="Figure view">
            {views.map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={v === view}
                className={`rq-tab${v === view ? ' is-active' : ''}`}
                onClick={() => setView(v)}
              >
                {v}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="rq-lesson-figure-body" style={height ? { minHeight: height } : undefined}>
        {!result ? (
          <p className="rq-empty">This circuit could not be simulated.</p>
        ) : view === 'qasm' ? (
          <pre className="rq-lesson-pre rq-mono">{toQasm3(ir)}</pre>
        ) : view === 'bloch' ? (
          <div className="rq-bloch-grid">
            {result.bloch.map((b, q) => (
              <BlochSphere key={q} vector={b} purity={b.purity} label={`q${q}`} size={168} />
            ))}
          </div>
        ) : (
          <AmplitudeRows result={result} probabilitiesOnly={view === 'probabilities'} />
        )}
      </div>

      <div className="rq-lesson-figure-foot">
        <span className="rq-numeric">{stats.qubits} qubits</span>
        <span className="rq-numeric">depth {stats.depth}</span>
        <span className="rq-numeric">{stats.size} gates</span>
        {stats.twoQubitGates > 0 && <span className="rq-numeric">{stats.twoQubitGates} two qubit</span>}
      </div>

      {children ? <div className="rq-lesson-figure-note">{children}</div> : null}
      {caption ? <figcaption className="rq-lesson-figcaption">{caption}</figcaption> : null}
    </figure>
  );
}

function AmplitudeRows({ result, probabilitiesOnly }: { result: SimResult; probabilitiesOnly: boolean }) {
  const sv = result.statevector;
  const rows = Array.from(result.probabilities)
    .map((p, i) => ({
      basis: i.toString(2).padStart(result.qubits, '0'),
      p,
      re: sv ? sv[2 * i]! : Math.sqrt(p),
      im: sv ? sv[2 * i + 1]! : 0,
    }))
    .filter((r) => r.p > 1e-10)
    .sort((a, b) => b.p - a.p)
    .slice(0, 16);

  return (
    <table className="rq-amp-table">
      <thead>
        <tr>
          <th scope="col">state</th>
          {!probabilitiesOnly && <th scope="col">amplitude</th>}
          <th scope="col">probability</th>
          {!probabilitiesOnly && sv && <th scope="col">phase</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.basis}>
            <th scope="row" className="rq-mono">|{r.basis}⟩</th>
            {!probabilitiesOnly && (
              <td className="rq-numeric">
                {r.re.toFixed(4)}
                {r.im >= 0 ? ' + ' : ' - '}
                {Math.abs(r.im).toFixed(4)}i
              </td>
            )}
            <td>
              <span className="rq-bar-wrap">
                <span className="rq-bar" style={{ width: `${r.p * 100}%` }} />
                <span className="rq-numeric rq-bar-value">{(r.p * 100).toFixed(2)}%</span>
              </span>
            </td>
            {!probabilitiesOnly && sv && (
              <td>
                <span className="rq-phase-disc" style={{ background: phaseColor(Math.atan2(r.im, r.re)) }}>
                  <span
                    className="rq-phase-tick"
                    style={{ transform: `rotate(${(Math.atan2(r.im, r.re) * 180) / Math.PI}deg)` }}
                  />
                </span>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
