'use client';

/**
 * The circuit canvas.
 *
 * SVG rather than canvas or DOM tiles: gates need crisp hairlines at every zoom
 * level, the whole thing must be screenshot-able for lesson figures, and each
 * gate stays a real focusable element so the builder is keyboard operable.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { GATES, moments, opQubits, type Op } from '@redquant/qir';
import { useCircuit } from '@/lib/circuit-store';
import {
  CLBIT_GAP, COL_W, LEFT_GUTTER, TILE, TOP_PAD, WIRE_PITCH,
  canvasSize, clbitY, colX, hitTest, wireY,
} from './geometry';

interface DropTarget {
  qubit: number;
  column: number;
}

export function CircuitCanvas() {
  const circuit = useCircuit((s) => s.circuit);
  const selectedOpId = useCircuit((s) => s.selectedOpId);
  const drag = useCircuit((s) => s.drag);
  const placeGate = useCircuit((s) => s.placeGate);
  const patch = useCircuit((s) => s.patch);
  const remove = useCircuit((s) => s.remove);
  const select = useCircuit((s) => s.select);
  const toggleControl = useCircuit((s) => s.toggleControl);

  const svgRef = useRef<SVGSVGElement>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);

  const cols = useMemo(() => moments(circuit), [circuit]);
  const layerOf = useMemo(() => {
    const map = new Map<string, number>();
    cols.forEach((ops, i) => ops.forEach((o) => map.set(o.id, i)));
    return map;
  }, [cols]);

  const size = canvasSize(circuit.qubits, cols.length + 1, circuit.clbits > 0);

  const pointFromEvent = useCallback((e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const scale = size.width / rect.width;
    return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
  }, [size.width]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const p = pointFromEvent(e);
    if (!p) return;
    setTarget(hitTest(p.x, p.y, circuit.qubits));
  }, [circuit.qubits, pointFromEvent]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const p = pointFromEvent(e);
    const hit = p && hitTest(p.x, p.y, circuit.qubits);
    setTarget(null);
    if (!hit) return;

    const raw = e.dataTransfer.getData('application/x-redquant-gate');
    if (!raw) return;
    const payload = JSON.parse(raw) as { gate: string; opId?: string };
    const def = GATES[payload.gate];
    if (!def) return;

    if (payload.opId) {
      // Moving an existing gate: shift every qubit it touches by the same delta,
      // so a CNOT keeps its shape instead of collapsing onto one wire.
      const op = circuit.ops.find((o) => o.id === payload.opId);
      if (!op) return;
      const delta = hit.qubit - op.targets[0]!;
      const shift = (q: number) => q + delta;
      const nextTargets = op.targets.map(shift);
      const nextControls = op.controls?.map(shift);
      const all = [...nextTargets, ...(nextControls ?? [])];
      if (all.some((q) => q < 0 || q >= circuit.qubits)) return;
      patch(op.id, { targets: nextTargets, ...(nextControls ? { controls: nextControls } : {}) });
      return;
    }

    const arity = def.controlledForm && def.controlledForm.controls < 0 ? 1 : def.arity;
    const targets = Array.from({ length: arity }, (_, i) => hit.qubit + i);
    if (targets.some((q) => q >= circuit.qubits)) return;
    placeGate(payload.gate, targets, hit.column);
  }, [circuit, patch, placeGate, pointFromEvent]);

  const onKeyDown = useCallback((e: React.KeyboardEvent, op: Op) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove(op.id);
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const delta = e.key === 'ArrowUp' ? -1 : 1;
      const nextTargets = op.targets.map((q) => q + delta);
      const nextControls = op.controls?.map((q) => q + delta);
      const all = [...nextTargets, ...(nextControls ?? [])];
      if (all.some((q) => q < 0 || q >= circuit.qubits)) return;
      patch(op.id, { targets: nextTargets, ...(nextControls ? { controls: nextControls } : {}) });
    }
  }, [circuit.qubits, patch, remove]);

  return (
    <div className="rq-canvas-scroll" role="group" aria-label="Circuit editor">
      <svg
        ref={svgRef}
        width={size.width}
        height={size.height}
        viewBox={`0 0 ${size.width} ${size.height}`}
        className="rq-canvas"
        onDragOver={onDragOver}
        onDragLeave={() => setTarget(null)}
        onDrop={onDrop}
      >
        <defs>
          <marker id="rq-arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="var(--ink-faint)" />
          </marker>
        </defs>

        {/* Selected moment column highlight */}
        {selectedOpId && layerOf.has(selectedOpId) && (
          <rect
            x={colX(layerOf.get(selectedOpId)!) - COL_W / 2}
            y={TOP_PAD - 8}
            width={COL_W}
            height={size.height - TOP_PAD}
            fill="var(--accent-wash)"
            pointerEvents="none"
          />
        )}

        {/* Quantum wires */}
        {Array.from({ length: circuit.qubits }, (_, q) => (
          <g key={`w${q}`}>
            <text
              x={LEFT_GUTTER - 16}
              y={wireY(q)}
              textAnchor="end"
              dominantBaseline="middle"
              className="rq-wire-label"
            >
              q{q}
            </text>
            <line
              x1={LEFT_GUTTER}
              y1={wireY(q)}
              x2={size.width - 12}
              y2={wireY(q)}
              stroke="var(--hairline-strong)"
              strokeWidth={1}
            />
          </g>
        ))}

        {/* Classical register, drawn as the conventional double line */}
        {circuit.clbits > 0 && (
          <g>
            <text
              x={LEFT_GUTTER - 16}
              y={clbitY(circuit.qubits)}
              textAnchor="end"
              dominantBaseline="middle"
              className="rq-wire-label"
            >
              c[{circuit.clbits}]
            </text>
            <line x1={LEFT_GUTTER} y1={clbitY(circuit.qubits) - 2} x2={size.width - 12} y2={clbitY(circuit.qubits) - 2} stroke="var(--hairline)" strokeWidth={1} />
            <line x1={LEFT_GUTTER} y1={clbitY(circuit.qubits) + 2} x2={size.width - 12} y2={clbitY(circuit.qubits) + 2} stroke="var(--hairline)" strokeWidth={1} />
          </g>
        )}

        {/* Drop indicator */}
        {target && drag && (
          <rect
            x={colX(target.column) - TILE / 2}
            y={wireY(target.qubit) - TILE / 2}
            width={TILE}
            height={TILE}
            rx={6}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
        )}

        {/* Gates */}
        {cols.map((ops, col) =>
          ops.map((op) => (
            <GateGlyph
              key={op.id}
              op={op}
              column={col}
              qubits={circuit.qubits}
              clbitY={clbitY(circuit.qubits)}
              selected={op.id === selectedOpId}
              onSelect={() => select(op.id)}
              onKeyDown={(e) => onKeyDown(e, op)}
              onToggleControl={(q) => toggleControl(op.id, q)}
            />
          )),
        )}
      </svg>
    </div>
  );
}

