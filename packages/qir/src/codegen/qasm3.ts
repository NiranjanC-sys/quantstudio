/**
 * OpenQASM 3 emitter. The interchange format between our IR and every SDK.
 * Big-endian internally; QASM has no global endianness, only named qubits, so
 * no reordering is needed here.
 */

import { GATES } from '../gates.js';
import { angleLiteral } from '../format.js';
import { type Circuit, type Op, isSymbolic } from '../types.js';

const ALIAS_FOR_CONTROLS: Record<string, Record<number, string>> = {
  x: { 1: 'cx', 2: 'ccx' },
  y: { 1: 'cy' },
  z: { 1: 'cz', 2: 'ccz' },
  h: { 1: 'ch' },
  s: { 1: 'cs' },
  sdg: { 1: 'csdg' },
  sx: { 1: 'csx' },
  p: { 1: 'cp' },
  rx: { 1: 'crx' },
  ry: { 1: 'cry' },
  rz: { 1: 'crz' },
  u: { 1: 'cu' },
  swap: { 1: 'cswap' },
};

function paramList(op: Op): string {
  if (!op.params?.length) return '';
  const parts = op.params.map((p) => (isSymbolic(p) ? p.symbol : angleLiteral(p)));
  return `(${parts.join(', ')})`;
}

function emitOp(op: Op, qreg: string, creg: string): string {
  const q = (i: number) => `${qreg}[${i}]`;

  if (op.gate === 'barrier') {
    const qs = op.targets.length ? op.targets.map(q).join(', ') : qreg;
    return `barrier ${qs};`;
  }
  if (op.gate === 'measure') {
    return `${creg}[${op.cbits?.[0] ?? 0}] = measure ${q(op.targets[0]!)};`;
  }
  if (op.gate === 'reset') {
    return `reset ${q(op.targets[0]!)};`;
  }

  const def = GATES[op.gate];
  const controls = op.controls ?? [];
  let name = op.gate;
  let operands = [...controls, ...op.targets];

  // Prefer the named alias when stdgates.inc has one, otherwise use ctrl @.
  if (controls.length && def && !def.controlledForm) {
    const alias = ALIAS_FOR_CONTROLS[op.gate]?.[controls.length];
    if (alias) {
      name = alias;
    } else {
      const prefix = 'ctrl @ '.repeat(controls.length);
      return `${prefix}${op.gate}${paramList(op)} ${operands.map(q).join(', ')};`;
    }
  } else if (def?.controlledForm && def.controlledForm.controls < 0) {
    const prefix = 'ctrl @ '.repeat(controls.length);
    return `${prefix}${def.controlledForm.base}${paramList(op)} ${operands.map(q).join(', ')};`;
  } else {
    operands = [...controls, ...op.targets];
  }

  const line = `${name}${paramList(op)} ${operands.map(q).join(', ')};`;
  if (op.condition) {
    const bits = op.condition.bits.map((b) => `${creg}[${b}]`).join(', ');
    return `if (${bits} == ${op.condition.value}) ${line}`;
  }
  return line;
}

export function toQasm3(circuit: Circuit, opts: { qreg?: string; creg?: string } = {}): string {
  const qreg = opts.qreg ?? 'q';
  const creg = opts.creg ?? 'c';
  const symbols = new Set<string>();
  for (const op of circuit.ops) {
    for (const p of op.params ?? []) if (isSymbolic(p)) symbols.add(p.symbol);
  }

  const lines = ['OPENQASM 3.0;', 'include "stdgates.inc";', ''];
  for (const s of [...symbols].sort()) lines.push(`input float[64] ${s};`);
  if (symbols.size) lines.push('');
  lines.push(`qubit[${circuit.qubits}] ${qreg};`);
  if (circuit.clbits > 0) lines.push(`bit[${circuit.clbits}] ${creg};`);
  lines.push('');
  for (const op of circuit.ops) lines.push(emitOp(op, qreg, creg));
  return lines.join('\n') + '\n';
}
