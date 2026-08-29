'use client';

import { useCircuit, usedSymbols } from '@/lib/circuit-store';
import { bellState, ghzState, qft, grover, teleportation, superdenseCoding, chsh, wState } from '@redquant/qir';

const PRESETS = [
  { id: 'bell', label: 'Bell pair', build: () => bellState(0) },
  { id: 'ghz', label: 'GHZ', build: () => ghzState(3) },
  { id: 'w', label: 'W state', build: () => wState() },
  { id: 'qft', label: 'QFT', build: () => qft(3) },
  { id: 'grover', label: 'Grover', build: () => grover(3, 5) },
  { id: 'teleport', label: 'Teleportation', build: () => teleportation([{ id: 'p', gate: 'ry', targets: [0], params: [0.9] }]) },
  { id: 'superdense', label: 'Superdense', build: () => superdenseCoding('10') },
  { id: 'chsh', label: 'CHSH', build: () => chsh(0, Math.PI / 8) },
];

export function Toolbar() {
  const circuit = useCircuit((s) => s.circuit);
  const setQubits = useCircuit((s) => s.setQubits);
  const shots = useCircuit((s) => s.shots);
  const setShots = useCircuit((s) => s.setShots);
  const noiseEnabled = useCircuit((s) => s.noiseEnabled);
  const setNoiseEnabled = useCircuit((s) => s.setNoiseEnabled);
  const undo = useCircuit((s) => s.undo);
  const redo = useCircuit((s) => s.redo);
  const past = useCircuit((s) => s.past.length);
  const future = useCircuit((s) => s.future.length);
  const load = useCircuit((s) => s.load);
  const reset = useCircuit((s) => s.reset);
  const bindings = useCircuit((s) => s.bindings);
  const setBinding = useCircuit((s) => s.setBinding);

  const symbols = usedSymbols(circuit);

  return (
    <div className="rq-toolbar">
      <div className="rq-toolbar-group">
        <label className="rq-toolbar-label" htmlFor="tb-qubits">qubits</label>
        <input
          id="tb-qubits"
          type="number"
          className="rq-input rq-input-narrow"
          min={1}
          max={14}
          value={circuit.qubits}
          onChange={(e) => setQubits(Number(e.target.value))}
        />
      </div>

      <div className="rq-toolbar-group">
        <label className="rq-toolbar-label" htmlFor="tb-shots">shots</label>
        <input
          id="tb-shots"
          type="number"
          className="rq-input rq-input-narrow"
          min={0}
          max={100000}
          step={256}
          value={shots}
          onChange={(e) => setShots(Number(e.target.value))}
        />
      </div>

      <label className="rq-toolbar-check">
        <input type="checkbox" checked={noiseEnabled} onChange={(e) => setNoiseEnabled(e.target.checked)} />
        noise
      </label>

      {symbols.map((s) => (
        <div className="rq-toolbar-group" key={s}>
          <label className="rq-toolbar-label" htmlFor={`bind-${s}`}>{s}</label>
          <input
            id={`bind-${s}`}
            type="range"
            className="rq-slider rq-slider-narrow"
            min={-Math.PI}
            max={Math.PI}
            step={Math.PI / 180}
            value={bindings[s] ?? 0}
            onChange={(e) => setBinding(s, Number(e.target.value))}
          />
          <span className="rq-numeric">{((bindings[s] ?? 0) / Math.PI).toFixed(2)}π</span>
        </div>
      ))}

      <div className="rq-toolbar-spacer" />

      <div className="rq-toolbar-group">
        <button type="button" className="rq-btn rq-btn-secondary rq-btn-sm" onClick={undo} disabled={past === 0}>
          Undo
        </button>
        <button type="button" className="rq-btn rq-btn-secondary rq-btn-sm" onClick={redo} disabled={future === 0}>
          Redo
        </button>
        <button type="button" className="rq-btn rq-btn-tertiary rq-btn-sm" onClick={() => reset()}>
          Clear
        </button>
      </div>

      <div className="rq-toolbar-group">
        <label className="rq-toolbar-label" htmlFor="tb-preset">load</label>
        <select
          id="tb-preset"
          className="rq-input"
          value=""
          onChange={(e) => {
            const p = PRESETS.find((x) => x.id === e.target.value);
            if (p) load(p.build());
          }}
        >
          <option value="">choose a circuit</option>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
