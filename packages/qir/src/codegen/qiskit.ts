/**
 * Qiskit emitter.
 *
 * Qiskit is little-endian: its qubit 0 is the LEAST significant bit of a basis
 * label. Our IR is big-endian. We therefore map our qubit `q` to Qiskit qubit
 * `n - 1 - q`, which makes the printed statevector and counts match ours
 * bit-for-bit. This mapping is the subject of lesson T0.M5.L3.
 */

import { GATES } from '../gates.js';
import { angleLiteral } from '../format.js';
import { type Circuit, type Op, isSymbolic } from '../types.js';

const METHOD: Record<string, string> = {
  id: 'id', x: 'x', y: 'y', z: 'z', h: 'h', s: 's', sdg: 'sdg', t: 't', tdg: 'tdg',
  sx: 'sx', sxdg: 'sxdg', rx: 'rx', ry: 'ry', rz: 'rz', p: 'p', u: 'u',
  swap: 'swap', iswap: 'iswap', rxx: 'rxx', ryy: 'ryy', rzz: 'rzz', rzx: 'rzx', ecr: 'ecr',
  cx: 'cx', cy: 'cy', cz: 'cz', ch: 'ch', cs: 'cs', csdg: 'csdg', csx: 'csx',
  cp: 'cp', crx: 'crx', cry: 'cry', crz: 'crz', cu: 'cu',
  ccx: 'ccx', ccz: 'ccz', cswap: 'cswap',
};

const CONTROLLED_ALIAS: Record<string, Record<number, string>> = {
  x: { 1: 'cx', 2: 'ccx' }, y: { 1: 'cy' }, z: { 1: 'cz', 2: 'ccz' }, h: { 1: 'ch' },
  s: { 1: 'cs' }, sdg: { 1: 'csdg' }, sx: { 1: 'csx' }, p: { 1: 'cp' },
  rx: { 1: 'crx' }, ry: { 1: 'cry' }, rz: { 1: 'crz' }, u: { 1: 'cu' }, swap: { 1: 'cswap' },
};

export function toQiskit(circuit: Circuit): string {
  const n = circuit.qubits;
  const m = (q: number) => n - 1 - q;
  const symbols = new Set<string>();
  for (const op of circuit.ops) for (const p of op.params ?? []) if (isSymbolic(p)) symbols.add(p.symbol);

  const head = [
    'from qiskit import QuantumCircuit',
    'from qiskit.quantum_info import Statevector',
  ];
  if (symbols.size) head.push('from qiskit.circuit import Parameter');
  head.push('import numpy as np', '');
  for (const s of [...symbols].sort()) head.push(`${s} = Parameter("${s}")`);
  if (symbols.size) head.push('');
  head.push(
    '# RedQuant IR is big-endian (qubit 0 is the most significant bit).',
    '# Qiskit is little-endian, so indices below are mirrored: q -> n-1-q.',
    `qc = QuantumCircuit(${n}${circuit.clbits ? `, ${circuit.clbits}` : ''})`,
  );

  const body: string[] = [];
  for (const op of circuit.ops) {
    body.push(emit(op, m, n));
  }

  const tail = ['', 'if __name__ == "__main__":', '    print(qc.draw())'];
  if (!circuit.ops.some((o) => o.gate === 'measure')) {
    tail.push('    print(Statevector(qc))');
  }
  return [...head, ...body, ...tail].join('\n') + '\n';
}

function args(op: Op, m: (q: number) => number): string {
  const controls = (op.controls ?? []).map(m);
  const targets = op.targets.map(m);
  return [...controls, ...targets].join(', ');
}

function params(op: Op): string[] {
  return (op.params ?? []).map((p) => (isSymbolic(p) ? p.symbol : angleLiteral(p, 'np.pi')));
}

function emit(op: Op, m: (q: number) => number, n: number): string {
  if (op.gate === 'barrier') {
    return op.targets.length ? `qc.barrier(${op.targets.map(m).join(', ')})` : 'qc.barrier()';
  }
  if (op.gate === 'measure') {
    return `qc.measure(${m(op.targets[0]!)}, ${op.cbits?.[0] ?? 0})`;
  }
  if (op.gate === 'reset') return `qc.reset(${m(op.targets[0]!)})`;

  const def = GATES[op.gate];
  const controls = op.controls ?? [];
  let name = METHOD[op.gate];
  let operands = args(op, m);

  if (controls.length) {
    const base = def?.controlledForm?.controls === -1 ? def.controlledForm.base : op.gate;
    const alias = CONTROLLED_ALIAS[base]?.[controls.length];
    if (alias) {
      name = METHOD[alias];
    } else {
      // Fall back to Qiskit's generic control() on a gate object.
      const p = params(op);
      const gateExpr = `${base.toUpperCase()}Gate(${p.join(', ')})`;
      return (
        `qc.append(${gateExpr}.control(${controls.length}), [${operands}])` +
        `  # requires: from qiskit.circuit.library import ${base.toUpperCase()}Gate`
      );
    }
  }
  if (!name) return `# unsupported in this emitter: ${op.gate}`;

  const p = params(op);
  const call = p.length ? `qc.${name}(${p.join(', ')}, ${operands})` : `qc.${name}(${operands})`;
  if (op.condition) {
    const bits = op.condition.bits.map((b) => b).join(', ');
    return `with qc.if_test((qc.clbits[${bits}], ${op.condition.value})):\n    ${call.replace('qc.', 'qc.')}`;
  }
  void n;
  return call;
}
