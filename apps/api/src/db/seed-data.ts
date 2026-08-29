/**
 * Seed content, transcribed from `docs/research/02-syllabus.md`.
 *
 * The syllabus is the product's specification for what exists: 8 tracks, 64
 * modules and the lesson list under each. It is kept as data rather than as
 * migration SQL because content ships far more often than schema does, and
 * because the DAG edges are derived from this ordering rather than written out
 * by hand.
 */

export interface ModuleSeed {
  code: string;
  title: string;
  lessons: readonly string[];
}

export interface TrackSeed {
  code: string;
  title: string;
  level: 'L0' | 'L1' | 'L2' | 'L3';
  modules: readonly ModuleSeed[];
}

export const SYLLABUS: readonly TrackSeed[] = [
  {
    code: "T0",
    title: "Mathematical and Computational Foundations",
    level: "L0",
    modules: [
      {
        code: "T0.M1",
        title: "Probability and Information",
        lessons: [
          "Bits and states",
          "Coin-flipping games and probabilistic states",
          "Probabilistic operators and stochastic matrices",
          "Joint distributions, marginals, correlation",
          "Shannon entropy as a resource",
        ],
      },
      {
        code: "T0.M2",
        title: "Complex Numbers",
        lessons: [
          "Complex arithmetic, modulus, argument",
          "Euler's formula and the unit circle",
          "Roots of unity",
        ],
      },
      {
        code: "T0.M3",
        title: "Vectors and Vector Spaces",
        lessons: [
          "Column vectors, inner products, norms",
          "Orthonormal bases and change of basis",
          "Dirac notation: kets, bras, brackets",
        ],
      },
      {
        code: "T0.M4",
        title: "Matrices and Operators",
        lessons: [
          "Matrix arithmetic and adjoints",
          "Unitary, Hermitian, projector",
          "Eigendecomposition and the spectral theorem",
          "Functions of matrices and the matrix exponential",
        ],
      },
      {
        code: "T0.M5",
        title: "Tensor Products",
        lessons: [
          "Kronecker product and index conventions",
          "Composite systems",
          "Qubit ordering: little-endian vs big-endian (and why every SDK disagrees)",
        ],
      },
      {
        code: "T0.M6",
        title: "Classical Computation",
        lessons: [
          "Boolean gates and universality",
          "Circuit depth, width, fan-out",
          "Reversible computation, Toffoli, uncomputation, Landauer",
          "P, BPP, NP, PSPACE",
        ],
      },
      {
        code: "T0.M7",
        title: "Python for Quantum",
        lessons: [
          "NumPy for statevectors and operators",
          "Verifying identities numerically",
          "Plotting distributions with error bars",
        ],
      },
      {
        code: "T0.M8",
        title: "Placement",
        lessons: [
          "Diagnostic checkpoint that writes directly to the learner's DAG",
        ],
      },
    ],
  },
  {
    code: "T1",
    title: "Quantum Computing Core",
    level: "L1",
    modules: [
      {
        code: "T1.M1",
        title: "The Qubit",
        lessons: [
          "From probabilistic bit to real-valued qubit",
          "Hadamard as a rotation on the unit circle",
          "Superposition and amplitude",
          "The normalisation constraint, geometrically",
          "Why \\|0⟩ is not the zero vector",
          "Complex amplitudes",
          "Global vs relative phase",
          "The Bloch sphere",
        ],
      },
      {
        code: "T1.M2",
        title: "Measurement",
        lessons: [
          "Computational-basis measurement and the Born rule",
          "Collapse",
          "Measuring in other bases",
          "Single-qubit tomography",
          "Shots, sampling noise, and error bars",
        ],
      },
      {
        code: "T1.M3",
        title: "Single-Qubit Gates",
        lessons: [
          "X, Y, Z",
          "H, S, T and the phase family",
          "Rx, Ry, Rz and general U",
          "Unitarity as length preservation; the dagger",
          "Euler decomposition",
          "Gate identities and simplification",
        ],
      },
      {
        code: "T1.M4",
        title: "Multi-Qubit Systems",
        lessons: [
          "Tensor products of states",
          "The 2^n amplitude vector",
          "Product vs entangled states",
          "CNOT, CZ, SWAP",
          "Controlled-U and multi-controlled constructions",
          "Toffoli and Fredkin",
        ],
      },
      {
        code: "T1.M5",
        title: "Entanglement",
        lessons: [
          "The four Bell states",
          "Partial measurement and \"spooky action\"",
          "Reduced states and the partial trace, informally",
          "No-cloning",
          "Schmidt rank and entanglement entropy",
        ],
      },
      {
        code: "T1.M6",
        title: "Nonlocality and Games",
        lessons: [
          "Bell's inequality",
          "The CHSH game",
          "GHZ game",
          "Mermin-Peres magic square",
          "Elitzur-Vaidman bomb tester",
        ],
      },
      {
        code: "T1.M7",
        title: "Protocols",
        lessons: [
          "Superdense coding",
          "Quantum teleportation",
          "Entanglement swapping",
          "Quantum money",
          "BB84",
        ],
      },
      {
        code: "T1.M8",
        title: "The Circuit Model",
        lessons: [
          "Circuits, depth, width, barriers",
          "Deferred measurement",
          "Mid-circuit measurement and reset",
          "Classical control and conditional gates",
          "Universal gate sets",
          "Solovay-Kitaev, stated",
        ],
      },
      {
        code: "T1.M9",
        title: "Phase and Interference",
        lessons: [
          "Phase kickback",
          "Rotate, compute, rotate",
          "Reading the Q-sphere",
          "Interference as the engine of every speedup",
        ],
      },
      {
        code: "T1.M10",
        title: "First Algorithms",
        lessons: [
          "Deutsch's algorithm",
          "Deutsch-Jozsa",
          "Bernstein-Vazirani",
          "Simon's algorithm",
        ],
      },
      {
        code: "T1.M11",
        title: "Meeting Noise Early",
        lessons: [
          "Where noise comes from",
          "Relaxation and dephasing, observed",
          "Depolarising and readout error, hands-on",
          "Fidelity of a noisy Bell pair",
          "Why depth costs you",
        ],
      },
      {
        code: "T1.M12",
        title: "Capstone",
        lessons: [
          "Project: build, run and benchmark a Bell-state experiment end to end",
        ],
      },
    ],
  },
  {
    code: "T2",
    title: "Quantum Algorithms and Complexity",
    level: "L2",
    modules: [
      {
        code: "T2.M1",
        title: "The Query Model",
        lessons: [
          "Oracles and how to build one",
          "Bit-flip vs phase oracles",
          "Marking oracles",
          "Query complexity, defined",
        ],
      },
      {
        code: "T2.M2",
        title: "Amplitude Amplification and Grover",
        lessons: [
          "Unstructured search",
          "Oracle plus diffuser",
          "Choosing the iteration count",
          "Over-rotation, seen on the Bloch sphere",
          "Amplitude amplification in general",
          "Grover for SAT",
          "Grover for graph colouring",
          "Grover for bounded knapsack",
          "The BBBV optimality bound",
        ],
      },
      {
        code: "T2.M3",
        title: "The Fourier Transform",
        lessons: [
          "DFT, recalled",
          "The QFT circuit and its cost",
          "QFT over Z_N",
          "Approximate QFT",
          "Fourier sampling",
          "Revealing XOR patterns",
        ],
      },
      {
        code: "T2.M4",
        title: "Phase Estimation",
        lessons: [
          "Kitaev's phase estimation",
          "Iterative QPE",
          "Precision, ancillas, and success probability",
        ],
      },
      {
        code: "T2.M5",
        title: "Order Finding and Shor",
        lessons: [
          "Factoring reduces to order finding",
          "Modular exponentiation circuits",
          "Continued-fraction post-processing",
          "Putting Shor together",
          "Discrete logarithm",
        ],
      },
      {
        code: "T2.M6",
        title: "The Hidden Subgroup Problem",
        lessons: [
          "The abelian HSP framework",
          "What the abelian case buys you",
          "Non-abelian HSP and where it breaks",
        ],
      },
      {
        code: "T2.M7",
        title: "Quantum Walks",
        lessons: [
          "Coined walks",
          "Continuous-time walks",
          "Element distinctness",
          "Welded tree",
          "Graph collision",
        ],
      },
      {
        code: "T2.M8",
        title: "Hamiltonian Simulation",
        lessons: [
          "Trotter-Suzuki and its error bound",
          "Higher-order formulas",
          "LCU and qubitisation, conceptually",
          "Simulating the XY and Heisenberg chains",
          "Fermi-Hubbard dynamics",
        ],
      },
      {
        code: "T2.M9",
        title: "Lower Bounds and Complexity",
        lessons: [
          "The polynomial method",
          "The adversary method",
          "BQP and its neighbours",
          "Gottesman-Knill and classical simulability",
          "Tensor-network simulation",
          "Random circuit sampling and what \"utility\" claims mean",
        ],
      },
      {
        code: "T2.M10",
        title: "Zoo Lab",
        lessons: [
          "Project: implement six algorithms drawn from the Quantum Algorithm Zoo taxonomy and classify their speedups",
        ],
      },
    ],
  },
  {
    code: "T3",
    title: "Quantum Software Engineering",
    level: "L1",
    modules: [
      {
        code: "T3.M1",
        title: "The SDK Landscape",
        lessons: [
          "The same circuit in five SDKs",
          "Choosing an SDK per task",
          "Interop through OpenQASM 3 and QIR",
          "Provider abstraction: the QRN addressing pattern",
        ],
      },
      {
        code: "T3.M2",
        title: "OpenQASM 3",
        lessons: [
          "Syntax and gate declarations",
          "Subroutines and classical control",
          "Round-tripping IR to QASM and back",
        ],
      },
      {
        code: "T3.M3",
        title: "Transpilation",
        lessons: [
          "Layout selection",
          "Routing and SWAP insertion",
          "Basis translation",
          "Optimisation levels, measured",
          "Coupling maps and topology-aware mapping",
          "ZX-calculus rewriting for gate reduction",
        ],
      },
      {
        code: "T3.M4",
        title: "Resource Estimation",
        lessons: [
          "Counting gates, depth, and two-qubit gates",
          "T-count and why it dominates",
          "Shor at scale: logical to physical",
        ],
      },
      {
        code: "T3.M5",
        title: "Hybrid Runtimes",
        lessons: [
          "Parameterised circuits and batching",
          "Sessions and latency budgets",
          "Circuit caching",
          "The HPC to QPU loop",
        ],
      },
      {
        code: "T3.M6",
        title: "Testing Quantum Code",
        lessons: [
          "Asserting on unitaries",
          "Statevector assertions",
          "Distribution tests and shot budgeting",
          "Property-based testing of circuit identities",
          "What a wrong amplitude looks like",
        ],
      },
      {
        code: "T3.M7",
        title: "Noise Models and Benchmarking",
        lessons: [
          "Kraus operators and Pauli channels",
          "Building a device noise model",
          "Randomised benchmarking",
          "XEB and quantum volume",
          "Readout calibration matrices",
        ],
      },
      {
        code: "T3.M8",
        title: "Error Mitigation",
        lessons: [
          "Measurement-error mitigation",
          "Zero-noise extrapolation",
          "Probabilistic error cancellation",
          "Dynamical decoupling",
          "When mitigation lies to you",
        ],
      },
      {
        code: "T3.M9",
        title: "Capstone",
        lessons: [
          "Project: write a transpiler pass and prove it preserves semantics",
        ],
      },
    ],
  },
  {
    code: "T4",
    title: "Noise, Error Correction and Fault Tolerance",
    level: "L2",
    modules: [
      {
        code: "T4.M1",
        title: "Open Systems",
        lessons: [
          "Density matrices",
          "Mixed states and convex combinations",
          "The Bloch ball",
          "Partial trace and reduced states",
          "Quantum channels",
          "Kraus and Stinespring representations",
          "Choi-Jamiołkowski",
          "Purification",
          "Fidelity, trace distance, diamond norm",
        ],
      },
      {
        code: "T4.M2",
        title: "General Measurement",
        lessons: [
          "POVMs",
          "Naimark's theorem",
          "State discrimination",
          "Tomography and its cost",
        ],
      },
      {
        code: "T4.M3",
        title: "From Classical to Quantum Codes",
        lessons: [
          "The repetition code",
          "Bit-flip and phase-flip codes",
          "The Shor 9-qubit code",
          "Discretisation of errors",
        ],
      },
      {
        code: "T4.M4",
        title: "The Stabilizer Formalism",
        lessons: [
          "The Pauli group",
          "Stabilizer groups and syndromes",
          "Syndrome extraction circuits",
          "The Clifford group",
          "Gottesman-Knill",
          "Steane's 7-qubit code",
          "The CSS construction",
        ],
      },
      {
        code: "T4.M5",
        title: "Topological Codes",
        lessons: [
          "The toric code",
          "The surface code and planar layouts",
          "Code distance",
          "MWPM decoding",
          "Union-find decoding",
          "Thresholds",
        ],
      },
      {
        code: "T4.M6",
        title: "Fault Tolerance",
        lessons: [
          "Controlling error propagation",
          "Transversal gates and the Eastin-Knill obstruction",
          "Magic-state distillation",
          "T-gate cost accounting",
          "The threshold theorem",
        ],
      },
      {
        code: "T4.M7",
        title: "Beyond the Surface Code",
        lessons: [
          "Colour codes",
          "qLDPC codes",
          "Bosonic codes: cat and GKP",
          "Measurement-based computation and cluster states",
        ],
      },
      {
        code: "T4.M8",
        title: "Decoder Lab",
        lessons: [
          "Project: decode a surface-code syndrome stream and measure your logical error rate",
        ],
      },
    ],
  },
  {
    code: "T5",
    title: "Applications",
    level: "L2",
    modules: [
      {
        code: "T5A.M1",
        title: "Chemistry and Materials",
        lessons: [
          "Second quantisation",
          "Jordan-Wigner and Bravyi-Kitaev mappings",
          "Building a molecular Hamiltonian",
          "Ansätze: UCCSD and hardware-efficient",
          "Classical optimisers for VQE",
          "Ground-state energy of H₂",
          "LiH and potential-energy surfaces",
          "Measurement grouping and Pauli twirling",
          "Quantum Krylov methods",
          "Sample-based quantum diagonalisation",
          "Hartree-Fock VQE on hardware",
          "Fermi-Hubbard spin-charge dynamics",
        ],
      },
      {
        code: "T5B.M1",
        title: "Optimisation",
        lessons: [
          "QUBO and Ising formulations",
          "Encoding a real problem",
          "QAOA: cost and mixer Hamiltonians",
          "Angle landscapes and precomputed optima",
          "Warm starts",
          "Max-Cut end to end",
          "Portfolio optimisation",
          "Scheduling and constrained problems",
          "The adiabatic theorem",
          "Annealing and the D-Wave model",
          "Benchmarking honestly against classical solvers",
        ],
      },
      {
        code: "T5C.M1",
        title: "Quantum Machine Learning",
        lessons: [
          "Classical ML, recalled",
          "Data encoding: basis, angle, amplitude",
          "ZZ feature maps",
          "Quantum kernels and SVMs",
          "Variational classifiers",
          "Quantum neural networks",
          "The parameter-shift rule",
          "Barren plateaus",
          "Expressibility and entangling capability",
          "A quantum node inside PyTorch autograd",
          "Where QML advantage claims stand",
        ],
      },
      {
        code: "T5D.M1",
        title: "Cryptography and Security",
        lessons: [
          "What Shor actually breaks, and when",
          "Grover against symmetric keys and hashes",
          "BB84 in depth",
          "E91 and device-independence",
          "Decoy states and side channels",
          "Bit-commitment impossibility",
          "Post-quantum cryptography: ML-KEM and ML-DSA",
          "Hybrid TLS and migration planning",
          "Building a cryptographic inventory",
        ],
      },
    ],
  },
  {
    code: "T6",
    title: "Hardware and Systems",
    level: "L2",
    modules: [
      {
        code: "T6.M1",
        title: "What a Qubit Is Made Of",
        lessons: [
          "Superconducting transmons and Josephson junctions",
          "Dispersive readout",
          "Trapped ions and Mølmer-Sørensen gates",
          "QCCD and shuttling",
          "Photonic dual-rail and fusion-based schemes",
          "Neutral atoms and Rydberg blockade",
          "Silicon and germanium spin qubits",
          "Topological qubits: the state of the claim",
        ],
      },
      {
        code: "T6.M2",
        title: "Coherence and Control",
        lessons: [
          "T₁, T₂, T₂*",
          "Ramsey and echo experiments",
          "Pulse-level control and DRAG",
          "Crosstalk and spectator errors",
        ],
      },
      {
        code: "T6.M3",
        title: "Calibration",
        lessons: [
          "Rabi and frequency sweeps",
          "Calibration drift",
          "Automated calibration graphs",
        ],
      },
      {
        code: "T6.M4",
        title: "Cryogenics and Wiring",
        lessons: [
          "Dilution-refrigerator stages",
          "Thermal budget",
          "The I/O bottleneck",
        ],
      },
      {
        code: "T6.M5",
        title: "Cloud QPU Systems",
        lessons: [
          "Job queueing and fair-share scheduling",
          "Metering and cost",
          "Multi-tenant isolation",
          "Calibration-aware routing",
          "Handling hardware failure",
        ],
      },
      {
        code: "T6.M6",
        title: "Quantum Networking",
        lessons: [
          "Entanglement distribution",
          "Repeaters and quantum memories",
          "The quantum internet stack",
        ],
      },
      {
        code: "T6.M7",
        title: "Quantum and HPC",
        lessons: [
          "Co-scheduling models",
          "Programming models",
          "Distributed statevector simulation",
        ],
      },
    ],
  },
  {
    code: "T7",
    title: "Career and Research",
    level: "L1",
    modules: [
      {
        code: "T7.M1",
        title: "Reading the Literature",
        lessons: [
          "How to read a quantum paper",
          "arXiv, benchmarks, and claim inflation",
        ],
      },
      {
        code: "T7.M2",
        title: "Coding Interviews",
        lessons: [
          "The 15 recurring coding patterns, each as a timed lab",
        ],
      },
      {
        code: "T7.M3",
        title: "System-Design Interviews",
        lessons: [
          "The 15 recurring architecture prompts, each with a rubric",
        ],
      },
      {
        code: "T7.M4",
        title: "Company Briefings",
        lessons: [
          "20 employer briefings: stack, modality, what they ask, where to read more",
        ],
      },
      {
        code: "T7.M5",
        title: "Portfolio",
        lessons: [
          "Contributing to Qiskit, Cirq, PennyLane",
          "Publishing a reproducible result",
        ],
      },
      {
        code: "T7.M6",
        title: "Capstone",
        lessons: [
          "A defended, peer-reviewed project",
        ],
      },
    ],
  },
];

