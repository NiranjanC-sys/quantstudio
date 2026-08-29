'use client';

/**
 * Editor state for the circuit builder.
 *
 * Undo is a stack of whole Circuits rather than diffs. A circuit is a few
 * kilobytes at most, and storing snapshots makes undo trivially correct: there
 * is no way for a diff to be misapplied and leave the canvas showing something
 * the simulator does not agree with.
 */

import { create } from 'zustand';
import {
  type Circuit,
  type Op,
  type Param,
  type Dialect,
  type SimResult,
  emptyCircuit,
  place,
  removeOp,
  updateOp,
  addControl,
  removeControl,
  setQubits as setQubitsOp,
  setClbits as setClbitsOp,
  simulate,
  metrics,
  validate,
  circuitHash,
  emit,
  fromQasm3,
  type CircuitMetrics,
  type ValidationIssue,
} from '@redquant/qir';

const HISTORY_LIMIT = 100;

export interface DragPayload {
  gate: string;
  /** Set when dragging an existing op rather than a palette item. */
  opId?: string;
}

interface CircuitState {
  circuit: Circuit;
  past: Circuit[];
  future: Circuit[];
  selectedOpId: string | null;
  drag: DragPayload | null;
  dialect: Dialect;
  shots: number;
  seed: number;
  bindings: Record<string, number>;
  noiseEnabled: boolean;
  noise: { depolarising1: number; depolarising2: number; readout: number };
  /** Derived, recomputed on every mutation. */
  result: SimResult | null;
  simError: string | null;
  simMs: number;
  stats: CircuitMetrics;
  issues: ValidationIssue[];
  hash: string;

  load: (c: Circuit) => void;
  reset: (qubits?: number) => void;
  placeGate: (gate: string, targets: number[], layer?: number, controls?: number[]) => void;
  remove: (opId: string) => void;
  patch: (opId: string, patch: Partial<Op>) => void;
  setParam: (opId: string, index: number, value: Param) => void;
  toggleControl: (opId: string, qubit: number) => void;
  setQubits: (n: number) => void;
  setClbits: (n: number) => void;
  select: (opId: string | null) => void;
  setDrag: (d: DragPayload | null) => void;
  setDialect: (d: Dialect) => void;
  setShots: (n: number) => void;
  setSeed: (n: number) => void;
  setBinding: (symbol: string, value: number) => void;
  setNoiseEnabled: (on: boolean) => void;
  setNoise: (patch: Partial<CircuitState['noise']>) => void;
  undo: () => void;
  redo: () => void;
  source: () => string;
  importQasm: (src: string) => { ok: true } | { ok: false; error: string };
}

/** The qubit count above which we stop simulating on every keystroke. */
export const LIVE_SIM_LIMIT = 14;

function derive(state: {
  circuit: Circuit;
  shots: number;
  seed: number;
  bindings: Record<string, number>;
  noiseEnabled: boolean;
  noise: CircuitState['noise'];
}): Pick<CircuitState, 'result' | 'simError' | 'simMs' | 'stats' | 'issues' | 'hash'> {
  const stats = metrics(state.circuit);
  const issues = validate(state.circuit);
  const hash = circuitHash(state.circuit);
  const blocking = issues.filter((i) => i.severity === 'error');

  if (blocking.length) {
    return { result: null, simError: blocking[0]!.message, simMs: 0, stats, issues, hash };
  }
  if (state.circuit.qubits > LIVE_SIM_LIMIT) {
    return {
      result: null,
      simError: `${state.circuit.qubits} qubits is past the ${LIVE_SIM_LIMIT} qubit live limit. Run it on the server backend.`,
      simMs: 0,
      stats,
      issues,
      hash,
    };
  }
  const t0 = performance.now();
  try {
    const result = simulate(state.circuit, {
      shots: state.shots,
      seed: state.seed,
      bindings: state.bindings,
      maxQubits: LIVE_SIM_LIMIT,
      ...(state.noiseEnabled ? { noise: state.noise } : {}),
    });
    return { result, simError: null, simMs: performance.now() - t0, stats, issues, hash };
  } catch (e) {
    return {
      result: null,
      simError: e instanceof Error ? e.message : String(e),
      simMs: performance.now() - t0,
      stats,
      issues,
      hash,
    };
  }
}

const initial = emptyCircuit(3, 3, 'untitled');

