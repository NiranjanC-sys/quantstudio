'use client';

import { useState } from 'react';
import { GATES, PALETTE } from '@redquant/qir';
import { useCircuit } from '@/lib/circuit-store';

export function GatePalette() {
  const setDrag = useCircuit((s) => s.setDrag);
  const placeGate = useCircuit((s) => s.placeGate);
  const qubits = useCircuit((s) => s.circuit.qubits);
  const [query, setQuery] = useState('');

  const groups = PALETTE.map((g) => ({
    ...g,
    keys: g.keys.filter((k) => {
      if (!query) return true;
      const def = GATES[k];
      const q = query.toLowerCase();
      return k.includes(q) || def?.name.toLowerCase().includes(q) || def?.description.toLowerCase().includes(q);
    }),
  })).filter((g) => g.keys.length > 0);

  return (
    <div className="rq-palette">
      <input
        type="search"
        className="rq-palette-search"
        placeholder="Search gates"
        aria-label="Search gates"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="rq-palette-scroll">
        {groups.map((group) => (
          <section key={group.group} className="rq-palette-group">
            <h3 className="rq-eyebrow">{group.group}</h3>
            <div className="rq-palette-grid">
              {group.keys.map((key) => {
                const def = GATES[key]!;
                const arity = def.controlledForm && def.controlledForm.controls < 0 ? 1 : def.arity;
                const disabled = arity > qubits;
                return (
                  <button
                    key={key}
                    type="button"
                    className="rq-gate-chip"
                    draggable={!disabled}
                    disabled={disabled}
                    title={`${def.name}. ${def.description}`}
                    aria-label={`${def.name}. ${def.description}. Press Enter to append to the circuit, or drag onto a wire.`}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/x-redquant-gate', JSON.stringify({ gate: key }));
                      e.dataTransfer.effectAllowed = 'copy';
                      setDrag({ gate: key });
                    }}
                    onDragEnd={() => setDrag(null)}
                    onClick={() => {
                      if (disabled) return;
                      placeGate(key, Array.from({ length: arity }, (_, i) => i));
                    }}
                  >
                    <span className="rq-gate-chip-glyph">{def.glyph}</span>
                    <span className="rq-gate-chip-name">{key}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        {groups.length === 0 && <p className="rq-empty">No gate matches that.</p>}
      </div>
    </div>
  );
}
