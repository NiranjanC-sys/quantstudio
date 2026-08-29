/**
 * PennyLane emitter. PennyLane wires are big-endian like ours, so indices pass
 * through. Emits a QNode so the result is differentiable, which is what the
 * variational lessons need.
 */

import { angleLiteral } from '../format.js';
import { type Circuit, type Op, isSymbolic } from '../types.js';

const OPS: Record<string, string> = {
  id: 'qml.Identity', x: 'qml.PauliX', y: 'qml.PauliY', z: 'qml.PauliZ', h: 'qml.Hadamard',
  s: 'qml.S', t: 'qml.T', sx: 'qml.SX',
  swap: 'qml.SWAP', iswap: 'qml.ISWAP',
  cx: 'qml.CNOT', cy: 'qml.CY', cz: 'qml.CZ', cswap: 'qml.CSWAP', ccx: 'qml.Toffoli',
};

const PARAM_OPS: Record<string, string> = {
  rx: 'qml.RX', ry: 'qml.RY', rz: 'qml.RZ', p: 'qml.PhaseShift', u: 'qml.U3',
  crx: 'qml.CRX', cry: 'qml.CRY', crz: 'qml.CRZ', cp: 'qml.ControlledPhaseShift',
  rxx: 'qml.IsingXX', ryy: 'qml.IsingYY', rzz: 'qml.IsingZZ',
};

const ADJOINT: Record<string, string> = { sdg: 'qml.S', tdg: 'qml.T', sxdg: 'qml.SX' };

/** Named PennyLane ops for a base gate carrying N controls. */
const CONTROLLED: Record<string, Record<number, { name: string; parametric: boolean }>> = {
  x: { 1: { name: 'qml.CNOT', parametric: false }, 2: { name: 'qml.Toffoli', parametric: false } },
  y: { 1: { name: 'qml.CY', parametric: false } },
  z: { 1: { name: 'qml.CZ', parametric: false } },
  h: { 1: { name: 'qml.CH', parametric: false } },
  swap: { 1: { name: 'qml.CSWAP', parametric: false } },
  rx: { 1: { name: 'qml.CRX', parametric: true } },
  ry: { 1: { name: 'qml.CRY', parametric: true } },
  rz: { 1: { name: 'qml.CRZ', parametric: true } },
  p: { 1: { name: 'qml.ControlledPhaseShift', parametric: true } },
};

function params(op: Op): string[] {
  return (op.params ?? []).map((p) => (isSymbolic(p) ? p.symbol : angleLiteral(p, 'np.pi')));
}

export function toPennyLane(circuit: Circuit): string {
  const symbols = new Set<string>();
  for (const op of circuit.ops) for (const p of op.params ?? []) if (isSymbolic(p)) symbols.add(p.symbol);
  const sig = [...symbols].sort();

  const measured = circuit.ops.some((o) => o.gate === 'measure');
  const head = [
    'import pennylane as qml',
    'from pennylane import numpy as np',
    '',
    `dev = qml.device("default.qubit", wires=${circuit.qubits}${measured ? ', shots=1024' : ''})`,
    '',
    '@qml.qnode(dev)',
    `def circuit(${sig.join(', ')}):`,
  ];

  const body: string[] = [];
  for (const op of circuit.ops) {
    if (op.gate === 'barrier') {
      body.push(`qml.Barrier(wires=${JSON.stringify(op.targets.length ? op.targets : range(circuit.qubits))})`);
      continue;
    }
    if (op.gate === 'measure') continue; // handled by the return statement
    if (op.gate === 'reset') {
      body.push(`# reset on wire ${op.targets[0]}: use qml.measure + conditional reset in a real device program`);
      continue;
    }
    const wires = [...(op.controls ?? []), ...op.targets];
    const p = params(op);

    if (ADJOINT[op.gate]) {
      body.push(`qml.adjoint(${ADJOINT[op.gate]})(wires=${wires[0]})`);
      continue;
    }
    const controls = op.controls ?? [];
    const named = controls.length ? CONTROLLED[op.gate]?.[controls.length] : undefined;
    if (named) {
      body.push(
        named.parametric
          ? `${named.name}(${p.join(', ')}, wires=${JSON.stringify(wires)})`
          : `${named.name}(wires=${JSON.stringify(wires)})`,
      );
      continue;
    }
    if (controls.length) {
      // Fall back to the generic control wrapper for anything without a named op.
      const inner = PARAM_OPS[op.gate] ?? OPS[op.gate];
      if (inner) {
        body.push(`qml.ctrl(${inner}, control=${JSON.stringify(controls)})(${p.length ? p.join(', ') + ', ' : ''}wires=${JSON.stringify(op.targets)})`);
        continue;
      }
    }
    if (PARAM_OPS[op.gate]) {
      body.push(`${PARAM_OPS[op.gate]}(${p.join(', ')}, wires=${JSON.stringify(wires)})`);
      continue;
    }
    if (OPS[op.gate]) {
      body.push(`${OPS[op.gate]}(wires=${wires.length === 1 ? wires[0] : JSON.stringify(wires)})`);
      continue;
    }
    body.push(`# unsupported in this emitter: ${op.gate}`);
  }

  const measuredQubits = circuit.ops.filter((o) => o.gate === 'measure').map((o) => o.targets[0]!);
  const ret = measured
    ? `return qml.counts(wires=${JSON.stringify(measuredQubits)})`
    : 'return qml.state()';
  body.push(ret);

  const tail = ['', 'if __name__ == "__main__":', `    print(circuit(${sig.map(() => '0.0').join(', ')}))`];
  return [...head, ...body.map((l) => '    ' + l), ...tail].join('\n') + '\n';
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
