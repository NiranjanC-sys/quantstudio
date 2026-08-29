# Remaining lesson authoring

**163 of 331 lessons authored. 168 remain.**

Lesson authoring is paused by decision, not blocked. Everything the platform
needs to *run* is built and tested; what is left here is prose, and it is
listed exhaustively below so it can be picked up by a subject-matter author,
an agent, or a contractor without rediscovering the scope.

## Where each track stands

| Track | Title | Authored | Remaining |
|---|---|---|---|
| T0 | Mathematical and Computational Foundations | 26 / 31 | 5 |
| T1 | Quantum Computing Core | 61 / 61 | 0 |
| T2 | Quantum Algorithms and Complexity | 34 / 48 | 14 |
| T3 | Quantum Software Engineering | 41 / 41 | 0 |
| T4 | Noise, Error Correction and Fault Tolerance | 1 / 42 | 41 |
| T5 | Applications | 0 / 63 | 63 |
| T6 | Hardware and Systems | 0 / 30 | 30 |
| T7 | Career and Research | 0 / 15 | 15 |

## What kind of work is left

| Node type | Count | What writing one involves |
|---|---|---|
| concept | 123 |
| lab | 20 |
| checkpoint | 14 |
| project | 7 |
| interactive | 3 |
| drill | 1 |

A `concept` node is 900 to 1400 words of prose with derivations and at least
one live circuit. A `lab` needs a runnable Qiskit task, a reference solution,
and hidden tests. A `checkpoint` is exam-shaped with a pass threshold. A
`project` needs deliverables and a rubric. An `interactive` needs a component,
not prose.

## How to author one

The catalogue is the specification. `packages/content/src/data/<track>.ts`
declares every node's id, title, type, minutes, objectives, prerequisites,
sources and `path`. The file goes at that `path` and its frontmatter mirrors
that entry. Nothing needs inventing.

Conventions that matter:

- **Qubit 0 is the most significant bit.** `|q0 q1>` reads left to right,
  matching Nielsen and Chuang and Cirq. Qiskit is little-endian and converts at
  `packages/qir/src/codegen/qiskit.ts`.
- Every embedded circuit is **simulated live at read time**, so a number in the
  prose that disagrees with the circuit is visible to the reader immediately.
  Verify with `apps/quantum-kernel/.venv/bin/python` or by simulating through
  `packages/qir/dist/index.js`.
- Components available: `<Margin>`, `<Callout>`, `<Check>`, `<Solution>`,
  `<Circuit>`, `<Simulate>`.
- KaTeX macros defined: `\ket \bra \braket \ketbra \expect \tr \dg
  \half \isqrt \C \R \Z \N`.
- No em-dashes or en-dashes anywhere in copy.

Run `node scripts/validate-content.mjs content/tracks` before finishing. It
compiles every file through the app's real MDX pipeline, so it catches what
would break a build rather than guessing.

## Shape to follow

Reference files, already written and verified:

- Concept: `content/tracks/t1/m10/l2-deutsch-jozsa.mdx`
- Lab: `content/tracks/t1/m10/l5-lab-implement-deutsch-jozsa-and-bernstein-vazirani.mdx`
- Noise and hardware voice: `content/tracks/t1/m11/l1-where-noise-comes-from.mdx`

The IBM Quantum Learning catalogue is the closest external model for lab and
exam shape: every course there carries a "Qiskit implementation" lesson and
closes with an "Exam". Track-to-course mapping worth following:

| Track | IBM course to mirror |
|---|---|
| T2 | Fundamentals of quantum algorithms |
| T3 | Quantum computing in practice; Utility-scale quantum computing |
| T4 | Foundations of quantum error correction; General formulation of quantum information |
| T5 | Quantum chemistry with VQE; Variational algorithm design; Quantum diagonalization algorithms; Quantum machine learning |
| T6 | Integrating quantum and high-performance computing |
| T7 | Designing and leading quantum projects; Quantum business foundations |

## The full inventory

Every remaining node, by track and module.

## T0 Mathematical and Computational Foundations  (26/31 authored, 5 remaining)

### t0.m1 Probability and Information

| id | type | min | title | path |
|---|---|---|---|---|
| `t0.m1.l6` | checkpoint | 15 | Checkpoint: Probability and Information | `tracks/t0/m1/l6-checkpoint-probability-and-information.mdx` |

