'use client';

/**
 * The hero runs the real product.
 *
 * DESIGN.md bans fake product UI assembled from styled divs, so this is the
 * actual gate registry, the actual simulator and the actual Bloch instrument.
 * Every number below is computed in the browser at the moment you read it.
 */

import { useMemo, useState } from 'react';
import { emptyCircuit, simulate, type Circuit, type Op } from '@redquant/qir';
import { BlochSphere } from '@/components/instruments/BlochSphere';

type Step = { label: string; ops: Op[]; caption: string };

const STEPS: Step[] = [
  {
    label: 'q0 in |0>',
    ops: [],
    caption: 'One qubit, pointing at the north pole. Certain, boring, classical.',
  },
  {
    label: 'H q0',
    ops: [{ id: 'h', gate: 'h', targets: [0] }],
    caption: 'A Hadamard rotates it onto the equator. Equal weight on 0 and 1, and a definite phase.',
  },
  {
    label: 'H, then S',
    ops: [
      { id: 'h', gate: 'h', targets: [0] },
      { id: 's', gate: 's', targets: [0] },
    ],
    caption: 'S turns the phase a quarter turn. The probabilities did not move. Only the phase did.',
  },
  {
    label: 'entangle',
    ops: [
      { id: 'h', gate: 'h', targets: [0] },
      { id: 'cx', gate: 'x', targets: [1], controls: [0] },
    ],
    caption: 'Entangle it with a second qubit and the arrow collapses to the centre. The information is no longer in either qubit alone.',
  },
];

export function HeroInstrument() {
  const [step, setStep] = useState(1);
  const active = STEPS[step]!;

  const circuit: Circuit = useMemo(
    () => ({ ...emptyCircuit(2, 0, 'hero'), ops: active.ops }),
    [active],
  );
  const result = useMemo(() => simulate(circuit), [circuit]);

  const rows = useMemo(() => {
    const sv = result.statevector!;
    return Array.from(result.probabilities)
      .map((p, i) => ({
        basis: i.toString(2).padStart(2, '0'),
        p,
        re: sv[2 * i]!,
        im: sv[2 * i + 1]!,
      }))
      .filter((r) => r.p > 1e-9);
  }, [result]);

  return (
    <div className="rq-hero-instrument" data-register="instrument">
      <div className="rq-hero-steps" role="tablist" aria-label="Walk through the state">
        {STEPS.map((s, i) => (
          <button
            key={s.label}
            role="tab"
            aria-selected={i === step}
            className={`rq-hero-step${i === step ? ' is-active' : ''}`}
            onClick={() => setStep(i)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="rq-hero-body">
        <BlochSphere vector={result.bloch[0]!} purity={result.bloch[0]!.purity} size={220} />

        <div className="rq-hero-readout">
          <table className="rq-amp-table">
            <caption className="rq-sr-only">Live amplitudes</caption>
            <thead>
              <tr>
                <th scope="col">state</th>
                <th scope="col">amplitude</th>
                <th scope="col">probability</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.basis}>
                  <th scope="row" className="rq-mono">|{r.basis}⟩</th>
                  <td className="rq-numeric">
                    {r.re.toFixed(3)}
                    {r.im >= 0 ? ' + ' : ' - '}
                    {Math.abs(r.im).toFixed(3)}i
                  </td>
                  <td>
                    <span className="rq-bar-wrap">
                      <span className="rq-bar" style={{ width: `${r.p * 100}%` }} />
                      <span className="rq-numeric rq-bar-value">{(r.p * 100).toFixed(1)}%</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="rq-hero-caption">{active.caption}</p>
    </div>
  );
}
