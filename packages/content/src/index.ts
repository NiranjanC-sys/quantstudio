/**
 * `@redquant/content` - the machine-readable curriculum catalogue.
 *
 * Convention: qubit 0 is the most significant bit. A two-qubit state |q0 q1>
 * reads left to right, matching Cirq and Nielsen & Chuang, not Qiskit.
 */

export * from './sources.js';
export * from './schema.js';
export * from './catalog.js';
export * from './dag.js';
export * from './roadmaps.js';