### t0.m4 Matrices and Operators

| id | type | min | title | path |
|---|---|---|---|---|
| `t0.m4.l5` | lab | 30 | Lab: Diagonalise and Exponentiate | `tracks/t0/m4/l5-lab-diagonalise-and-exponentiate.mdx` |

### t0.m5 Tensor Products

| id | type | min | title | path |
|---|---|---|---|---|
| `t0.m5.l4` | interactive | 8 | Instrument: The Ordering Converter | `tracks/t0/m5/l4-instrument-the-ordering-converter.mdx` |

### t0.m6 Classical Computation

| id | type | min | title | path |
|---|---|---|---|---|
| `t0.m6.l5` | lab | 35 | Lab: Build a Reversible Adder | `tracks/t0/m6/l5-lab-build-a-reversible-adder.mdx` |

### t0.m7 Python for Quantum

| id | type | min | title | path |
|---|---|---|---|---|
| `t0.m7.l4` | lab | 30 | Lab: A Verification Harness | `tracks/t0/m7/l4-lab-a-verification-harness.mdx` |

## T2 Quantum Algorithms and Complexity  (34/48 authored, 14 remaining)

### t2.m7 Quantum Walks

| id | type | min | title | path |
|---|---|---|---|---|
| `t2.m7.l4` | concept | 12 | Welded Tree | `undefined` |
| `t2.m7.l5` | concept | 12 | Graph Collision | `undefined` |

### t2.m8 Hamiltonian Simulation

| id | type | min | title | path |
|---|---|---|---|---|
| `t2.m8.l1` | concept | 15 | Trotter-Suzuki and Its Error Bound | `undefined` |
| `t2.m8.l2` | concept | 12 | Higher-Order Formulas | `undefined` |
| `t2.m8.l3` | concept | 15 | LCU and Qubitisation, Conceptually | `undefined` |
| `t2.m8.l4` | lab | 40 | Simulating the XY and Heisenberg Chains | `undefined` |
| `t2.m8.l5` | concept | 14 | Fermi-Hubbard Dynamics | `undefined` |

### t2.m9 Lower Bounds and Complexity

| id | type | min | title | path |
|---|---|---|---|---|
| `t2.m9.l1` | concept | 15 | The Polynomial Method | `undefined` |
| `t2.m9.l2` | concept | 15 | The Adversary Method | `undefined` |
| `t2.m9.l3` | concept | 14 | BQP and Its Neighbours | `undefined` |
| `t2.m9.l4` | concept | 13 | Gottesman-Knill and Classical Simulability | `undefined` |
| `t2.m9.l5` | concept | 14 | Tensor-Network Simulation | `undefined` |
| `t2.m9.l6` | concept | 15 | Random Circuit Sampling and What Utility Claims Mean | `undefined` |

### t2.m10 Zoo Lab

| id | type | min | title | path |
|---|---|---|---|---|
| `t2.m10.l1` | project | 300 | Project: Implement Six Algorithms from the Quantum Algorithm Zoo | `undefined` |

## T4 Noise, Error Correction and Fault Tolerance  (1/42 authored, 41 remaining)

### t4.m1 Open Systems

| id | type | min | title | path |
|---|---|---|---|---|
| `t4.m1.l2` | concept | 13 | Mixed States and Convex Combinations | `undefined` |
| `t4.m1.l3` | interactive | 8 | The Bloch Ball | `undefined` |
| `t4.m1.l4` | concept | 14 | Partial Trace and Reduced States | `undefined` |
| `t4.m1.l5` | concept | 14 | Quantum Channels | `undefined` |
| `t4.m1.l6` | concept | 15 | Kraus and Stinespring Representations | `undefined` |
| `t4.m1.l7` | concept | 14 | Choi-Jamiolkowski | `undefined` |
| `t4.m1.l8` | concept | 13 | Purification | `undefined` |
| `t4.m1.l9` | concept | 15 | Fidelity, Trace Distance, Diamond Norm | `undefined` |
| `t4.m1.l10` | checkpoint | 15 | Checkpoint: Open Systems | `undefined` |

### t4.m2 General Measurement

