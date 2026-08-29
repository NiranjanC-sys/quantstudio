/**
 * T2 Quantum Algorithms and Complexity.
 *
 * Ten modules, forty-eight lessons. The track's spine is the query model: every
 * speedup in it is either an interference argument over a black box (Grover,
 * Simon, Deutsch-Jozsa) or an eigenvalue argument over a structured unitary
 * (phase estimation, order finding, Hamiltonian simulation). Module 9 closes the
 * loop by proving what none of them can do.
 *
 * Every amplitude, probability and gate budget in the labs below was checked
 * against a statevector simulator using the qubit-0-is-most-significant
 * convention before it was written down.
 */

import type { Cx, TrackSeed } from './seed.js';
import { basis, bounds, dist, res, sv, superpose, val } from './seed.js';

/* -------------------------------------------------------------------------- */
/* Verified amplitude vectors and distributions for the Grover labs            */
/* -------------------------------------------------------------------------- */

/**
 * Three qubits, one marked index (binary 101), two Grover iterations.
 * Marked amplitude 11*sqrt(2)/16, every other amplitude -sqrt(2)/16, so the
 * marked outcome carries probability 121/128 = 0.9453125.
 */
const SAT_STATE: Cx[] = Array.from({ length: 8 }, (_, i): Cx =>
  i === 5 ? [0.9722718241315029, 0] : [-0.08838834764831845, 0],
);

const SAT_DIST: Record<string, number> = Object.fromEntries(
  Array.from({ length: 8 }, (_, i): [string, number] => [
    i.toString(2).padStart(3, '0'),
    i === 5 ? 0.9453125 : 0.0078125,
  ]),
);

/**
 * Four qubits, two marked indices (0101 and 1010), two Grover iterations.
 * Marked amplitude 11/16, every other amplitude -1/16.
 */
const COLOUR_STATE: Cx[] = Array.from({ length: 16 }, (_, i): Cx =>
  i === 5 || i === 10 ? [0.6875, 0] : [-0.0625, 0],
);

const COLOUR_DIST: Record<string, number> = Object.fromEntries(
  Array.from({ length: 16 }, (_, i): [string, number] => [
    i.toString(2).padStart(4, '0'),
    i === 5 || i === 10 ? 0.47265625 : 0.00390625,
  ]),
);

/**
 * Four qubits, one marked index (0110), three Grover iterations.
 * Marked amplitude -251/256, every other amplitude 13/256.
 */
const KNAPSACK_STATE: Cx[] = Array.from({ length: 16 }, (_, i): Cx =>
  i === 6 ? [-0.98046875, 0] : [0.05078125, 0],
);

const KNAPSACK_DIST: Record<string, number> = Object.fromEntries(
  Array.from({ length: 16 }, (_, i): [string, number] => [
    i.toString(2).padStart(4, '0'),
    i === 6 ? 0.9613189697265625 : 0.0025787353515625,
  ]),
);

/* -------------------------------------------------------------------------- */