/** Persona paths through the DAG (syllabus, "Roadmaps"), ranges expanded. */
export interface RoadmapSeed {
  slug: string;
  title: string;
  persona: string;
  durationWeeks: number;
  path: readonly string[];
}

function range(track: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i += 1) out.push(`${track}.M${i}`);
  return out;
}

export const ROADMAPS: readonly RoadmapSeed[] = [
  {
    slug: 'cs-student',
    title: 'CS student',
    persona: 'Computer-science undergraduate with discrete maths and algorithms',
    durationWeeks: 14,
    path: [...range('T0', 2, 6), ...range('T1', 1, 12), ...range('T2', 1, 10), ...range('T3', 1, 3), 'T7.M2'],
  },
  {
    slug: 'physics-student',
    title: 'Physics student',
    persona: 'Physics undergraduate comfortable with linear algebra and Dirac notation',
    durationWeeks: 12,
    path: [...range('T0', 6, 7), ...range('T1', 1, 12), ...range('T4', 1, 8), 'T5A.M1', ...range('T6', 1, 7)],
  },
  {
    slug: 'software-engineer-to-quantum-sde',
    title: 'Software engineer to quantum SDE',
    persona: 'Working software engineer moving into quantum tooling',
    durationWeeks: 16,
    path: [...range('T0', 1, 8), ...range('T1', 1, 12), ...range('T3', 1, 9), ...range('T2', 1, 5), ...range('T7', 2, 4)],
  },
  {
    slug: 'data-scientist-to-qml',
    title: 'Data scientist to QML',
    persona: 'Data scientist with classical ML experience',
    durationWeeks: 9,
    path: [...range('T0', 2, 5), ...range('T1', 1, 9), 'T5C.M1', ...range('T3', 6, 8)],
  },
  {
    slug: 'researcher',
    title: 'Researcher',
    persona: 'Graduate researcher entering quantum information',
    durationWeeks: 20,
    path: ['T0.M8', ...range('T2', 1, 10), ...range('T4', 1, 8), 'T5A.M1', 'T7.M1', 'T7.M6'],
  },
  {
    slug: 'security-engineer-to-pqc',
    title: 'Security engineer to PQC',
    persona: 'Security engineer planning a post-quantum migration',
    durationWeeks: 7,
    path: [...range('T0', 1, 2), ...range('T1', 1, 7), 'T2.M2', 'T2.M5', 'T5D.M1'],
  },
  {
    slug: 'technical-manager',
    title: 'Technical manager',
    persona: 'Engineering manager who needs the shape, not the derivations',
    durationWeeks: 4,
    path: [...range('T1', 1, 5), 'T3.M4', 'T6.M5', 'T5B.M1'],
  },
];

