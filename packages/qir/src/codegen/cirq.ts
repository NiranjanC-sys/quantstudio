/**
 * Cirq emitter. Cirq uses the same big-endian convention we do, so qubit
 * indices pass through unchanged. This is why lessons that compare SDK output
 * use Cirq as the reference.
 */

import { angleLiteral } from '../format.js';
import { type Circuit, type Op, isSymbolic } from '../types.js';

const SIMPLE: Record<string, string> = {
  id: 'cirq.I', x: 'cirq.X', y: 'cirq.Y', z: 'cirq.Z', h: 'cirq.H',
  s: 'cirq.S', sdg: '(cirq.S**-1)', t: 'cirq.T', tdg: '(cirq.T**-1)',
  sx: '(cirq.X**0.5)', sxdg: '(cirq.X**-0.5)',
  swap: 'cirq.SWAP', iswap: 'cirq.ISWAP',
  cx: 'cirq.CNOT', cz: 'cirq.CZ', ccx: 'cirq.CCX', ccz: 'cirq.CCZ', cswap: 'cirq.CSWAP',
};

/** Named Cirq ops for a base gate carrying N controls. */
const CONTROLLED: Record<string, Record<number, string>> = {
  x: { 1: 'cirq.CNOT', 2: 'cirq.CCX' },
  z: { 1: 'cirq.CZ', 2: 'cirq.CCZ' },
  swap: { 1: 'cirq.CSWAP' },
};

const PARAMETRIC: Record<string, (p: string[]) => string> = {
  rx: (p) => `cirq.rx(${p[0]})`,
  ry: (p) => `cirq.ry(${p[0]})`,
  rz: (p) => `cirq.rz(${p[0]})`,
  p: (p) => `cirq.ZPowGate(exponent=(${p[0]}) / np.pi)`,
  cp: (p) => `cirq.CZPowGate(exponent=(${p[0]}) / np.pi)`,
  rxx: (p) => `cirq.XXPowGate(exponent=(${p[0]}) / np.pi, global_shift=-0.5)`,
  ryy: (p) => `cirq.YYPowGate(exponent=(${p[0]}) / np.pi, global_shift=-0.5)`,
  rzz: (p) => `cirq.ZZPowGate(exponent=(${p[0]}) / np.pi, global_shift=-0.5)`,
};

function params(op: Op): string[] {
  return (op.params ?? []).map((p) => (isSymbolic(p) ? `sympy.Symbol("${p.symbol}")` : angleLiteral(p, 'np.pi')));
}

function gateExpr(op: Op): string | null {
  const p = params(op);
  if (PARAMETRIC[op.gate]) return PARAMETRIC[op.gate]!(p);
  if (op.gate === 'u') {
    // U(theta, phi, lambda) as Rz . Ry . Rz, up to a global phase.
    return `cirq.MatrixGate(_u3(${p.join(', ')}))`;
  }
  return SIMPLE[op.gate] ?? null;
}

export function toCirq(circuit: Circuit): string {
  const symbols = new Set<string>();
  for (const op of circuit.ops) for (const pp of op.params ?? []) if (isSymbolic(pp)) symbols.add(pp.symbol);

  const head = ['import cirq', 'import numpy as np'];
  if (symbols.size) head.push('import sympy');
  head.push(
    '',
    'def _u3(theta, phi, lam):',
    '    """Matrix form of the RedQuant u gate, same convention as gates.ts."""',
    '    c, s = np.cos(theta / 2), np.sin(theta / 2)',
    '    return np.array([[c, -np.exp(1j * lam) * s],',
    '                     [np.exp(1j * phi) * s, np.exp(1j * (phi + lam)) * c]])',
    '',
    `qubits = cirq.LineQubit.range(${circuit.qubits})`,
    'circuit = cirq.Circuit()',
  );

  const body: string[] = [];
  for (const op of circuit.ops) {
    if (op.gate === 'barrier') {
      body.push('# barrier: Cirq has no barrier, moment structure carries the fence');
      continue;
    }
    if (op.gate === 'measure') {
      body.push(`circuit.append(cirq.measure(qubits[${op.targets[0]}], key="c${op.cbits?.[0] ?? 0}"))`);
      continue;
    }
    if (op.gate === 'reset') {
      body.push(`circuit.append(cirq.reset(qubits[${op.targets[0]}]))`);
      continue;
    }
    const controls = op.controls ?? [];
    const operands = [...controls, ...op.targets].map((q) => `qubits[${q}]`).join(', ');

    const named = controls.length ? CONTROLLED[op.gate]?.[controls.length] : undefined;
    if (named) {
      body.push(`circuit.append(${named}.on(${operands}))`);
      continue;
    }
    const expr = gateExpr(op);
    if (!expr) {
      body.push(`# unsupported in this emitter: ${op.gate}`);
      continue;
    }
    const withControls = controls.length ? `${expr}.controlled(${controls.length})` : expr;
    body.push(`circuit.append(${withControls}.on(${operands}))`);
  }

  const tail = ['', 'if __name__ == "__main__":', '    print(circuit)'];
  if (!circuit.ops.some((o) => o.gate === 'measure')) {
    tail.push('    print(cirq.Simulator().simulate(circuit).final_state_vector)');
  }
  return [...head, ...body, ...tail].join('\n') + '\n';
}
