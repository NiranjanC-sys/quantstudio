#!/usr/bin/env node
/**
 * Cross-language agreement check.
 *
 * The simulation design splits work between a TypeScript engine in the
 * browser (up to 14 qubits) and a Python kernel on the server. A learner must
 * get the same amplitudes either way, or a lesson's stated numbers are true on
 * one tier and false on the other. Nothing inside either test suite can catch
 * a divergence, because each only ever compares against itself.
 *
 * This runs the same circuit IR through both and fails if any amplitude
 * differs by more than 1e-12.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PY = path.join(ROOT, 'apps/quantum-kernel/.venv/bin/python');
const TOLERANCE = 1e-12;

if (!existsSync(PY)) {
  console.error(`cross-engine: no Python venv at ${PY}. Skipping.`);
  process.exit(0);
}

/** Circuits exercised on both sides, chosen to cover every gate family. */
const CASES = {
  bell: { qubits: 2, ops: [
    { id: 'a', gate: 'h', targets: [0] },
    { id: 'b', gate: 'x', targets: [1], controls: [0] }] },
  ghz4: { qubits: 4, ops: [
    { id: 'a', gate: 'h', targets: [0] },
    { id: 'b', gate: 'x', targets: [1], controls: [0] },
    { id: 'c', gate: 'x', targets: [2], controls: [1] },
    { id: 'd', gate: 'x', targets: [3], controls: [2] }] },
  rotations: { qubits: 3, ops: [
    { id: 'a', gate: 'ry', targets: [0], params: [0.7] },
    { id: 'b', gate: 'rz', targets: [1], params: [-1.3] },
    { id: 'c', gate: 'rx', targets: [2], params: [2.1] },
    { id: 'd', gate: 'u', targets: [0], params: [0.3, 1.1, -0.9] },
    { id: 'e', gate: 'x', targets: [2], controls: [0] }] },
  twoQubitFamily: { qubits: 3, ops: [
    { id: 'a', gate: 'h', targets: [0] },
    { id: 'b', gate: 'rxx', targets: [0, 1], params: [0.6] },
    { id: 'c', gate: 'ryy', targets: [1, 2], params: [-0.4] },
    { id: 'd', gate: 'rzz', targets: [0, 2], params: [1.2] },
    { id: 'e', gate: 'iswap', targets: [0, 1] },
    { id: 'f', gate: 'swap', targets: [1, 2] }] },
  multiControlled: { qubits: 4, ops: [
    { id: 'a', gate: 'h', targets: [0] },
    { id: 'b', gate: 'h', targets: [1] },
    { id: 'c', gate: 'h', targets: [2] },
    { id: 'd', gate: 'x', targets: [3], controls: [0, 1, 2] },
    { id: 'e', gate: 'z', targets: [2], controls: [0, 1] },
    { id: 'f', gate: 't', targets: [0] },
    { id: 'g', gate: 'sdg', targets: [1] }] },
};

const pySrc = `
import json
from app.ir import Circuit
from app.backends import base
from app import backends
cases = json.loads(${JSON.stringify(JSON.stringify(CASES))})
opts = base.SimOptions()
out = {}
for name, spec in cases.items():
    c = Circuit.model_validate({'version': 1, 'name': name, 'clbits': 0, **spec})
    sv = backends.get('native').run(c, opts).statevector
    out[name] = [[float(a.real), float(a.imag)] for a in sv]
print(json.dumps(out))
`;

const pyOut = JSON.parse(
  execFileSync(PY, ['-c', pySrc], { cwd: path.join(ROOT, 'apps/quantum-kernel'), encoding: 'utf8' }),
);

const { simulate } = await import(path.join(ROOT, 'packages/qir/dist/index.js'));

let worst = 0;
let worstAt = '';
let compared = 0;
const failures = [];

for (const [name, spec] of Object.entries(CASES)) {
  const circuit = { version: 1, name, clbits: 0, ...spec };
  const ts = simulate(circuit).statevector;
  const py = pyOut[name];
  if (!py) { failures.push(`${name}: kernel returned nothing`); continue; }
  if (py.length * 2 !== ts.length) {
    failures.push(`${name}: length mismatch, kernel ${py.length} vs engine ${ts.length / 2}`);
    continue;
  }
  py.forEach(([re, im], i) => {
    const dRe = Math.abs(ts[2 * i] - re);
    const dIm = Math.abs(ts[2 * i + 1] - im);
    const d = Math.max(dRe, dIm);
    compared++;
    if (d > worst) { worst = d; worstAt = `${name} amplitude ${i}`; }
    if (d > TOLERANCE) {
      failures.push(
        `${name} |${i.toString(2).padStart(spec.qubits, '0')}>: engine ${ts[2 * i].toFixed(12)}${ts[2 * i + 1] >= 0 ? '+' : ''}${ts[2 * i + 1].toFixed(12)}i, kernel ${re.toFixed(12)}${im >= 0 ? '+' : ''}${im.toFixed(12)}i`,
      );
    }
  });
}

console.log(`cross-engine: ${compared} amplitudes across ${Object.keys(CASES).length} circuits`);
console.log(`cross-engine: worst difference ${worst.toExponential(2)} at ${worstAt}`);

if (failures.length) {
  console.error(`\ncross-engine: ${failures.length} disagreement(s) beyond ${TOLERANCE}:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('cross-engine: the browser engine and the Python kernel agree');