| id | type | min | title | path |
|---|---|---|---|---|
| `t4.m2.l1` | concept | 14 | POVMs | `undefined` |
| `t4.m2.l2` | concept | 13 | Naimark's Theorem | `undefined` |
| `t4.m2.l3` | concept | 14 | State Discrimination | `undefined` |
| `t4.m2.l4` | concept | 15 | Tomography and Its Cost | `undefined` |

### t4.m3 From Classical to Quantum Codes

| id | type | min | title | path |
|---|---|---|---|---|
| `t4.m3.l1` | concept | 12 | The Repetition Code | `undefined` |
| `t4.m3.l2` | concept | 14 | Bit-Flip and Phase-Flip Codes | `undefined` |
| `t4.m3.l3` | concept | 15 | The Shor 9-Qubit Code | `undefined` |
| `t4.m3.l4` | concept | 14 | Discretisation of Errors | `undefined` |

### t4.m4 The Stabilizer Formalism

| id | type | min | title | path |
|---|---|---|---|---|
| `t4.m4.l1` | concept | 12 | The Pauli Group | `undefined` |
| `t4.m4.l2` | concept | 15 | Stabilizer Groups and Syndromes | `undefined` |
| `t4.m4.l3` | concept | 15 | Syndrome Extraction Circuits | `undefined` |
| `t4.m4.l4` | concept | 14 | The Clifford Group | `undefined` |
| `t4.m4.l5` | concept | 14 | Gottesman-Knill | `undefined` |
| `t4.m4.l6` | concept | 15 | Steane's 7-Qubit Code | `undefined` |
| `t4.m4.l7` | concept | 15 | The CSS Construction | `undefined` |

### t4.m5 Topological Codes

| id | type | min | title | path |
|---|---|---|---|---|
| `t4.m5.l1` | concept | 15 | The Toric Code | `undefined` |
| `t4.m5.l2` | concept | 15 | The Surface Code and Planar Layouts | `undefined` |
| `t4.m5.l3` | concept | 13 | Code Distance | `undefined` |
| `t4.m5.l4` | concept | 15 | MWPM Decoding | `undefined` |
| `t4.m5.l5` | concept | 14 | Union-Find Decoding | `undefined` |
| `t4.m5.l6` | concept | 15 | Thresholds | `undefined` |
| `t4.m5.l7` | lab | 45 | Lab: Decode a Distance-3 Surface Code | `undefined` |

### t4.m6 Fault Tolerance

| id | type | min | title | path |
|---|---|---|---|---|
| `t4.m6.l1` | concept | 14 | Controlling Error Propagation | `undefined` |
| `t4.m6.l2` | concept | 15 | Transversal Gates and the Eastin-Knill Obstruction | `undefined` |
| `t4.m6.l3` | concept | 15 | Magic-State Distillation | `undefined` |
| `t4.m6.l4` | concept | 14 | T-Gate Cost Accounting | `undefined` |
| `t4.m6.l5` | concept | 15 | The Threshold Theorem | `undefined` |

### t4.m7 Beyond the Surface Code

| id | type | min | title | path |
|---|---|---|---|---|
| `t4.m7.l1` | concept | 14 | Colour Codes | `undefined` |
| `t4.m7.l2` | concept | 15 | qLDPC Codes | `undefined` |
| `t4.m7.l3` | concept | 15 | Bosonic Codes: Cat and GKP | `undefined` |
| `t4.m7.l4` | concept | 15 | Measurement-Based Computation and Cluster States | `undefined` |

### t4.m8 Decoder Lab

| id | type | min | title | path |
|---|---|---|---|---|
| `t4.m8.l1` | project | 300 | Project: Decode a Surface-Code Syndrome Stream | `undefined` |

## T5 Applications  (0/63 authored, 63 remaining)