export const T2: TrackSeed = {
  id: 't2',
  code: 'T2',
  title: 'Quantum Algorithms and Complexity',
  level: ['L2'],
  summary:
    'Build every canonical quantum algorithm from the oracle up, prove the speedup each one actually delivers, and learn the lower bounds that say when no speedup exists.',
  modules: [
    /* ---------------------------------------------------------------- M1 -- */
    {
      n: 1,
      title: 'The Query Model',
      summary:
        'The setting in which almost every provable quantum speedup is stated: a black box you may query in superposition, and a cost measured in queries rather than gates.',
      lessons: [
        {
          n: 1,
          title: 'Oracles and How to Build One',
          type: 'concept',
          minutes: 12,
          objectives: [
            'Define the standard oracle U_f |x>|y> = |x>|y xor f(x)> and show it is unitary for every Boolean f',
            'Compile a small Boolean function into a reversible circuit using Toffoli gates and one ancilla',
            'Explain why the ancilla must be uncomputed before the oracle is called inside a larger algorithm',
          ],
          prereqs: ['t0.m6.l3', 't1.m4.l6', 't1.m10.l1'],
          sources: ['S2', 'S8', 'S18'],
          tags: ['oracle', 'reversibility'],
        },
        {
          n: 2,
          title: 'Bit-Flip vs Phase Oracles',
          type: 'concept',
          minutes: 12,
          objectives: [
            'Derive the phase oracle O_f |x> = (-1)^f(x) |x> from the bit-flip oracle and a target qubit in |->',
            'Show that the two oracle forms are interconvertible at the cost of one ancilla and two Hadamards',
            'Predict which of the two forms a given algorithm needs, and justify the choice',
          ],
          prereqs: ['t2.m1.l1', 't1.m9.l1'],
          sources: ['S2', 'S10', 'S14'],
          tags: ['oracle', 'phase-kickback'],
        },
        {
          n: 3,
          title: 'Marking Oracles',
          type: 'concept',
          minutes: 10,
          objectives: [
            'Construct a marking oracle for an arbitrary set of target bitstrings using X masks and a multi-controlled Z',
            'Count the two-qubit gates that a k-controlled Z costs with and without a clean ancilla',
            'Explain why marking several bitstrings costs one masked multi-controlled Z per bitstring',
          ],
          prereqs: ['t2.m1.l2', 't1.m4.l5'],
          sources: ['S11', 'S10'],
          tags: ['oracle', 'multi-controlled'],
        },
        {
          n: 4,
          title: 'Query Complexity, Defined',
          type: 'concept',
          minutes: 14,
          objectives: [
            'State the definitions of D(f), R(f) and Q(f) for a Boolean function f',
            'Compute the deterministic and quantum query complexity of OR on n bits',
            'Explain why query complexity separates from time complexity, and give one function where the gap matters',
          ],
          prereqs: ['t2.m1.l3', 't0.m6.l4'],
          sources: ['S2', 'S8', 'S13'],
          tags: ['query-complexity', 'complexity'],
        },
      ],
    },
    /* ---------------------------------------------------------------- M2 -- */
    {
      n: 2,
      title: 'Amplitude Amplification and Grover',
      summary:
        'The one quantum primitive with a provably optimal quadratic speedup, taken from a two-reflection geometric picture to three autograded search problems and then to its own lower bound.',
      lessons: [
        {
          n: 1,
          title: 'Unstructured Search',
          type: 'concept',
          minutes: 12,
          objectives: [
            'State the unstructured search problem and its classical expected query cost of (N+1)/2',
            'Explain why measuring the uniform superposition gives no advantage on its own',
            'Identify the interference step that makes a quadratic saving possible',
          ],
          prereqs: ['t2.m1.l4', 't1.m9.l4'],
          sources: ['S2', 'S9', 'S18'],
          tags: ['grover', 'search'],
        },
        {
          n: 2,
          title: 'Oracle Plus Diffuser',
          type: 'concept',
          minutes: 14,
          objectives: [
            'Write the Grover iterate as the product of two reflections, one about the marked subspace and one about the uniform state',
            'Derive the diffuser 2|s><s| - I as H^n (2|0><0| - I) H^n and give its gate decomposition',
            'Show that the product of the two reflections is a rotation by 2*theta in the two-dimensional span of the marked and unmarked states',
          ],
          prereqs: ['t2.m2.l1', 't1.m4.l5'],
          sources: ['S2', 'S10', 'S18'],
          tags: ['grover', 'diffuser'],
        },
        {
          n: 3,
          title: 'Choosing the Iteration Count',
          type: 'concept',
          minutes: 12,
          objectives: [
            'Derive the success amplitude sin((2k+1)*theta) with sin(theta) = sqrt(M/N)',
            'Compute the optimal iteration count floor(pi/(4*theta)) for N = 8 with one marked item and for N = 16 with two',
            'Bound the success probability that the optimal integer count achieves when pi/(4*theta) is not an integer',
          ],
          prereqs: ['t2.m2.l2', 't0.m2.l2'],
          sources: ['S2', 'S8', 'S10'],
          tags: ['grover', 'iterations'],
        },
        {
          n: 4,
          title: 'Over-Rotation, Seen on the Bloch Sphere',
          type: 'interactive',
          minutes: 8,
          objectives: [
            'Drive the Grover iterate past its optimum and watch the success probability fall back',
            'Locate the iteration count at which the state returns close to the uniform superposition',
            'Relate the periodicity you observe to the rotation angle 2*theta',
          ],
          prereqs: ['t2.m2.l3', 't1.m1.l8'],
          sources: ['S14', 'S10'],
          tags: ['grover', 'visualisation'],
        },
        {
          n: 5,
          title: 'Amplitude Amplification in General',
          type: 'concept',
          minutes: 14,
          objectives: [
            'Generalise Grover to an arbitrary state-preparation unitary A in place of H^n',
            'Show that the query cost falls to O(1/sqrt(a)) when A prepares a good state with probability a',
            'Apply the generalisation to amplitude estimation and state the resulting precision-versus-cost trade-off',
          ],
          prereqs: ['t2.m2.l4'],
          sources: ['S13', 'S8', 'S18'],
          tags: ['amplitude-amplification'],
        },
        {
          n: 6,
          title: 'Grover for SAT',
          type: 'lab',
          minutes: 35,
          objectives: [
            'Compile a four-clause Boolean formula into a phase oracle on three qubits with no ancillas',
            'Choose the iteration count that maximises the success probability for one marked item out of eight',
            'Reproduce the marked amplitude 11*sqrt(2)/16 predicted by the rotation picture',
          ],
          prereqs: ['t2.m2.l5', 't0.m6.l1', 't1.m4.l6'],
          sources: ['S11', 'S10', 'S9'],
          tags: ['grover', 'sat', 'lab'],
          lab: {
            language: 'qiskit',
            task:
              'Build a Grover circuit on three qubits that finds the unique satisfying assignment of (NOT x0 OR x2) AND (x0 OR x1) AND (NOT x1 OR NOT x2) AND (x0 OR NOT x1 OR x2). Map x0 to qubit 0, x1 to qubit 1, x2 to qubit 2, with qubit 0 the most significant bit. Use a phase oracle plus the standard diffuser, no ancillas, and the iteration count that maximises the success probability.',
            starterCode: [
              'from qiskit import QuantumCircuit',
              '',
              '# x0 -> qubit 0, x1 -> qubit 1, x2 -> qubit 2. Qubit 0 is the most significant bit.',
              '',
              'def build() -> QuantumCircuit:',
              '    qc = QuantumCircuit(3)',
              '    qc.h(range(3))',
              '    # mark the unique satisfying assignment, then reflect about the mean',
              '    # decide the iteration count yourself',
              '    return qc',
            ].join('\n'),
            publicTests: [
              sv('pub-sat-state', 'The marked amplitude dominates after the correct number of iterations', SAT_STATE, {
                tolerance: 1e-6,
              }),
              res('pub-sat-width', 'Three qubits, no ancillas', { maxQubits: 3 }),
            ],
            hiddenTests: [
              sv('hid-sat-state', 'Every amplitude matches the two-iteration Grover state to 1e-9', SAT_STATE, {
                tolerance: 1e-9,
                hidden: true,
              }),
              dist(
                'hid-sat-dist',
                'Sampling returns 101 with probability 121/128 and each other string with probability 1/128',
                SAT_DIST,
                { tolerance: 0.02, shots: 8192, hidden: true },
              ),
              res(
                'hid-sat-cost',
                'At most fifty gates on three qubits: two Grover iterations fit, a wasteful third does not',
                { maxQubits: 3, maxTotalGates: 50 },
                { hidden: true },
              ),
            ],
            bounds: bounds({ maxQubits: 3, timeLimitSeconds: 30, maxShots: 8192 }),
            solution: [
              'from qiskit import QuantumCircuit',
              '',
              'MARKED = "101"',
              '',
              'def mark(qc: QuantumCircuit) -> None:',
              '    for q, b in enumerate(MARKED):',
              '        if b == "0":',
              '            qc.x(q)',
              '    qc.h(2); qc.ccx(0, 1, 2); qc.h(2)',
              '    for q, b in enumerate(MARKED):',
              '        if b == "0":',
              '            qc.x(q)',
              '',
              'def diffuser(qc: QuantumCircuit) -> None:',
              '    qc.h(range(3)); qc.x(range(3))',
              '    qc.h(2); qc.ccx(0, 1, 2); qc.h(2)',
              '    qc.x(range(3)); qc.h(range(3))',
              '',
              'def build() -> QuantumCircuit:',
              '    qc = QuantumCircuit(3)',
              '    qc.h(range(3))',
              '    for _ in range(2):',
              '        mark(qc)',
              '        diffuser(qc)',
              '    return qc',
            ].join('\n'),
          },
        },
        {
          n: 7,
          title: 'Grover for Graph Colouring',
          type: 'lab',
          minutes: 40,
          objectives: [
            'Derive the two proper two-colourings of the four-cycle and encode them as marked bitstrings',
            'Mark a two-element solution set with two masked multi-controlled Z gates on four qubits',
            'Verify that two iterations concentrate 0.9453125 of the probability on the two proper colourings',
          ],
          prereqs: ['t2.m2.l6'],
          sources: ['S11', 'S13'],
          tags: ['grover', 'graph-colouring', 'lab'],
          lab: {
            language: 'qiskit',
            task:
              'Two-colour the four-cycle with edges (0,1), (1,2), (2,3), (3,0) using Grover. Build a circuit on four qubits, one per vertex, whose phase oracle marks exactly the proper two-colourings and which runs the iteration count that maximises success. Use four qubits only: no ancillas.',
            starterCode: [
              'from qiskit import QuantumCircuit',
              '',
              'EDGES = [(0, 1), (1, 2), (2, 3), (3, 0)]',
              '',
              'def build() -> QuantumCircuit:',
              '    qc = QuantumCircuit(4)',
              '    qc.h(range(4))',
              '    # mark every assignment in which no edge joins two equal colours',
              '    # then reflect about the uniform superposition',
              '    return qc',
            ].join('\n'),
            publicTests: [
              sv('pub-col-state', 'Both proper colourings carry amplitude 11/16', COLOUR_STATE, { tolerance: 1e-6 }),
              res('pub-col-width', 'Four qubits, no ancillas', { maxQubits: 4 }),
            ],
            hiddenTests: [
              sv('hid-col-state', 'Every amplitude matches the two-iteration Grover state to 1e-9', COLOUR_STATE, {
                tolerance: 1e-9,
                hidden: true,
              }),
              dist(
                'hid-col-dist',
                'Sampling returns 0101 and 1010 with probability 121/256 each',
                COLOUR_DIST,
                { tolerance: 0.02, shots: 8192, hidden: true },
              ),
              res(
                'hid-col-cost',
                'At most eighty gates on four qubits, which rules out a wasteful third iteration',
                { maxQubits: 4, maxTotalGates: 80 },
                { hidden: true },
              ),
            ],
            bounds: bounds({ maxQubits: 4, timeLimitSeconds: 40, maxShots: 8192 }),
            solution: [
              'from qiskit import QuantumCircuit',
              '',
              'PROPER = ["0101", "1010"]',
              '',
              'def mark(qc: QuantumCircuit, bits: str) -> None:',
              '    for q, b in enumerate(bits):',
              '        if b == "0":',
              '            qc.x(q)',
              '    qc.h(3); qc.mcx([0, 1, 2], 3); qc.h(3)',
              '    for q, b in enumerate(bits):',
              '        if b == "0":',
              '            qc.x(q)',
              '',
              'def diffuser(qc: QuantumCircuit) -> None:',
              '    qc.h(range(4)); qc.x(range(4))',
              '    qc.h(3); qc.mcx([0, 1, 2], 3); qc.h(3)',
              '    qc.x(range(4)); qc.h(range(4))',
              '',
              'def build() -> QuantumCircuit:',
              '    qc = QuantumCircuit(4)',
              '    qc.h(range(4))',
              '    for _ in range(2):',
              '        for bits in PROPER:',
              '            mark(qc, bits)',
              '        diffuser(qc)',
              '    return qc',
            ].join('\n'),
          },
        },
        {
          n: 8,
          title: 'Grover for Bounded Knapsack',
          type: 'lab',
          minutes: 45,
          objectives: [
            'Enumerate the sixteen subsets of a four-item knapsack and identify the single feasible high-value one',
            'Build a phase oracle for a decision version of knapsack with a weight cap and a value floor',
            'Show that three iterations reach success probability 63001/65536 and that a fourth lowers it',
          ],
          prereqs: ['t2.m2.l7'],
          sources: ['S11', 'S13', 'S9'],
          tags: ['grover', 'knapsack', 'lab'],
          lab: {
            language: 'qiskit',
            task:
              'Solve the decision knapsack with weights [3, 4, 5, 7], values [4, 7, 6, 5], weight cap 10 and value floor 12 by Grover search over the sixteen subsets. Qubit i is 1 when item i is taken, qubit 0 most significant. Build the phase oracle for the feasible high-value subsets and run the optimal iteration count on four qubits with no ancillas.',
            starterCode: [
              'from qiskit import QuantumCircuit',
              '',
              'WEIGHTS = [3, 4, 5, 7]',
              'VALUES = [4, 7, 6, 5]',
              'CAP, FLOOR = 10, 12',
              '',
              'def build() -> QuantumCircuit:',
              '    qc = QuantumCircuit(4)',
              '    qc.h(range(4))',
              '    # mark every subset with total weight <= CAP and total value >= FLOOR',
              '    return qc',
            ].join('\n'),
            publicTests: [
              sv('pub-kna-state', 'The single feasible subset carries amplitude 251/256 in magnitude', KNAPSACK_STATE, {
                tolerance: 1e-6,
              }),
              res('pub-kna-width', 'Four qubits, no ancillas', { maxQubits: 4 }),
            ],
            hiddenTests: [
              sv('hid-kna-state', 'Every amplitude matches the three-iteration Grover state to 1e-9', KNAPSACK_STATE, {
                tolerance: 1e-9,
                hidden: true,
              }),
              dist(
                'hid-kna-dist',
                'Sampling returns 0110 with probability 63001/65536',
                KNAPSACK_DIST,
                { tolerance: 0.02, shots: 8192, hidden: true },
              ),
              res(
                'hid-kna-cost',
                'At most ninety-five gates on four qubits: three iterations fit, a fourth does not',
                { maxQubits: 4, maxTotalGates: 95 },
                { hidden: true },
              ),
            ],
            bounds: bounds({ maxQubits: 4, timeLimitSeconds: 45, maxShots: 8192 }),
            solution: [
              'from qiskit import QuantumCircuit',
              '',
              'WEIGHTS = [3, 4, 5, 7]',
              'VALUES = [4, 7, 6, 5]',
              'CAP, FLOOR = 10, 12',
              '',
              'def feasible() -> list[str]:',
              '    out = []',
              '    for k in range(16):',
              '        bits = format(k, "04b")',
              '        w = sum(WEIGHTS[i] for i, b in enumerate(bits) if b == "1")',
              '        v = sum(VALUES[i] for i, b in enumerate(bits) if b == "1")',
              '        if w <= CAP and v >= FLOOR:',
              '            out.append(bits)',
              '    return out',
              '',
              'def mark(qc: QuantumCircuit, bits: str) -> None:',
              '    for q, b in enumerate(bits):',
              '        if b == "0":',
              '            qc.x(q)',
              '    qc.h(3); qc.mcx([0, 1, 2], 3); qc.h(3)',
              '    for q, b in enumerate(bits):',
              '        if b == "0":',
              '            qc.x(q)',
              '',
              'def diffuser(qc: QuantumCircuit) -> None:',
              '    qc.h(range(4)); qc.x(range(4))',
              '    qc.h(3); qc.mcx([0, 1, 2], 3); qc.h(3)',
              '    qc.x(range(4)); qc.h(range(4))',
              '',
              'def build() -> QuantumCircuit:',
              '    qc = QuantumCircuit(4)',
              '    qc.h(range(4))',
              '    for _ in range(3):',
              '        for bits in feasible():',
              '            mark(qc, bits)',
              '        diffuser(qc)',
              '    return qc',
            ].join('\n'),
          },
        },
        {
          n: 9,
          title: 'The BBBV Optimality Bound',
          type: 'concept',
          minutes: 15,
          objectives: [
            'State the hybrid argument of Bennett, Bernstein, Brassard and Vazirani for unstructured search',
            'Derive the Omega(sqrt(N)) query lower bound from the total query magnitude on a hidden index',
            'Explain why the bound forbids a general quantum algorithm for NP-complete problems in polynomial time',
          ],
          prereqs: ['t2.m2.l5', 't2.m1.l4'],
          sources: ['S2', 'S8', 'S18'],
          tags: ['lower-bound', 'grover'],
        },
      ],
    },
    /* ---------------------------------------------------------------- M3 -- */
    {
      n: 3,
      title: 'The Fourier Transform',
      summary:
        'The transform that turns a hidden period into a measurable peak, built circuit by circuit from the classical DFT and costed honestly, including the approximate version that real devices actually run.',
      lessons: [
        {
          n: 1,
          title: 'DFT, Recalled',
          type: 'concept',
          minutes: 12,
          objectives: [
            'Write the N-point DFT matrix in terms of the primitive N-th root of unity and verify it is unitary after normalisation',
            'Compute the DFT of a length-8 periodic sequence by hand and locate its peaks',
            'State the O(N log N) cost of the classical FFT and identify what the quantum version does differently',
          ],
          prereqs: ['t0.m2.l3', 't0.m3.l2'],
          sources: ['S18', 'S8'],
          tags: ['fourier'],
        },
        {
          n: 2,
          title: 'The QFT Circuit and Its Cost',
          type: 'concept',
          minutes: 15,
          objectives: [
            'Derive the product-form factorisation of the QFT that yields the Hadamard plus controlled-phase circuit',
            'Count the gates: n Hadamards, n(n-1)/2 controlled phases, and the final qubit reversal',
            'Explain why the QFT alone gives no speedup because its output amplitudes cannot be read out directly',
          ],
          prereqs: ['t2.m3.l1', 't1.m3.l2', 't1.m8.l1'],
          sources: ['S10', 'S18', 'S9'],
          tags: ['qft', 'circuit'],
        },
        {
          n: 3,
          title: 'QFT over Z_N',
          type: 'concept',
          minutes: 12,
          objectives: [
            'Define the QFT over an arbitrary cyclic group Z_N rather than over Z_2^n',
            'Explain why order finding needs Z_N and how the power-of-two register approximates it',
            'Bound the error introduced when N is not a power of two',
          ],
          prereqs: ['t2.m3.l2'],
          sources: ['S8', 'S13'],
          tags: ['qft', 'group'],
        },
        {
          n: 4,
          title: 'Approximate QFT',
          type: 'concept',
          minutes: 12,
          objectives: [
            'Drop controlled-phase rotations smaller than a cutoff and bound the resulting operator error',
            'Show that keeping O(n log n) rotations suffices for inverse-polynomial accuracy',
            'Argue why the approximate QFT is strictly better on hardware with finite gate fidelity',
          ],
          prereqs: ['t2.m3.l2'],
          sources: ['S8', 'S9'],
          tags: ['qft', 'approximation'],
        },
        {
          n: 5,
          title: 'Fourier Sampling',
          type: 'concept',
          minutes: 14,
          objectives: [
            'Describe the Fourier sampling template: prepare, query, transform, measure',
            'Show that Bernstein-Vazirani is Fourier sampling over Z_2^n with a single query',
            'Predict the measurement distribution when the hidden structure is a coset rather than a single string',
          ],
          prereqs: ['t2.m3.l3', 't1.m10.l3'],
          sources: ['S2', 'S8'],
          tags: ['fourier-sampling'],
        },
        {
          n: 6,
          title: 'Revealing XOR Patterns',
          type: 'concept',
          minutes: 12,
          objectives: [
            'Explain how the Simon algorithm turns a hidden XOR mask into a uniform distribution over its orthogonal complement',
            'Compute the expected number of samples needed to span an (n-1)-dimensional subspace over GF(2)',
            'Solve a three-bit Simon instance by Gaussian elimination over GF(2)',
          ],
          prereqs: ['t2.m3.l5', 't1.m10.l4'],
          sources: ['S2', 'S8', 'S13'],
          tags: ['simon', 'fourier-sampling'],
        },
      ],
    },
    /* ---------------------------------------------------------------- M4 -- */
    {
      n: 4,
      title: 'Phase Estimation',
      summary:
        'The subroutine underneath order finding, quantum chemistry and linear-systems solvers: read an eigenvalue of a unitary into a register, one bit of precision at a time.',
      lessons: [
        {
          n: 1,
          title: "Kitaev's Phase Estimation",
          type: 'concept',
          minutes: 15,
          objectives: [
            'Derive the state (1/sqrt(2^t)) * sum_j exp(2*pi*i*phi*j) |j> produced by the controlled powers of U',
            'Show that the inverse QFT maps that state onto the binary expansion of phi when phi is exactly t bits',
            'Explain why the eigenstate register is unchanged, so the input may be a superposition of eigenvectors',
          ],
          prereqs: ['t2.m3.l2', 't0.m4.l3', 't1.m9.l1'],
          sources: ['S8', 'S18', 'S10'],
          tags: ['qpe', 'eigenvalue'],
        },
        {
          n: 2,
          title: 'Iterative QPE',
          type: 'concept',
          minutes: 12,
          objectives: [
            'Rewrite phase estimation as a single ancilla reused with mid-circuit measurement and feed-forward rotations',
            'Compare the qubit count and the circuit depth of the iterative and the textbook forms',
            'Explain why iterative QPE is the practical choice on hardware with few qubits but fast classical feedback',
          ],
          prereqs: ['t2.m4.l1', 't1.m8.l3'],
          sources: ['S9', 'S8'],
          tags: ['qpe', 'mid-circuit'],
        },
        {
          n: 3,
          title: 'Precision, Ancillas, and Success Probability',
          type: 'concept',
          minutes: 14,
          objectives: [
            'Derive the t = n + ceil(log2(2 + 1/(2*epsilon))) rule for n bits of precision at failure probability epsilon',
            'Compute the probability of landing on the nearest t-bit string when phi is not exactly representable',
            'Bound the number of repetitions needed to recover the correct answer by majority vote',
          ],
          prereqs: ['t2.m4.l2', 't1.m2.l5'],
          sources: ['S18', 'S8'],
          tags: ['qpe', 'precision'],
        },
        {
          n: 4,
          title: 'Lab: Estimate an Eigenphase to Five Bits',
          type: 'lab',
          minutes: 35,
          objectives: [
            'Build a five-bit phase-estimation circuit for the phase gate P(2*pi*5/32) on its eigenstate |1>',
            'Apply controlled powers by exponentiating the phase angle rather than repeating the gate',
            'Confirm that the counting register collapses deterministically onto 00101',
          ],
          prereqs: ['t2.m4.l3', 't2.m3.l4'],
          sources: ['S10', 'S8', 'S9'],
          tags: ['qpe', 'lab'],
          lab: {
            language: 'cirq',
            task:
              'Estimate the eigenphase of the phase gate P(2*pi*5/32) on its eigenstate |1> to five bits. Use qubits 0 to 4 as the counting register with qubit 0 the most significant, and qubit 5 as the eigenstate register. Return the circuit with no measurement gates; the grader reads the six-qubit statevector.',
            starterCode: [
              'import cirq',
              '',
              'PHI = 5 / 32',
              'COUNT = 5',
              '',
              'def build() -> cirq.Circuit:',
              '    qs = cirq.LineQubit.range(COUNT + 1)   # qs[0:5] counting, qs[5] eigenstate',
              '    c = cirq.Circuit([cirq.X(qs[COUNT])])',
              '    # Hadamard the counting register, kick the phase back with controlled powers,',
              '    # then apply the inverse QFT to qs[0:5]',
              '    return c',
            ].join('\n'),
            publicTests: [
              sv('pub-qpe-state', 'The six-qubit state is |001011>, that is 00101 on the counting register', basis(64, 11), {
                tolerance: 1e-6,
              }),
              res('pub-qpe-width', 'Six qubits: five counting plus one eigenstate', { maxQubits: 6 }),
            ],
            hiddenTests: [
              sv('hid-qpe-state', 'The estimate is exact to 1e-9 because 5/32 is a five-bit phase', basis(64, 11), {
                tolerance: 1e-9,
                hidden: true,
              }),
              dist('hid-qpe-dist', 'Sampling returns 001011 every shot', { '001011': 1 }, {
                tolerance: 0.01,
                shots: 4096,
                hidden: true,
              }),
              res(
                'hid-qpe-cost',
                'At most twenty two-qubit gates: exponentiate the phase angle instead of repeating the gate 2^k times',
                { maxQubits: 6, maxTwoQubitGates: 20 },
                { hidden: true },
              ),
            ],
            bounds: bounds({ maxQubits: 6, timeLimitSeconds: 40 }),
            solution: [
              'import cirq',
              '',
              'PHI = 5 / 32',
              'COUNT = 5',
              '',
              'def build() -> cirq.Circuit:',
              '    qs = cirq.LineQubit.range(COUNT + 1)',
              '    c = cirq.Circuit([cirq.X(qs[COUNT])])',
              '    c.append(cirq.H(q) for q in qs[:COUNT])',
              '    for k in range(COUNT):',
              '        reps = 2 ** (COUNT - 1 - k)',
              '        c.append(cirq.CZPowGate(exponent=2 * PHI * reps)(qs[k], qs[COUNT]))',
              '    c.append(cirq.qft(*qs[:COUNT], inverse=True))',
              '    return c',
            ].join('\n'),
          },
        },
      ],
    },
    /* ---------------------------------------------------------------- M5 -- */
    {
      n: 5,
      title: 'Order Finding and Shor',
      summary:
        'Shor factoring assembled from parts you already own: a classical reduction, a reversible arithmetic circuit, phase estimation, and a continued-fraction step that turns a measured phase back into an integer.',
      lessons: [
        {
          n: 1,
          title: 'Factoring Reduces to Order Finding',
          type: 'concept',
          minutes: 14,
          objectives: [
            'State the reduction from factoring N to finding the multiplicative order r of a random a modulo N',
            'Show that gcd(a^(r/2) - 1, N) is a non-trivial factor whenever r is even and a^(r/2) is not -1 mod N',
            'Bound the probability that a random a fails the two conditions above',
          ],
          prereqs: ['t2.m4.l1', 't0.m6.l4'],
          sources: ['S8', 'S18', 'S13'],
          tags: ['shor', 'number-theory'],
        },
        {
          n: 2,
          title: 'Modular Exponentiation Circuits',
          type: 'concept',
          minutes: 15,
          objectives: [
            'Build controlled modular multiplication from reversible adders and comparison circuits',
            'Show that multiplication by 7 modulo 15 is a cyclic bit shift followed by a bitwise complement',
            'Estimate the gate count of controlled modular exponentiation as a function of the register width',
          ],
          prereqs: ['t2.m5.l1', 't0.m6.l5', 't0.m6.l3'],
          sources: ['S13', 'S9', 'S8'],
          tags: ['shor', 'arithmetic'],
        },
        {
          n: 3,
          title: 'Continued-Fraction Post-Processing',
          type: 'concept',
          minutes: 14,
          objectives: [
            'Expand a measured ratio s/2^t as a continued fraction and list its convergents',
            'Select the convergent whose denominator is the order, using the bound |s/2^t - k/r| < 1/(2*r^2)',
            'Recover r = 4 from the measurement 4 with a four-bit counting register',
          ],
          prereqs: ['t2.m5.l1', 't2.m4.l3'],
          sources: ['S18', 'S8'],
          tags: ['shor', 'continued-fractions'],
        },
        {
          n: 4,
          title: 'Putting Shor Together',
          type: 'lab',
          minutes: 45,
          objectives: [
            'Assemble the order-finding circuit for a = 7 modulo 15 with a four-qubit counting register',
            'Skip the controlled powers whose exponent is a multiple of the order, since they act as the identity',
            'Recover the factors 3 and 5 from the measured phases by continued fractions',
          ],
          prereqs: ['t2.m5.l2', 't2.m5.l3', 't2.m4.l4'],
          sources: ['S13', 'S9', 'S8'],
          tags: ['shor', 'order-finding', 'lab'],
          lab: {
            language: 'cirq',
            task:
              'Build the order-finding circuit for a = 7 modulo N = 15. Use qubits 0 to 3 as the counting register with qubit 0 most significant, and qubits 4 to 7 as the work register with qubit 4 most significant. Load the work register with the value 1, apply the controlled powers of multiplication by 7 modulo 15, invert the QFT on the counting register, and measure the counting register only. Also set the module-level names order and factors from the continued-fraction post-processing.',
            starterCode: [
              'import cirq',
              '',
              'A, N, COUNT = 7, 15, 4',
              '',
              'def build() -> cirq.Circuit:',
              '    q = cirq.LineQubit.range(8)   # q[0:4] counting, q[4:8] work',
              '    c = cirq.Circuit()',
              '    # load |0001> into the work register, superpose the counting register,',
              '    # apply controlled multiplication by 7^(2^j) mod 15, invert the QFT,',
              '    # then measure q[0:4] only',
              '    return c',
              '',
              'order = 0',
              'factors: list[int] = []',
            ].join('\n'),
            publicTests: [
              dist(
                'pub-shor-dist',
                'The counting register is uniform on 0000, 0100, 1000 and 1100 because the order divides 16',
                { '0000': 0.25, '0100': 0.25, '1000': 0.25, '1100': 0.25 },
                { tolerance: 0.05, shots: 8192 },
              ),
              val('pub-shor-order', 'The multiplicative order of 7 modulo 15 is 4', 'order', 4),
            ],
            hiddenTests: [
              dist(
                'hid-shor-dist',
                'Each of the four peaks carries probability 1/4 to within 0.02 total variation',
                { '0000': 0.25, '0100': 0.25, '1000': 0.25, '1100': 0.25 },
                { tolerance: 0.02, shots: 16384, hidden: true },
              ),
              val('hid-shor-factors', 'Continued fractions yield the factors 3 and 5', 'factors', [3, 5], {
                hidden: true,
              }),
              res(
                'hid-shor-cost',
                'Eight qubits and at most fifty gates: the controlled powers with exponent 4 and 8 are the identity and must be omitted',
                { maxQubits: 8, maxTotalGates: 50 },
                { hidden: true },
              ),
            ],
            bounds: bounds({ maxQubits: 8, timeLimitSeconds: 60, maxShots: 16384 }),
            solution: [
              'import cirq',
              'from math import gcd',
              '',
              'A, N, COUNT = 7, 15, 4',
              '',
              'def times7(c, ctrl, w):',
              '    # multiply by 8 (cyclic right shift of the bits) then complement: 8x -> 15 - 8x = 7x',
              '    c.append(cirq.CSWAP(ctrl, w[2], w[3]))',
              '    c.append(cirq.CSWAP(ctrl, w[1], w[2]))',
              '    c.append(cirq.CSWAP(ctrl, w[0], w[1]))',
              '    for t in w:',
              '        c.append(cirq.CNOT(ctrl, t))',
              '',
              'def times4(c, ctrl, w):',
              '    c.append(cirq.CSWAP(ctrl, w[0], w[2]))',
              '    c.append(cirq.CSWAP(ctrl, w[1], w[3]))',
              '',
              'def build() -> cirq.Circuit:',
              '    q = cirq.LineQubit.range(8)',
              '    cnt, w = q[:4], q[4:]',
              '    c = cirq.Circuit([cirq.X(w[3])])',
              '    c.append(cirq.H(x) for x in cnt)',
              '    times7(c, cnt[3], w)   # exponent 1',
              '    times4(c, cnt[2], w)   # exponent 2, since 7^2 = 4 mod 15',
              '    # exponents 4 and 8 act as the identity because 7^4 = 1 mod 15',
              '    c.append(cirq.qft(*cnt, inverse=True))',
              '    c.append(cirq.measure(*cnt, key="m"))',
              '    return c',
              '',
              'order = 4',
              'factors = sorted({gcd(A ** (order // 2) - 1, N), gcd(A ** (order // 2) + 1, N)})',
            ].join('\n'),
          },
        },
        {
          n: 5,
          title: 'Discrete Logarithm',
          type: 'concept',
          minutes: 15,
          objectives: [
            'Set up the two-register phase estimation that solves discrete log in a cyclic group',
            'Show that the measured pair of phases determines the exponent by one linear equation modulo r',
            'Explain why the same circuit breaks both finite-field and elliptic-curve discrete log',
          ],
          prereqs: ['t2.m5.l4', 't2.m3.l3'],
          sources: ['S13', 'S8'],
          tags: ['discrete-log', 'cryptanalysis'],
        },
      ],
    },
    /* ---------------------------------------------------------------- M6 -- */
    {
      n: 6,
      title: 'The Hidden Subgroup Problem',
      summary:
        'The single frame that contains Simon, Shor and discrete log, and the precise point at which it stops delivering: the non-abelian case that would give graph isomorphism.',
      lessons: [
        {
          n: 1,
          title: 'The Abelian HSP Framework',
          type: 'concept',
          minutes: 14,
          objectives: [
            'State the hidden subgroup problem for a finite abelian group G and a function constant on cosets of H',
            'Show that coset-state sampling followed by the QFT over G yields a uniform sample from the annihilator of H',
            'Instantiate the framework to recover Simon, order finding and discrete log',
          ],
          prereqs: ['t2.m3.l6', 't2.m5.l5'],
          sources: ['S8', 'S13', 'S2'],
          tags: ['hsp', 'group'],
        },
        {
          n: 2,
          title: 'What the Abelian Case Buys You',
          type: 'concept',
          minutes: 12,
          objectives: [
            'Count the queries the abelian HSP algorithm needs as a function of log |G|',
            'Explain why the speedup is exponential over the best known classical algorithms but not proven unconditional',
            'List two problems outside cryptography that reduce to abelian HSP',
          ],
          prereqs: ['t2.m6.l1'],
          sources: ['S13', 'S8'],
          tags: ['hsp'],
        },
        {
          n: 3,
          title: 'Non-Abelian HSP and Where It Breaks',
          type: 'concept',
          minutes: 14,
          objectives: [
            'Explain why the coset state still contains the answer information-theoretically in the non-abelian case',
            'Identify the missing ingredient: an efficient measurement that extracts the hidden subgroup from the coset state',
            'Relate the symmetric-group case to graph isomorphism and the dihedral case to lattice problems',
          ],
          prereqs: ['t2.m6.l2'],
          sources: ['S13', 'S2', 'S3'],
          tags: ['hsp', 'open-problem'],
        },
      ],
    },
    /* ---------------------------------------------------------------- M7 -- */
    {
      n: 7,
      title: 'Quantum Walks',
      summary:
        'The second algorithmic primitive after amplitude amplification, and the source of the only proven exponential black-box separation on a natural graph problem.',
      lessons: [
        {
          n: 1,
          title: 'Coined Walks',
          type: 'concept',
          minutes: 13,
          objectives: [
            'Define the coin plus shift operator for a discrete-time walk on a regular graph',
            'Compare the linear spreading of a quantum walk on the line with the square-root spreading of the classical walk',
            'Show that measuring the coin at every step recovers the classical random walk exactly',
          ],
          prereqs: ['t2.m6.l3', 't0.m1.l3'],
          sources: ['S13', 'S3'],
          tags: ['quantum-walk'],
        },
        {
          n: 2,
          title: 'Continuous-Time Walks',
          type: 'concept',
          minutes: 13,
          objectives: [
            'Define the continuous-time walk as exp(-i*A*t) for the adjacency matrix A',
            'Relate the hitting time of the walk to the spectral gap of A',
            'Explain why the continuous-time walk needs no coin register',
          ],
          prereqs: ['t2.m7.l1', 't0.m4.l4'],
          sources: ['S13', 'S3'],
          tags: ['quantum-walk', 'spectral'],
        },
        {
          n: 3,
          title: 'Element Distinctness',
          type: 'concept',
          minutes: 14,
          objectives: [
            'Describe the Ambainis walk on the Johnson graph that solves element distinctness',
            'Derive the O(N^(2/3)) query cost from the setup, update and checking costs',
            'Explain why the bound is tight, citing the adversary lower bound',
          ],
          prereqs: ['t2.m7.l1', 't2.m2.l5'],
          sources: ['S13', 'S2'],
          tags: ['quantum-walk', 'element-distinctness'],
        },
        {
          n: 4,
          title: 'Welded Tree',
          type: 'concept',
          minutes: 12,
          objectives: [
            'Describe the welded-tree graph and the entrance-to-exit traversal problem',
            'Explain why a classical walk needs exponentially many queries while the continuous-time walk needs polynomially many',
            'Identify the column-space symmetry that reduces the walk to a line',
          ],
          prereqs: ['t2.m7.l2'],
          sources: ['S13', 'S3'],
          tags: ['quantum-walk', 'separation'],
        },
        {
          n: 5,
          title: 'Graph Collision',
          type: 'concept',
          minutes: 12,
          objectives: [
            'State the graph collision problem and its role inside triangle-finding algorithms',
            'Compare the walk-based upper bound with the best known classical bound',
            'Explain why graph collision resisted tight analysis for a decade',
          ],
          prereqs: ['t2.m7.l3'],
          sources: ['S13', 'S2'],
          tags: ['quantum-walk', 'graph'],
        },
      ],
    },
    /* ---------------------------------------------------------------- M8 -- */
    {
      n: 8,
      title: 'Hamiltonian Simulation',
      summary:
        "Feynman's original motivation, made concrete: product formulas with provable error bounds, the modern block-encoding alternative, and a lab that evolves a spin chain and checks every amplitude.",
      lessons: [
        {
          n: 1,
          title: 'Trotter-Suzuki and Its Error Bound',
          type: 'concept',
          minutes: 15,
          objectives: [
            'Derive the first-order product formula error O(t^2/r) from the commutator of the Hamiltonian terms',
            'Show that the error vanishes when the terms commute, and give the two-site XY chain as an example',
            'Choose r so that the simulation error over time t stays below a target epsilon',
          ],
          prereqs: ['t0.m4.l4', 't2.m7.l2'],
          sources: ['S8', 'S13', 'S3'],
          tags: ['simulation', 'trotter'],
        },
        {
          n: 2,
          title: 'Higher-Order Formulas',
          type: 'concept',
          minutes: 12,
          objectives: [
            'Write the second-order symmetric Suzuki formula and state its O(t^3/r^2) error',
            'Explain how the recursive Suzuki construction reaches order 2k at cost 5^(k-1) per step',
            'Decide when the extra gates of a higher-order formula pay for themselves',
          ],
          prereqs: ['t2.m8.l1'],
          sources: ['S13', 'S8'],
          tags: ['simulation', 'trotter'],
        },
        {
          n: 3,
          title: 'LCU and Qubitisation, Conceptually',
          type: 'concept',
          minutes: 15,
          objectives: [
            'Express a Hamiltonian as a linear combination of unitaries and describe the prepare-select-unprepare pattern',
            'Explain how qubitisation turns a block encoding into a walk operator whose eigenphases encode the spectrum',
            'Compare the query scaling of qubitisation with that of product formulas in t and in epsilon',
          ],
          prereqs: ['t2.m8.l2', 't2.m4.l1'],
          sources: ['S13', 'S3'],
          tags: ['simulation', 'lcu'],
        },
        {
          n: 4,
          title: 'Simulating the XY and Heisenberg Chains',
          type: 'lab',
          minutes: 40,
          objectives: [
            'Build a first-order Trotter circuit for a three-site XY chain with a fixed bond ordering',
            'Confirm that the XY interaction conserves the excitation number by checking that only weight-one strings appear',
            'Reproduce the site probabilities 0.33130, 0.41346 and 0.25524 after four Trotter steps at t = 0.5',
          ],
          prereqs: ['t2.m8.l2', 't1.m4.l4'],
          sources: ['S10', 'S15', 'S13'],
          tags: ['simulation', 'spin-chain', 'lab'],
          lab: {
            language: 'cirq',
            task:
              'Build the first-order Trotter circuit for the three-site XY chain H = (X0X1 + Y0Y1) + (X1X2 + Y1Y2), evolving the initial state |100> for time t = 0.5 in r = 4 equal steps. Within every step apply exp(-i*tau*(X0X1 + Y0Y1)) before exp(-i*tau*(X1X2 + Y1Y2)), with tau = t / r. Return the circuit with no measurement gates.',
            starterCode: [
              'import cirq',
              '',
              'T, R = 0.5, 4',
              '',
              'def build() -> cirq.Circuit:',
              '    q = cirq.LineQubit.range(3)',
              '    c = cirq.Circuit([cirq.X(q[0])])',
              '    # tau = T / R; each step is the (0,1) bond then the (1,2) bond,',
              '    # every bond being exp(-i*tau*XX) followed by exp(-i*tau*YY)',
              '    return c',
            ].join('\n'),
            publicTests: [
              dist(
                'pub-xy-dist',
                'The excitation stays on one site: only 100, 010 and 001 have weight',
                { '100': 0.33130, '010': 0.41346, '001': 0.25524 },
                { tolerance: 0.03, shots: 8192 },
              ),
              res('pub-xy-width', 'Three qubits and nothing else', { maxQubits: 3 }),
            ],
            hiddenTests: [
              sv(
                'hid-xy-state',
                'Amplitudes after four Trotter steps match the reference to 1e-7',
                superpose(8, {
                  1: [-0.5052123959474666, 0],
                  2: [0, -0.6430102461001930],
                  4: [0.5755851443454578, 0],
                }),
                { tolerance: 1e-7, hidden: true },
              ),
              dist(
                'hid-xy-dist',
                'Site probabilities match to 0.015 total variation',
                { '100': 0.33130, '010': 0.41346, '001': 0.25524 },
                { tolerance: 0.015, shots: 16384, hidden: true },
              ),
              res(
                'hid-xy-cost',
                'At most thirty-six two-qubit gates: four steps of two bonds, not eight',
                { maxQubits: 3, maxTwoQubitGates: 36 },
                { hidden: true },
              ),
            ],
            bounds: bounds({ maxQubits: 3, timeLimitSeconds: 40, maxShots: 16384 }),
            solution: [
              'import cirq',
              'import numpy as np',
              '',
              'T, R = 0.5, 4',
              '',
              'def bond(a, b, tau):',
              '    yield cirq.XXPowGate(exponent=2 * tau / np.pi, global_shift=-0.5)(a, b)',
              '    yield cirq.YYPowGate(exponent=2 * tau / np.pi, global_shift=-0.5)(a, b)',
              '',
              'def build() -> cirq.Circuit:',
              '    q = cirq.LineQubit.range(3)',
              '    c = cirq.Circuit([cirq.X(q[0])])',
              '    tau = T / R',
              '    for _ in range(R):',
              '        c.append(bond(q[0], q[1], tau))',
              '        c.append(bond(q[1], q[2], tau))',
              '    return c',
            ].join('\n'),
          },
        },
        {
          n: 5,
          title: 'Fermi-Hubbard Dynamics',
          type: 'concept',
          minutes: 14,
          objectives: [
            'Write the Fermi-Hubbard Hamiltonian and separate its hopping and on-site interaction terms',
            'Explain why the fermionic anticommutation relations force a non-local encoding on a qubit register',
            'Estimate the Trotter step count needed to follow spin-charge separation on a small chain',
          ],
          prereqs: ['t2.m8.l4', 't2.m8.l3'],
          sources: ['S9', 'S13'],
          tags: ['simulation', 'fermi-hubbard'],
        },
      ],
    },
    /* ---------------------------------------------------------------- M9 -- */
    {
      n: 9,
      title: 'Lower Bounds and Complexity',
      summary:
        'The half of the subject that says no. Two lower-bound techniques, the complexity class BQP and its neighbours, and the classical simulation methods that keep shrinking the space where a quantum advantage can live.',
      lessons: [
        {
          n: 1,
          title: 'The Polynomial Method',
          type: 'concept',
          minutes: 15,
          objectives: [
            'Show that a T-query quantum algorithm induces a real polynomial of degree at most 2T in the input bits',
            'Derive the Omega(sqrt(N)) bound for OR from the approximate degree of the OR function',
            'Explain why the method is tight for symmetric functions and lossy in general',
          ],
          prereqs: ['t2.m2.l9', 't2.m1.l4'],
          sources: ['S2', 'S8'],
          tags: ['lower-bound', 'polynomial-method'],
        },
        {
          n: 2,
          title: 'The Adversary Method',
          type: 'concept',
          minutes: 15,
          objectives: [
            'State the basic adversary bound in terms of a relation between zero-inputs and one-inputs',
            'Apply the method to reprove the Omega(sqrt(N)) bound for unstructured search',
            'Explain what the negative-weight generalisation buys and why it characterises quantum query complexity',
          ],
          prereqs: ['t2.m9.l1'],
          sources: ['S2', 'S8'],
          tags: ['lower-bound', 'adversary'],
        },
        {
          n: 3,
          title: 'BQP and Its Neighbours',
          type: 'concept',
          minutes: 14,
          objectives: [
            'Define BQP and situate it between BPP and PSPACE',
            'Explain why BQP is not believed to contain NP, and what the BBBV bound contributes to that belief',
            'Distinguish an oracle separation from an unrelativised one, using Simon as the example',
          ],
          prereqs: ['t0.m6.l4', 't2.m9.l2'],
          sources: ['S2', 'S1', 'S8'],
          tags: ['complexity', 'bqp'],
        },
        {
          n: 4,
          title: 'Gottesman-Knill and Classical Simulability',
          type: 'concept',
          minutes: 13,
          objectives: [
            'State the Gottesman-Knill theorem and identify the gate set it covers',
            'Explain why entanglement alone cannot be the resource behind quantum speedup',
            'Describe how stabilizer-rank methods extend the simulation to circuits with a few T gates',
          ],
          prereqs: ['t2.m9.l3', 't1.m3.l2'],
          sources: ['S1', 'S3', 'S18'],
          tags: ['simulability', 'clifford'],
        },
        {
          n: 5,
          title: 'Tensor-Network Simulation',
          type: 'concept',
          minutes: 14,
          objectives: [
            'Explain how a matrix-product state bounds simulation cost by the bond dimension across every cut',
            'Relate the bond dimension needed to the entanglement entropy of the state being simulated',
            'Explain why tensor-network contraction beats statevector simulation on shallow or geometrically local circuits',
          ],
          prereqs: ['t2.m9.l4', 't1.m5.l5'],
          sources: ['S15', 'S3'],
          tags: ['simulability', 'tensor-network'],
        },
        {
          n: 6,
          title: 'Random Circuit Sampling and What Utility Claims Mean',
          type: 'concept',
          minutes: 15,
          objectives: [
            'Describe the random circuit sampling task and the linear cross-entropy score used to grade it',
            'Explain why a sampling advantage claim is falsified by any faster classical simulation of the same instance',
            'Distinguish a sampling advantage from a useful computation, and state what an honest utility claim must report',
          ],
          prereqs: ['t2.m9.l5', 't1.m11.l5'],
          sources: ['S15', 'S9', 'S1'],
          tags: ['advantage', 'benchmarking'],
        },
      ],
    },
    /* --------------------------------------------------------------- M10 -- */
    {
      n: 10,
      title: 'Zoo Lab',
      summary:
        'The track capstone: six algorithms implemented from the Quantum Algorithm Zoo taxonomy, each with its speedup classified and its resource cost measured rather than asserted.',
      lessons: [
        {
          n: 1,
          title: 'Project: Implement Six Algorithms from the Quantum Algorithm Zoo',
          type: 'project',
          minutes: 300,
          objectives: [
            'Implement six algorithms spanning the algebraic, oracular and simulation branches of the Zoo taxonomy',
            'Classify each speedup as exponential, quadratic or unproven, and name the classical baseline it is measured against',
            'Report gate count, depth and qubit count for each implementation at two problem sizes',
            'Defend one implementation where the measured resource cost contradicts the asymptotic claim',
          ],
          prereqs: ['t2.m2.l8', 't2.m5.l4', 't2.m7.l5', 't2.m8.l4', 't2.m9.l6'],
          sources: ['S13', 'S9', 'S10'],
          tags: ['project', 'zoo'],
        },
      ],
    },
  ],
};