/**
 * The §7 plan matrix as billable rows. `entitlementsFor()` in
 * `src/entitlements` is the runtime authority; these rows exist so the pricing
 * page and Stripe have something to read, and so `billing.subscriptions` has a
 * foreign key to point at.
 */
export interface PlanSeed {
  code: 'free' | 'pro' | 'teams' | 'campus';
  name: string;
  priceCents: number;
  interval: 'month' | 'year' | 'none';
  seatBased: boolean;
  position: number;
  features: Record<string, unknown>;
}

export const PLANS: readonly PlanSeed[] = [
  {
    code: 'free',
    name: 'Free',
    priceCents: 0,
    interval: 'none',
    seatBased: false,
    position: 1,
    features: {
      lessons: 'T0-T1',
      labsPerMonth: 40,
      maxQubits: 16,
      noisySimulation: false,
      simCreditsPerMonth: 500,
      tutorMessagesPerDay: 15,
      contests: 'participate',
      interviewQuestions: 20,
      instructorDashboard: false,
      sso: ['google', 'github'],
      certificates: false,
    },
  },
  {
    code: 'pro',
    name: 'Pro',
    priceCents: 1_900,
    interval: 'month',
    seatBased: false,
    position: 2,
    features: {
      lessons: 'all',
      labsPerMonth: null,
      maxQubits: 28,
      noisySimulation: 12,
      simCreditsPerMonth: 20_000,
      tutorMessagesPerDay: 300,
      contests: 'participate + rated + editorials',
      interviewQuestions: null,
      instructorDashboard: false,
      sso: ['google', 'github', 'microsoft', 'orcid', 'linkedin'],
      certificates: true,
    },
  },
  {
    code: 'teams',
    name: 'Teams',
    priceCents: 3_900,
    interval: 'month',
    seatBased: true,
    position: 3,
    features: {
      lessons: 'all',
      labsPerMonth: null,
      maxQubits: 30,
      noisySimulation: 14,
      simCreditsPerMonth: 50_000,
      simCreditsPerSeat: true,
      tutorMessagesPerDay: 300,
      contests: '+ private contests',
      interviewQuestions: null,
      instructorDashboard: true,
      sso: ['google', 'github', 'microsoft', 'orcid', 'linkedin', 'saml'],
      certificates: true,
    },
  },
  {
    code: 'campus',
    name: 'Campus',
    // Negotiated per contract (§7), so the list price is zero and the real
    // figure lives on the subscription.
    priceCents: 0,
    interval: 'year',
    seatBased: true,
    position: 4,
    features: {
      lessons: 'all',
      labsPerMonth: null,
      maxQubits: 32,
      noisySimulation: 14,
      simCreditsPerMonth: 'negotiated',
      tutorMessagesPerDay: 300,
      contests: '+ private contests',
      interviewQuestions: null,
      instructorDashboard: true,
      sso: ['google', 'github', 'microsoft', 'orcid', 'linkedin', 'saml'],
      scim: true,
      certificates: 'co-branded',
    },
  },
];
