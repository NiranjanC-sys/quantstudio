/**
 * The track and module skeleton, mirroring docs/research/02-syllabus.md.
 *
 * This is the navigational spine. Authored lesson files are discovered from
 * the filesystem and matched onto it by their `module` frontmatter, so the
 * curriculum page shows real progress toward the planned 331 lessons rather
 * than a number someone typed in.
 */

export interface ModuleSpec {
  id: string;
  name: string;
  planned: number;
}

export interface TrackSpec {
  id: string;
  name: string;
  level: 'L0' | 'L1' | 'L2' | 'L3';
  blurb: string;
  modules: ModuleSpec[];
}

export const TRACKS: TrackSpec[] = [
  {
    id: 't0',
    name: 'Mathematical and Computational Foundations',
    level: 'L0',
    blurb: 'The track every other syllabus assumes you already have. Skippable by placement test.',
    modules: [
      { id: 't0.m1', name: 'Probability and Information', planned: 5 },
      { id: 't0.m2', name: 'Complex Numbers', planned: 3 },
      { id: 't0.m3', name: 'Vectors and Vector Spaces', planned: 3 },
      { id: 't0.m4', name: 'Matrices and Operators', planned: 4 },
      { id: 't0.m5', name: 'Tensor Products', planned: 3 },
      { id: 't0.m6', name: 'Classical Computation', planned: 4 },
      { id: 't0.m7', name: 'Python for Quantum', planned: 3 },
      { id: 't0.m8', name: 'Placement', planned: 1 },
    ],
  },
  {
    id: 't1',
    name: 'Quantum Computing Core',
    level: 'L1',
    blurb: 'Qubits, measurement, entanglement, nonlocality, the circuit model, and your first four algorithms.',
    modules: [
      { id: 't1.m1', name: 'The Qubit', planned: 8 },
      { id: 't1.m2', name: 'Measurement', planned: 5 },
      { id: 't1.m3', name: 'Single-Qubit Gates', planned: 6 },
      { id: 't1.m4', name: 'Multi-Qubit Systems', planned: 6 },
      { id: 't1.m5', name: 'Entanglement', planned: 5 },
      { id: 't1.m6', name: 'Nonlocality and Games', planned: 5 },
      { id: 't1.m7', name: 'Protocols', planned: 5 },
      { id: 't1.m8', name: 'The Circuit Model', planned: 6 },
      { id: 't1.m9', name: 'Phase and Interference', planned: 4 },
      { id: 't1.m10', name: 'First Algorithms', planned: 4 },
      { id: 't1.m11', name: 'Meeting Noise Early', planned: 5 },
      { id: 't1.m12', name: 'Capstone', planned: 2 },
    ],
  },
  {
    id: 't2',
    name: 'Quantum Algorithms and Complexity',
    level: 'L2',
    blurb: 'Grover, the Fourier transform, phase estimation, Shor, hidden subgroups, walks, simulation, lower bounds.',
    modules: [
      { id: 't2.m1', name: 'The Query Model', planned: 4 },
      { id: 't2.m2', name: 'Amplitude Amplification and Grover', planned: 9 },
      { id: 't2.m3', name: 'The Fourier Transform', planned: 6 },
      { id: 't2.m4', name: 'Phase Estimation', planned: 3 },
      { id: 't2.m5', name: 'Order Finding and Shor', planned: 5 },
      { id: 't2.m6', name: 'The Hidden Subgroup Problem', planned: 3 },
      { id: 't2.m7', name: 'Quantum Walks', planned: 5 },
      { id: 't2.m8', name: 'Hamiltonian Simulation', planned: 5 },
      { id: 't2.m9', name: 'Lower Bounds and Complexity', planned: 6 },
      { id: 't2.m10', name: 'Zoo Lab', planned: 2 },
    ],
  },
  {
    id: 't3',
    name: 'Quantum Software Engineering',
    level: 'L1',
    blurb: 'Five SDKs, OpenQASM 3, transpilation, resource estimation, testing quantum code, benchmarking, mitigation.',
    modules: [
      { id: 't3.m1', name: 'The SDK Landscape', planned: 4 },
      { id: 't3.m2', name: 'OpenQASM 3', planned: 3 },
      { id: 't3.m3', name: 'Transpilation', planned: 6 },
      { id: 't3.m4', name: 'Resource Estimation', planned: 3 },
      { id: 't3.m5', name: 'Hybrid Runtimes', planned: 4 },
      { id: 't3.m6', name: 'Testing Quantum Code', planned: 5 },
      { id: 't3.m7', name: 'Noise Models and Benchmarking', planned: 5 },
      { id: 't3.m8', name: 'Error Mitigation', planned: 5 },
      { id: 't3.m9', name: 'Capstone', planned: 6 },
    ],
  },
  {
    id: 't4',
    name: 'Noise, Error Correction and Fault Tolerance',
    level: 'L2',
    blurb: 'Density matrices, channels, stabilizers, surface codes, decoding, magic states, the threshold theorem.',
    modules: [
      { id: 't4.m1', name: 'Open Systems', planned: 9 },
      { id: 't4.m2', name: 'General Measurement', planned: 4 },
      { id: 't4.m3', name: 'From Classical to Quantum Codes', planned: 4 },
      { id: 't4.m4', name: 'The Stabilizer Formalism', planned: 7 },
      { id: 't4.m5', name: 'Topological Codes', planned: 6 },
      { id: 't4.m6', name: 'Fault Tolerance', planned: 5 },
      { id: 't4.m7', name: 'Beyond the Surface Code', planned: 4 },
      { id: 't4.m8', name: 'Decoder Lab', planned: 3 },
    ],
  },
  {
    id: 't5',
    name: 'Applications',
    level: 'L2',
    blurb: 'Chemistry and VQE, optimisation and QAOA, quantum machine learning, cryptography and the migration to PQC.',
    modules: [
      { id: 't5.a', name: 'Chemistry and Materials', planned: 12 },
      { id: 't5.b', name: 'Optimisation', planned: 11 },
      { id: 't5.c', name: 'Quantum Machine Learning', planned: 11 },
      { id: 't5.d', name: 'Cryptography and Security', planned: 9 },
    ],
  },
  {
    id: 't6',
    name: 'Hardware and Systems',
    level: 'L2',
    blurb: 'Transmons, ions, photons, neutral atoms, spins. Coherence, calibration, cryogenics, cloud QPU systems.',
    modules: [
      { id: 't6.m1', name: 'What a Qubit Is Made Of', planned: 8 },
      { id: 't6.m2', name: 'Coherence and Control', planned: 4 },
      { id: 't6.m3', name: 'Calibration', planned: 3 },
      { id: 't6.m4', name: 'Cryogenics and Wiring', planned: 3 },
      { id: 't6.m5', name: 'Cloud QPU Systems', planned: 5 },
      { id: 't6.m6', name: 'Quantum Networking', planned: 3 },
      { id: 't6.m7', name: 'Quantum and HPC', planned: 4 },
    ],
  },
  {
    id: 't7',
    name: 'Career and Research',
    level: 'L1',
    blurb: 'Reading papers, thirty recurring interview patterns, twenty employer briefings, a defended capstone.',
    modules: [
      { id: 't7.m1', name: 'Reading the Literature', planned: 2 },
      { id: 't7.m2', name: 'Coding Interviews', planned: 4 },
      { id: 't7.m3', name: 'System-Design Interviews', planned: 4 },
      { id: 't7.m4', name: 'Company Briefings', planned: 2 },
      { id: 't7.m5', name: 'Portfolio', planned: 2 },
      { id: 't7.m6', name: 'Capstone', planned: 1 },
    ],
  },
];

export const PLANNED_LESSONS = TRACKS.reduce(
  (sum, t) => sum + t.modules.reduce((s, m) => s + m.planned, 0),
  0,
);