### t5.m1 Fermionic Encodings

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m1.l1` | concept | 15 | Second Quantisation | `undefined` |
| `t5.m1.l2` | concept | 15 | Jordan-Wigner and Bravyi-Kitaev Mappings | `undefined` |
| `t5.m1.l3` | concept | 15 | Building a Molecular Hamiltonian | `undefined` |
| `t5.m1.l4` | lab | 35 | Lab: Encode the H2 Hamiltonian | `undefined` |

### t5.m2 Variational Ground States

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m2.l1` | concept | 15 | Ansatze: UCCSD and Hardware-Efficient | `undefined` |
| `t5.m2.l2` | concept | 14 | Classical Optimisers for VQE | `undefined` |
| `t5.m2.l3` | lab | 40 | Ground-State Energy of H2 | `undefined` |
| `t5.m2.l4` | concept | 15 | Measurement Grouping and Pauli Twirling | `undefined` |
| `t5.m2.l5` | checkpoint | 15 | Checkpoint: VQE | `undefined` |

### t5.m3 Beyond VQE

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m3.l1` | concept | 15 | Quantum Krylov Methods | `undefined` |
| `t5.m3.l2` | concept | 15 | Sample-Based Quantum Diagonalisation | `undefined` |
| `t5.m3.l3` | concept | 15 | LiH and Potential-Energy Surfaces | `undefined` |
| `t5.m3.l4` | checkpoint | 15 | Checkpoint: Diagonalisation Methods | `undefined` |

### t5.m4 Chemistry on Hardware

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m4.l1` | concept | 15 | Hartree-Fock VQE on Hardware | `undefined` |
| `t5.m4.l2` | concept | 15 | Fermi-Hubbard Spin-Charge Dynamics | `undefined` |
| `t5.m4.l3` | lab | 40 | Lab: Noise-Aware Energy Estimation | `undefined` |
| `t5.m4.l4` | project | 300 | Project: A Potential-Energy Surface End to End | `undefined` |

### t5.m5 Problem Encodings

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m5.l1` | concept | 14 | QUBO and Ising Formulations | `undefined` |
| `t5.m5.l2` | concept | 15 | Encoding a Real Problem | `undefined` |
| `t5.m5.l3` | lab | 35 | Lab: Max-Cut as a QUBO | `undefined` |
| `t5.m5.l4` | checkpoint | 15 | Checkpoint: Encodings | `undefined` |

### t5.m6 QAOA

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m6.l1` | concept | 15 | QAOA: Cost and Mixer Hamiltonians | `undefined` |
| `t5.m6.l2` | interactive | 8 | Angle Landscapes and Precomputed Optima | `undefined` |
| `t5.m6.l3` | concept | 14 | Warm Starts | `undefined` |
| `t5.m6.l4` | lab | 40 | Max-Cut End to End | `undefined` |
| `t5.m6.l5` | checkpoint | 15 | Checkpoint: QAOA | `undefined` |

### t5.m7 Applied Optimisation

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m7.l1` | concept | 15 | Portfolio Optimisation | `undefined` |
| `t5.m7.l2` | concept | 15 | Scheduling and Constrained Problems | `undefined` |
| `t5.m7.l3` | lab | 40 | Lab: Constrained Scheduling with Penalty Terms | `undefined` |
| `t5.m7.l4` | checkpoint | 15 | Checkpoint: Applied Optimisation | `undefined` |

### t5.m8 Annealing and Honest Benchmarks

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m8.l1` | concept | 15 | The Adiabatic Theorem | `undefined` |
| `t5.m8.l2` | concept | 14 | Annealing and the D-Wave Model | `undefined` |
| `t5.m8.l3` | concept | 15 | Benchmarking Honestly against Classical Solvers | `undefined` |
| `t5.m8.l4` | project | 300 | Project: A Head-to-Head Benchmark | `undefined` |

### t5.m9 Encoding and Kernels

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m9.l1` | concept | 14 | Classical ML, Recalled | `undefined` |
| `t5.m9.l2` | concept | 15 | Data Encoding: Basis, Angle, Amplitude | `undefined` |
| `t5.m9.l3` | concept | 14 | ZZ Feature Maps | `undefined` |
| `t5.m9.l4` | lab | 40 | Quantum Kernels and SVMs | `undefined` |
| `t5.m9.l5` | checkpoint | 15 | Checkpoint: Encodings and Kernels | `undefined` |

### t5.m10 Variational Models

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m10.l1` | concept | 15 | Variational Classifiers | `undefined` |
| `t5.m10.l2` | concept | 14 | Quantum Neural Networks | `undefined` |
| `t5.m10.l3` | concept | 15 | The Parameter-Shift Rule | `undefined` |
| `t5.m10.l4` | lab | 35 | Lab: Parameter-Shift Gradients by Hand | `undefined` |
| `t5.m10.l5` | checkpoint | 15 | Checkpoint: Variational Models | `undefined` |