interface GlyphProps {
  op: Op;
  column: number;
  qubits: number;
  clbitY: number;
  selected: boolean;
  onSelect: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onToggleControl: (qubit: number) => void;
}

function GateGlyph({ op, column, qubits, clbitY, selected, onSelect, onKeyDown, onToggleControl }: GlyphProps) {
  const def = GATES[op.gate];
  const x = colX(column);
  const touched = opQubits(op);
  const top = Math.min(...touched);
  const bottom = Math.max(...touched);
  const controls = op.controls ?? [];

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/x-redquant-gate', JSON.stringify({ gate: op.gate, opId: op.id }));
    e.dataTransfer.effectAllowed = 'move';
  };

  const label = def
    ? `${def.name} on ${op.targets.map((q) => `q${q}`).join(', ')}${controls.length ? `, controlled by ${controls.map((q) => `q${q}`).join(', ')}` : ''}`
    : op.gate;

  if (op.gate === 'barrier') {
    return (
      <line
        x1={x} y1={wireY(top) - WIRE_PITCH / 2} x2={x} y2={wireY(bottom) + WIRE_PITCH / 2}
        stroke="var(--ink-faint)" strokeWidth={1} strokeDasharray="3 3"
        aria-label="barrier"
      />
    );
  }

  const isCnotStyle = op.gate === 'x' && controls.length > 0;
  const isCzStyle = op.gate === 'z' && controls.length > 0;
  const isSwap = op.gate === 'swap';

  return (
    <g
      tabIndex={0}
      role="button"
      aria-label={label}
      className={`rq-gate${selected ? ' is-selected' : ''}`}
      // SVG elements accept `draggable` in every browser we support, but
      // React's SVGProps type omits it, so it is spread in explicitly.
      {...{ draggable: true }}
      onDragStart={onDragStart}
      onClick={onSelect}
      onFocus={onSelect}
      onKeyDown={onKeyDown}
    >
      {/* Vertical connector across every wire the gate touches */}
      {bottom > top && (
        <line x1={x} y1={wireY(top)} x2={x} y2={wireY(bottom)} stroke="var(--ink)" strokeWidth={1.5} />
      )}
      {op.gate === 'measure' && (
        <line
          x1={x} y1={wireY(op.targets[0]!)} x2={x} y2={clbitY}
          stroke="var(--hairline-strong)" strokeWidth={1} markerEnd="url(#rq-arrow)"
        />
      )}

      {/* Control dots. Clicking one removes it. */}
      {controls.map((q) => (
        <circle
          key={`c${q}`}
          cx={x} cy={wireY(q)} r={3.5}
          fill="var(--ink)"
          onClick={(e) => { e.stopPropagation(); onToggleControl(q); }}
          className="rq-control"
        >
          <title>Control on q{q}. Click to remove.</title>
        </circle>
      ))}

      {/* Targets */}
      {isCnotStyle ? (
        op.targets.map((q) => (
          <g key={`t${q}`}>
            <circle cx={x} cy={wireY(q)} r={11} fill="var(--surface-inset)" stroke="var(--ink)" strokeWidth={1.5} />
            <line x1={x - 11} y1={wireY(q)} x2={x + 11} y2={wireY(q)} stroke="var(--ink)" strokeWidth={1.5} />
            <line x1={x} y1={wireY(q) - 11} x2={x} y2={wireY(q) + 11} stroke="var(--ink)" strokeWidth={1.5} />
          </g>
        ))
      ) : isCzStyle ? (
        op.targets.map((q) => <circle key={`t${q}`} cx={x} cy={wireY(q)} r={3.5} fill="var(--ink)" />)
      ) : isSwap ? (
        op.targets.map((q) => (
          <g key={`t${q}`} stroke="var(--ink)" strokeWidth={1.6}>
            <line x1={x - 6} y1={wireY(q) - 6} x2={x + 6} y2={wireY(q) + 6} />
            <line x1={x - 6} y1={wireY(q) + 6} x2={x + 6} y2={wireY(q) - 6} />
          </g>
        ))
      ) : (
        op.targets.map((q) => (
          <g key={`t${q}`}>
            <rect
              x={x - TILE / 2} y={wireY(q) - TILE / 2}
              width={TILE} height={TILE} rx={6}
              fill="var(--surface-2)"
              stroke={selected ? 'var(--accent)' : 'var(--hairline-strong)'}
              strokeWidth={selected ? 2 : 1}
            />
            <text x={x} y={wireY(q) + 1} textAnchor="middle" dominantBaseline="middle" className="rq-gate-glyph">
              {def?.glyph ?? op.gate}
            </text>
          </g>
        ))
      )}

      {/* Parameter readout under the tile */}
      {op.params?.length ? (
        <text x={x} y={wireY(bottom) + TILE / 2 + 11} textAnchor="middle" className="rq-gate-param">
          {op.params
            .map((p) => (typeof p === 'number' ? formatAngle(p) : p.symbol))
            .join(', ')}
        </text>
      ) : null}
      {op.condition ? (
        <text x={x} y={clbitY + 15} textAnchor="middle" className="rq-gate-param">
          = {op.condition.value}
        </text>
      ) : null}
      {void qubits}
    </g>
  );
}

function formatAngle(x: number): string {
  const r = x / Math.PI;
  for (const d of [1, 2, 3, 4, 6, 8]) {
    const n = r * d;
    if (Math.abs(n - Math.round(n)) < 1e-9 && Math.round(n) !== 0) {
      const num = Math.round(n);
      const sign = num < 0 ? '-' : '';
      const a = Math.abs(num);
      return d === 1 ? `${sign}${a === 1 ? '' : a}π` : `${sign}${a === 1 ? '' : a}π/${d}`;
    }
  }
  return x.toFixed(2);
}
