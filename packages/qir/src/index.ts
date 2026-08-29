export * from './types.js';
export * from './complex.js';
export * from './gates.js';
export * from './statevector.js';
export * from './analysis.js';
export * from './canonical.js';
export * from './builder.js';
export * from './algorithms.js';
export * from './format.js';
export * from './rng.js';
export { toQasm3 } from './codegen/qasm3.js';
export { toQiskit } from './codegen/qiskit.js';
export { toCirq } from './codegen/cirq.js';
export { toPennyLane } from './codegen/pennylane.js';
export { fromQasm3, ParseError } from './parse/qasm3.js';

import { toQasm3 } from './codegen/qasm3.js';
import { toQiskit } from './codegen/qiskit.js';
import { toCirq } from './codegen/cirq.js';
import { toPennyLane } from './codegen/pennylane.js';
import type { Circuit } from './types.js';

export type Dialect = 'qasm3' | 'qiskit' | 'cirq' | 'pennylane';

export const DIALECTS: { id: Dialect; label: string; language: string }[] = [
  { id: 'qasm3', label: 'OpenQASM 3', language: 'qasm' },
  { id: 'qiskit', label: 'Qiskit', language: 'python' },
  { id: 'cirq', label: 'Cirq', language: 'python' },
  { id: 'pennylane', label: 'PennyLane', language: 'python' },
];

export function emit(circuit: Circuit, dialect: Dialect): string {
  switch (dialect) {
    case 'qasm3': return toQasm3(circuit);
    case 'qiskit': return toQiskit(circuit);
    case 'cirq': return toCirq(circuit);
    case 'pennylane': return toPennyLane(circuit);
  }
}