export const useCircuit = create<CircuitState>((set, get) => {
  /** Apply a pure circuit transform, pushing the previous state onto the undo stack. */
  const commit = (fn: (c: Circuit) => Circuit) => {
    const s = get();
    const next = fn(s.circuit);
    if (next === s.circuit) return;
    set({
      circuit: next,
      past: [...s.past, s.circuit].slice(-HISTORY_LIMIT),
      future: [],
      ...derive({ ...s, circuit: next }),
    });
  };

  return {
    circuit: initial,
    past: [],
    future: [],
    selectedOpId: null,
    drag: null,
    dialect: 'qasm3',
    shots: 1024,
    seed: 1337,
    bindings: {},
    noiseEnabled: false,
    noise: { depolarising1: 0.002, depolarising2: 0.02, readout: 0.02 },
    // The initial derive runs on the server too. `simulate` is deterministic
    // for a given seed so the amplitudes agree, but the wall-clock timing does
    // not, and a differing number in the DOM fails hydration. Pin it to zero
    // for the first render; every later derive reports the real figure.
    ...derive({
      circuit: initial,
      shots: 1024,
      seed: 1337,
      bindings: {},
      noiseEnabled: false,
      noise: { depolarising1: 0.002, depolarising2: 0.02, readout: 0.02 },
    }),
    simMs: 0,

    load: (c) => commit(() => c),
    reset: (qubits) => commit(() => emptyCircuit(qubits ?? get().circuit.qubits, qubits ?? get().circuit.qubits, 'untitled')),
    placeGate: (gate, targets, layer, controls) =>
      commit((c) => place(c, { gate, targets, ...(layer !== undefined ? { layer } : {}), ...(controls ? { controls } : {}) })),
    remove: (opId) => {
      if (get().selectedOpId === opId) set({ selectedOpId: null });
      commit((c) => removeOp(c, opId));
    },
    patch: (opId, p) => commit((c) => updateOp(c, opId, p)),
    setParam: (opId, index, value) =>
      commit((c) => {
        const op = c.ops.find((o) => o.id === opId);
        if (!op?.params) return c;
        const params = [...op.params];
        params[index] = value;
        return updateOp(c, opId, { params });
      }),
    toggleControl: (opId, qubit) =>
      commit((c) => {
        const op = c.ops.find((o) => o.id === opId);
        if (!op) return c;
        return op.controls?.includes(qubit) ? removeControl(c, opId, qubit) : addControl(c, opId, qubit);
      }),
    setQubits: (n) => commit((c) => setQubitsOp(c, n)),
    setClbits: (n) => commit((c) => setClbitsOp(c, n)),
    select: (opId) => set({ selectedOpId: opId }),
    setDrag: (d) => set({ drag: d }),
    setDialect: (d) => set({ dialect: d }),
    setShots: (n) => {
      const s = get();
      set({ shots: n, ...derive({ ...s, shots: n }) });
    },
    setSeed: (n) => {
      const s = get();
      set({ seed: n, ...derive({ ...s, seed: n }) });
    },
    setBinding: (symbol, value) => {
      const s = get();
      const bindings = { ...s.bindings, [symbol]: value };
      set({ bindings, ...derive({ ...s, bindings }) });
    },
    setNoiseEnabled: (on) => {
      const s = get();
      set({ noiseEnabled: on, ...derive({ ...s, noiseEnabled: on }) });
    },
    setNoise: (patch) => {
      const s = get();
      const noise = { ...s.noise, ...patch };
      set({ noise, ...derive({ ...s, noise }) });
    },
    undo: () => {
      const s = get();
      const prev = s.past[s.past.length - 1];
      if (!prev) return;
      set({
        circuit: prev,
        past: s.past.slice(0, -1),
        future: [s.circuit, ...s.future].slice(0, HISTORY_LIMIT),
        ...derive({ ...s, circuit: prev }),
      });
    },
    redo: () => {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      set({
        circuit: next,
        past: [...s.past, s.circuit].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        ...derive({ ...s, circuit: next }),
      });
    },
    source: () => emit(get().circuit, get().dialect),
    importQasm: (src) => {
      try {
        const c = fromQasm3(src);
        commit(() => c);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
});

/** Symbols the current circuit expects bindings for. */
export function usedSymbols(circuit: Circuit): string[] {
  const s = new Set<string>();
  for (const op of circuit.ops) {
    for (const p of op.params ?? []) {
      if (typeof p === 'object' && p && 'symbol' in p) s.add(p.symbol);
    }
  }
  return [...s].sort();
}
