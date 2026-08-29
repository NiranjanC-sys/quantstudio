'use client';

import { GATES } from '@redquant/qir';
import { useCircuit } from '@/lib/circuit-store';

const PI = Math.PI;

export function Inspector() {
  const circuit = useCircuit((s) => s.circuit);
  const selectedOpId = useCircuit((s) => s.selectedOpId);
  const setParam = useCircuit((s) => s.setParam);
  const remove = useCircuit((s) => s.remove);
  const toggleControl = useCircuit((s) => s.toggleControl);
  const patch = useCircuit((s) => s.patch);

  const op = circuit.ops.find((o) => o.id === selectedOpId);

  if (!op) {
    return (
      <div className="rq-inspector rq-inspector-empty">
        <p className="rq-empty">Select a gate to edit its parameters, controls and classical condition.</p>
      </div>
    );
  }

  const def = GATES[op.gate];
  if (!def) return null;

  return (
    <div className="rq-inspector">
      <header className="rq-inspector-head">
        <div>
          <h3 className="rq-inspector-title">{def.name}</h3>
          <p className="rq-inspector-desc">{def.description}</p>
        </div>
        <button type="button" className="rq-btn rq-btn-danger rq-btn-sm" onClick={() => remove(op.id)}>
          Remove
        </button>
      </header>

      {def.paramNames.length > 0 && (
        <section className="rq-inspector-section">
          <h4 className="rq-eyebrow">Parameters</h4>
          {def.paramNames.map((name, i) => {
            const value = op.params?.[i];
            const isSymbol = typeof value === 'object' && value !== null && 'symbol' in value;
            return (
              <div key={name} className="rq-param-row">
                <label className="rq-param-label" htmlFor={`param-${op.id}-${i}`}>
                  {name}
                </label>
                {isSymbol ? (
                  <input
                    id={`param-${op.id}-${i}`}
                    className="rq-input rq-mono"
                    value={(value as { symbol: string }).symbol}
                    onChange={(e) => setParam(op.id, i, { symbol: e.target.value })}
                  />
                ) : (
                  <>
                    <input
                      id={`param-${op.id}-${i}`}
                      type="range"
                      className="rq-slider"
                      min={-PI}
                      max={PI}
                      step={PI / 180}
                      value={typeof value === 'number' ? value : 0}
                      onChange={(e) => setParam(op.id, i, Number(e.target.value))}
                      aria-valuetext={`${((typeof value === 'number' ? value : 0) / PI).toFixed(3)} pi radians`}
                    />
                    <output className="rq-numeric">
                      {typeof value === 'number' ? `${(value / PI).toFixed(3)}π` : '0'}
                    </output>
                  </>
                )}
                <button
                  type="button"
                  className="rq-btn rq-btn-tertiary rq-btn-sm"
                  onClick={() => setParam(op.id, i, isSymbol ? PI / 2 : { symbol: name })}
                >
                  {isSymbol ? 'Use a number' : 'Make symbolic'}
                </button>
              </div>
            );
          })}
        </section>
      )}

      <section className="rq-inspector-section">
        <h4 className="rq-eyebrow">Controls</h4>
        <div className="rq-control-grid">
          {Array.from({ length: circuit.qubits }, (_, q) => {
            const isTarget = op.targets.includes(q);
            const isControl = op.controls?.includes(q) ?? false;
            return (
              <button
                key={q}
                type="button"
                className={`rq-qubit-toggle${isControl ? ' is-on' : ''}${isTarget ? ' is-target' : ''}`}
                disabled={isTarget || def.category === 'nonunitary'}
                onClick={() => toggleControl(op.id, q)}
                aria-pressed={isControl}
              >
                q{q}
                <span className="rq-qubit-toggle-role">{isTarget ? 'target' : isControl ? 'control' : ''}</span>
              </button>
            );
          })}
        </div>
      </section>

      {circuit.clbits > 0 && def.category !== 'nonunitary' && (
        <section className="rq-inspector-section">
          <h4 className="rq-eyebrow">Classical condition</h4>
          <div className="rq-param-row">
            <label className="rq-param-label" htmlFor={`cond-${op.id}`}>
              Run only if c[0] equals
            </label>
            <select
              id={`cond-${op.id}`}
              className="rq-input"
              value={op.condition ? String(op.condition.value) : 'none'}
              onChange={(e) =>
                patch(op.id, e.target.value === 'none' ? { condition: undefined } : { condition: { bits: [0], value: Number(e.target.value) } })
              }
            >
              <option value="none">always run</option>
              <option value="0">0</option>
              <option value="1">1</option>
            </select>
          </div>
        </section>
      )}
    </div>
  );
}
