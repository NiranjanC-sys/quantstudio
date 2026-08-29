# The RedQuant Syllabus

Synthesised from the 20 sources in [01-curriculum-benchmark.md](./01-curriculum-benchmark.md).

**Shape.** 8 tracks, 74 modules, 331 lessons. Every lesson is one of six types:

| Type | What it is | Median time |
|---|---|---|
| `concept` | Typeset prose with inline math, worked derivations, and a live simulation confirming each claim | 12 min |
| `interactive` | A 3D or 2D instrument the learner manipulates; no passive reading | 8 min |
| `lab` | Autograded code against hidden tests, in Qiskit / Cirq / PennyLane / OpenQASM | 25 min |
| `drill` | Spaced-repetition prompts generated from the module (source 14's mnemonic medium) | 3 min |
| `checkpoint` | Gated quiz; must pass to unlock the next module | 15 min |
| `project` | Multi-file, rubric-graded, peer-reviewable | 3-6 h |

**Levels.** `L0` curious · `L1` practitioner · `L2` advanced · `L3` research.
**Gating.** Lessons form a prerequisite DAG, not a list. A learner who passes the
T0 placement test skips up to 34 lessons. The DAG is the source of truth for
personalised paths; the AI tutor only ever recommends nodes whose prerequisites
are already satisfied.

---

## T0 — Mathematical and Computational Foundations · L0 · 8 modules / 31 lessons

The track every other syllabus assumes you already have. Skippable by placement test.

| Module | Lessons |
|---|---|
| T0.M1 Probability and Information | Bits and states · Coin-flipping games and probabilistic states · Probabilistic operators and stochastic matrices · Joint distributions, marginals, correlation · Shannon entropy as a resource |
| T0.M2 Complex Numbers | Complex arithmetic, modulus, argument · Euler's formula and the unit circle · Roots of unity |
| T0.M3 Vectors and Vector Spaces | Column vectors, inner products, norms · Orthonormal bases and change of basis · Dirac notation: kets, bras, brackets |
| T0.M4 Matrices and Operators | Matrix arithmetic and adjoints · Unitary, Hermitian, projector · Eigendecomposition and the spectral theorem · Functions of matrices and the matrix exponential |
| T0.M5 Tensor Products | Kronecker product and index conventions · Composite systems · Qubit ordering: little-endian vs big-endian (and why every SDK disagrees) |
| T0.M6 Classical Computation | Boolean gates and universality · Circuit depth, width, fan-out · Reversible computation, Toffoli, uncomputation, Landauer · P, BPP, NP, PSPACE |
| T0.M7 Python for Quantum | NumPy for statevectors and operators · Verifying identities numerically · Plotting distributions with error bars |
| T0.M8 Placement | Diagnostic checkpoint that writes directly to the learner's DAG |

Sources: 12 (structure), 4, 1, 2, 18.

---

## T1 — Quantum Computing Core · L1 · 12 modules / 61 lessons

| Module | Lessons |
|---|---|
| T1.M1 The Qubit | From probabilistic bit to real-valued qubit · Hadamard as a rotation on the unit circle · Superposition and amplitude · The normalisation constraint, geometrically · Why \|0⟩ is not the zero vector · Complex amplitudes · Global vs relative phase · The Bloch sphere |
| T1.M2 Measurement | Computational-basis measurement and the Born rule · Collapse · Measuring in other bases · Single-qubit tomography · Shots, sampling noise, and error bars |
| T1.M3 Single-Qubit Gates | X, Y, Z · H, S, T and the phase family · Rx, Ry, Rz and general U · Unitarity as length preservation; the dagger · Euler decomposition · Gate identities and simplification |
| T1.M4 Multi-Qubit Systems | Tensor products of states · The 2^n amplitude vector · Product vs entangled states · CNOT, CZ, SWAP · Controlled-U and multi-controlled constructions · Toffoli and Fredkin |
| T1.M5 Entanglement | The four Bell states · Partial measurement and "spooky action" · Reduced states and the partial trace, informally · No-cloning · Schmidt rank and entanglement entropy |
| T1.M6 Nonlocality and Games | Bell's inequality · The CHSH game · GHZ game · Mermin-Peres magic square · Elitzur-Vaidman bomb tester |
| T1.M7 Protocols | Superdense coding · Quantum teleportation · Entanglement swapping · Quantum money · BB84 |
| T1.M8 The Circuit Model | Circuits, depth, width, barriers · Deferred measurement · Mid-circuit measurement and reset · Classical control and conditional gates · Universal gate sets · Solovay-Kitaev, stated |
| T1.M9 Phase and Interference | Phase kickback · Rotate, compute, rotate · Reading the Q-sphere · Interference as the engine of every speedup |
| T1.M10 First Algorithms | Deutsch's algorithm · Deutsch-Jozsa · Bernstein-Vazirani · Simon's algorithm |
| T1.M11 Meeting Noise Early | Where noise comes from · Relaxation and dephasing, observed · Depolarising and readout error, hands-on · Fidelity of a noisy Bell pair · Why depth costs you |
| T1.M12 Capstone | Project: build, run and benchmark a Bell-state experiment end to end |

Sources: 2 (ordering), 9, 10, 11, 12, 14, 4, 1.

---

## T2 — Quantum Algorithms and Complexity · L2 · 10 modules / 48 lessons

| Module | Lessons |
|---|---|
| T2.M1 The Query Model | Oracles and how to build one · Bit-flip vs phase oracles · Marking oracles · Query complexity, defined |
| T2.M2 Amplitude Amplification and Grover | Unstructured search · Oracle plus diffuser · Choosing the iteration count · Over-rotation, seen on the Bloch sphere · Amplitude amplification in general · Grover for SAT · Grover for graph colouring · Grover for bounded knapsack · The BBBV optimality bound |
| T2.M3 The Fourier Transform | DFT, recalled · The QFT circuit and its cost · QFT over Z_N · Approximate QFT · Fourier sampling · Revealing XOR patterns |
| T2.M4 Phase Estimation | Kitaev's phase estimation · Iterative QPE · Precision, ancillas, and success probability |
| T2.M5 Order Finding and Shor | Factoring reduces to order finding · Modular exponentiation circuits · Continued-fraction post-processing · Putting Shor together · Discrete logarithm |
| T2.M6 The Hidden Subgroup Problem | The abelian HSP framework · What the abelian case buys you · Non-abelian HSP and where it breaks |
| T2.M7 Quantum Walks | Coined walks · Continuous-time walks · Element distinctness · Welded tree · Graph collision |
| T2.M8 Hamiltonian Simulation | Trotter-Suzuki and its error bound · Higher-order formulas · LCU and qubitisation, conceptually · Simulating the XY and Heisenberg chains · Fermi-Hubbard dynamics |
| T2.M9 Lower Bounds and Complexity | The polynomial method · The adversary method · BQP and its neighbours · Gottesman-Knill and classical simulability · Tensor-network simulation · Random circuit sampling and what "utility" claims mean |
| T2.M10 Zoo Lab | Project: implement six algorithms drawn from the Quantum Algorithm Zoo taxonomy and classify their speedups |

Sources: 13 (taxonomy), 2, 8, 3, 7, 1, 9.

---

## T3 — Quantum Software Engineering · L1-L2 · 9 modules / 41 lessons

The track almost nobody teaches. Built primarily from source 5, extended with 16 and 19.

| Module | Lessons |
|---|---|
| T3.M1 The SDK Landscape | The same circuit in five SDKs · Choosing an SDK per task · Interop through OpenQASM 3 and QIR · Provider abstraction: the QRN addressing pattern |
| T3.M2 OpenQASM 3 | Syntax and gate declarations · Subroutines and classical control · Round-tripping IR to QASM and back |
| T3.M3 Transpilation | Layout selection · Routing and SWAP insertion · Basis translation · Optimisation levels, measured · Coupling maps and topology-aware mapping · ZX-calculus rewriting for gate reduction |
| T3.M4 Resource Estimation | Counting gates, depth, and two-qubit gates · T-count and why it dominates · Shor at scale: logical to physical |
| T3.M5 Hybrid Runtimes | Parameterised circuits and batching · Sessions and latency budgets · Circuit caching · The HPC to QPU loop |
| T3.M6 Testing Quantum Code | Asserting on unitaries · Statevector assertions · Distribution tests and shot budgeting · Property-based testing of circuit identities · What a wrong amplitude looks like |
| T3.M7 Noise Models and Benchmarking | Kraus operators and Pauli channels · Building a device noise model · Randomised benchmarking · XEB and quantum volume · Readout calibration matrices |
| T3.M8 Error Mitigation | Measurement-error mitigation · Zero-noise extrapolation · Probabilistic error cancellation · Dynamical decoupling · When mitigation lies to you |
| T3.M9 Capstone | Project: write a transpiler pass and prove it preserves semantics |

---

## T4 — Noise, Error Correction and Fault Tolerance · L2-L3 · 8 modules / 42 lessons

| Module | Lessons |
|---|---|
| T4.M1 Open Systems | Density matrices · Mixed states and convex combinations · The Bloch ball · Partial trace and reduced states · Quantum channels · Kraus and Stinespring representations · Choi-Jamiołkowski · Purification · Fidelity, trace distance, diamond norm |
| T4.M2 General Measurement | POVMs · Naimark's theorem · State discrimination · Tomography and its cost |
| T4.M3 From Classical to Quantum Codes | The repetition code · Bit-flip and phase-flip codes · The Shor 9-qubit code · Discretisation of errors |
| T4.M4 The Stabilizer Formalism | The Pauli group · Stabilizer groups and syndromes · Syndrome extraction circuits · The Clifford group · Gottesman-Knill · Steane's 7-qubit code · The CSS construction |
| T4.M5 Topological Codes | The toric code · The surface code and planar layouts · Code distance · MWPM decoding · Union-find decoding · Thresholds |
| T4.M6 Fault Tolerance | Controlling error propagation · Transversal gates and the Eastin-Knill obstruction · Magic-state distillation · T-gate cost accounting · The threshold theorem |
| T4.M7 Beyond the Surface Code | Colour codes · qLDPC codes · Bosonic codes: cat and GKP · Measurement-based computation and cluster states |
| T4.M8 Decoder Lab | Project: decode a surface-code syndrome stream and measure your logical error rate |

Sources: 3, 1, 9, 7, 10, 11.

---

## T5 — Applications · L2 · 4 sub-tracks / 14 modules / 63 lessons

### T5A Chemistry and Materials
Second quantisation · Jordan-Wigner and Bravyi-Kitaev mappings · Building a molecular Hamiltonian · Ansätze: UCCSD and hardware-efficient · Classical optimisers for VQE · Ground-state energy of H₂ · LiH and potential-energy surfaces · Measurement grouping and Pauli twirling · Quantum Krylov methods · Sample-based quantum diagonalisation · Hartree-Fock VQE on hardware · Fermi-Hubbard spin-charge dynamics

### T5B Optimisation
QUBO and Ising formulations · Encoding a real problem · QAOA: cost and mixer Hamiltonians · Angle landscapes and precomputed optima · Warm starts · Max-Cut end to end · Portfolio optimisation · Scheduling and constrained problems · The adiabatic theorem · Annealing and the D-Wave model · Benchmarking honestly against classical solvers

### T5C Quantum Machine Learning
Classical ML, recalled · Data encoding: basis, angle, amplitude · ZZ feature maps · Quantum kernels and SVMs · Variational classifiers · Quantum neural networks · The parameter-shift rule · Barren plateaus · Expressibility and entangling capability · A quantum node inside PyTorch autograd · Where QML advantage claims stand

### T5D Cryptography and Security
What Shor actually breaks, and when · Grover against symmetric keys and hashes · BB84 in depth · E91 and device-independence · Decoy states and side channels · Bit-commitment impossibility · Post-quantum cryptography: ML-KEM and ML-DSA · Hybrid TLS and migration planning · Building a cryptographic inventory

Sources: 9, 15, 5, 10, 7, 17.

---

## T6 — Hardware and Systems · L2 · 7 modules / 30 lessons

| Module | Lessons |
|---|---|
| T6.M1 What a Qubit Is Made Of | Superconducting transmons and Josephson junctions · Dispersive readout · Trapped ions and Mølmer-Sørensen gates · QCCD and shuttling · Photonic dual-rail and fusion-based schemes · Neutral atoms and Rydberg blockade · Silicon and germanium spin qubits · Topological qubits: the state of the claim |
| T6.M2 Coherence and Control | T₁, T₂, T₂* · Ramsey and echo experiments · Pulse-level control and DRAG · Crosstalk and spectator errors |
| T6.M3 Calibration | Rabi and frequency sweeps · Calibration drift · Automated calibration graphs |
| T6.M4 Cryogenics and Wiring | Dilution-refrigerator stages · Thermal budget · The I/O bottleneck |
| T6.M5 Cloud QPU Systems | Job queueing and fair-share scheduling · Metering and cost · Multi-tenant isolation · Calibration-aware routing · Handling hardware failure |
| T6.M6 Quantum Networking | Entanglement distribution · Repeaters and quantum memories · The quantum internet stack |
| T6.M7 Quantum and HPC | Co-scheduling models · Programming models · Distributed statevector simulation |

Sources: 17, 4, 9, 19, 5.

---

## T7 — Career and Research · L1-L3 · 6 modules / 15 lessons

| Module | Lessons |
|---|---|
| T7.M1 Reading the Literature | How to read a quantum paper · arXiv, benchmarks, and claim inflation |
| T7.M2 Coding Interviews | The 15 recurring coding patterns, each as a timed lab |
| T7.M3 System-Design Interviews | The 15 recurring architecture prompts, each with a rubric |
| T7.M4 Company Briefings | 20 employer briefings: stack, modality, what they ask, where to read more |
| T7.M5 Portfolio | Contributing to Qiskit, Cirq, PennyLane · Publishing a reproducible result |
| T7.M6 Capstone | A defended, peer-reviewed project |

Source: 19, plus per-company primary documentation.

---

## Roadmaps (persona paths through the DAG)

| Roadmap | Path | Duration |
|---|---|---|
| CS student | T0.M2-M6 → T1 → T2 → T3.M1-M3 → T7.M2 | 14 weeks |
| Physics student | T0.M6-M7 → T1 (fast) → T4 → T5A → T6 | 12 weeks |
| Software engineer to quantum SDE | T0 → T1 → T3 (full) → T2.M1-M5 → T7.M2-M4 | 16 weeks |
| Data scientist to QML | T0.M2-M5 → T1.M1-M9 → T5C → T3.M6-M8 | 9 weeks |
| Researcher | placement → T2 → T4 → T5 (one sub-track) → T7.M1, M6 | 20 weeks |
| Security engineer to PQC | T0.M1-M2 → T1.M1-M7 → T2.M2, M5 → T5D | 7 weeks |
| Technical manager | T1.M1-M5 (concept only) → T3.M4 → T6.M5 → T5B | 4 weeks |

## Assessment model

Adapted from source 5's project ladder and source 11's kata progression.

1. **Drills** — spaced repetition, no grade, feeds the mastery estimate.
2. **Labs** — autograded. Public tests visible, hidden tests decide. Grading
   asserts on statevector equality up to global phase, unitary equivalence,
   measurement distribution within a tolerance, and resource bounds (depth,
   two-qubit gate count) so that a correct-but-wasteful answer scores lower.
3. **Checkpoints** — gate module progression at 80%.
4. **Projects** — rubric-graded, four per track.
5. **Contests** — weekly, rated, four problems, does not affect course grade.

## Mastery model

Per concept node: `mastery ∈ [0,1]`, updated by a Bayesian knowledge-tracing
step on every graded interaction, decayed by a per-node forgetting curve whose
half-life extends with each successful spaced review. The tutor's recommendation
is `argmin(mastery)` over nodes whose prerequisites all exceed 0.7.