### t5.m11 Limits and Integration

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m11.l1` | concept | 15 | Barren Plateaus | `undefined` |
| `t5.m11.l2` | concept | 14 | Expressibility and Entangling Capability | `undefined` |
| `t5.m11.l3` | lab | 40 | A Quantum Node inside PyTorch Autograd | `undefined` |
| `t5.m11.l4` | concept | 15 | Where QML Advantage Claims Stand | `undefined` |
| `t5.m11.l5` | project | 240 | Project: Benchmark a Quantum Kernel | `undefined` |

### t5.m12 What Quantum Breaks

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m12.l1` | concept | 15 | What Shor Actually Breaks, and When | `undefined` |
| `t5.m12.l2` | concept | 14 | Grover against Symmetric Keys and Hashes | `undefined` |
| `t5.m12.l3` | lab | 40 | Lab: Resource-Count an Attack on RSA-2048 | `undefined` |
| `t5.m12.l4` | checkpoint | 15 | Checkpoint: Cryptanalysis | `undefined` |

### t5.m13 Quantum Key Distribution

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m13.l1` | concept | 15 | BB84 in Depth | `undefined` |
| `t5.m13.l2` | concept | 15 | E91 and Device-Independence | `undefined` |
| `t5.m13.l3` | concept | 15 | Decoy States and Side Channels | `undefined` |
| `t5.m13.l4` | concept | 15 | Bit-Commitment Impossibility | `undefined` |
| `t5.m13.l5` | checkpoint | 15 | Checkpoint: QKD | `undefined` |

### t5.m14 Post-Quantum Migration

| id | type | min | title | path |
|---|---|---|---|---|
| `t5.m14.l1` | concept | 15 | Post-Quantum Cryptography: ML-KEM and ML-DSA | `undefined` |
| `t5.m14.l2` | concept | 15 | Hybrid TLS and Migration Planning | `undefined` |
| `t5.m14.l3` | concept | 14 | Building a Cryptographic Inventory | `undefined` |
| `t5.m14.l4` | lab | 35 | Lab: A Hybrid Handshake | `undefined` |
| `t5.m14.l5` | project | 240 | Project: A Migration Plan | `undefined` |

## T6 Hardware and Systems  (0/30 authored, 30 remaining)

### t6.m1 What a Qubit Is Made Of

| id | type | min | title | path |
|---|---|---|---|---|
| `t6.m1.l1` | concept | 14 | Superconducting Transmons and Josephson Junctions | `undefined` |
| `t6.m1.l2` | concept | 13 | Dispersive Readout | `undefined` |
| `t6.m1.l3` | concept | 14 | Trapped Ions and Molmer-Sorensen Gates | `undefined` |
| `t6.m1.l4` | concept | 12 | QCCD and Shuttling | `undefined` |
| `t6.m1.l5` | concept | 14 | Photonic Dual-Rail and Fusion-Based Schemes | `undefined` |
| `t6.m1.l6` | concept | 13 | Neutral Atoms and Rydberg Blockade | `undefined` |
| `t6.m1.l7` | concept | 13 | Silicon and Germanium Spin Qubits | `undefined` |
| `t6.m1.l8` | concept | 13 | Topological Qubits: The State of the Claim | `undefined` |
| `t6.m1.l9` | checkpoint | 15 | Checkpoint: Modalities | `undefined` |

### t6.m2 Coherence and Control

| id | type | min | title | path |
|---|---|---|---|---|
| `t6.m2.l1` | concept | 13 | T1, T2, T2 star | `undefined` |
| `t6.m2.l2` | concept | 13 | Ramsey and Echo Experiments | `undefined` |
| `t6.m2.l3` | concept | 14 | Pulse-Level Control and DRAG | `undefined` |
| `t6.m2.l4` | concept | 13 | Crosstalk and Spectator Errors | `undefined` |

### t6.m3 Calibration

| id | type | min | title | path |
|---|---|---|---|---|
| `t6.m3.l1` | concept | 13 | Rabi and Frequency Sweeps | `undefined` |
| `t6.m3.l2` | concept | 12 | Calibration Drift | `undefined` |
| `t6.m3.l3` | concept | 13 | Automated Calibration Graphs | `undefined` |

### t6.m4 Cryogenics and Wiring

| id | type | min | title | path |
|---|---|---|---|---|
| `t6.m4.l1` | concept | 13 | Dilution-Refrigerator Stages | `undefined` |
| `t6.m4.l2` | concept | 13 | Thermal Budget | `undefined` |
| `t6.m4.l3` | concept | 13 | The I/O Bottleneck | `undefined` |

### t6.m5 Cloud QPU Systems

| id | type | min | title | path |
|---|---|---|---|---|
| `t6.m5.l1` | concept | 13 | Job Queueing and Fair-Share Scheduling | `undefined` |
| `t6.m5.l2` | concept | 12 | Metering and Cost | `undefined` |
| `t6.m5.l3` | concept | 13 | Multi-Tenant Isolation | `undefined` |
| `t6.m5.l4` | concept | 13 | Calibration-Aware Routing | `undefined` |
| `t6.m5.l5` | concept | 13 | Handling Hardware Failure | `undefined` |

### t6.m6 Quantum Networking

| id | type | min | title | path |
|---|---|---|---|---|
| `t6.m6.l1` | concept | 13 | Entanglement Distribution | `undefined` |
| `t6.m6.l2` | concept | 13 | Repeaters and Quantum Memories | `undefined` |
| `t6.m6.l3` | concept | 13 | The Quantum Internet Stack | `undefined` |

### t6.m7 Quantum and HPC

| id | type | min | title | path |
|---|---|---|---|---|
| `t6.m7.l1` | concept | 13 | Co-Scheduling Models | `undefined` |
| `t6.m7.l2` | concept | 13 | Programming Models | `undefined` |
| `t6.m7.l3` | concept | 14 | Distributed Statevector Simulation | `undefined` |

## T7 Career and Research  (0/15 authored, 15 remaining)

### t7.m1 Reading the Literature

| id | type | min | title | path |
|---|---|---|---|---|
| `t7.m1.l1` | concept | 14 | How to Read a Quantum Paper | `undefined` |
| `t7.m1.l2` | concept | 13 | arXiv, Benchmarks, and Claim Inflation | `undefined` |
| `t7.m1.l3` | checkpoint | 15 | Checkpoint: Reading Critically | `undefined` |

### t7.m2 Coding Interviews

| id | type | min | title | path |
|---|---|---|---|---|
| `t7.m2.l1` | concept | 15 | The Fifteen Recurring Coding Patterns | `undefined` |
| `t7.m2.l2` | lab | 30 | Lab: Circuit-Construction Patterns, Timed | `undefined` |
| `t7.m2.l3` | lab | 30 | Lab: Oracle and Algorithm Patterns, Timed | `undefined` |
| `t7.m2.l4` | lab | 35 | Lab: Resource and Simulation Patterns, Timed | `undefined` |

### t7.m3 System-Design Interviews

| id | type | min | title | path |
|---|---|---|---|---|
| `t7.m3.l1` | concept | 15 | The Fifteen Recurring Architecture Prompts | `undefined` |
| `t7.m3.l2` | lab | 40 | Lab: Design a Cloud QPU Service | `undefined` |
| `t7.m3.l3` | checkpoint | 15 | Checkpoint: Design Rubric Self-Assessment | `undefined` |

### t7.m4 Company Briefings

| id | type | min | title | path |
|---|---|---|---|---|
| `t7.m4.l1` | concept | 15 | Twenty Employer Briefings | `undefined` |
| `t7.m4.l2` | drill | 3 | Drill: Company Facts | `undefined` |

### t7.m5 Portfolio

| id | type | min | title | path |
|---|---|---|---|---|
| `t7.m5.l1` | concept | 14 | Contributing to Qiskit, Cirq, PennyLane | `undefined` |
| `t7.m5.l2` | concept | 14 | Publishing a Reproducible Result | `undefined` |

### t7.m6 Capstone

| id | type | min | title | path |
|---|---|---|---|---|
| `t7.m6.l1` | project | 360 | Project: A Defended, Peer-Reviewed Project | `undefined` |
