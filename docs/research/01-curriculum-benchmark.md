# Curriculum Benchmark: 20 Primary Sources

Every topic in the RedQuant syllabus traces to at least two of the sources below.
Column "Weight" is how heavily we lean on it: **A** = structural (drives our
module ordering), **B** = topical (drives content depth), **C** = pedagogy or
tooling reference.

| # | Source | Institution / Owner | What we take from it | Weight |
|---|---|---|---|---|
| 1 | [Ph219/CS219 Quantum Computation](http://theory.caltech.edu/~preskill/ph219/ph219_2021-22.html) — Preskill lecture notes ch. 1-10 | Caltech | Graduate spine: states/ensembles, measurement & evolution, entanglement, circuits & complexity, algorithms, QEC, fault tolerance, topological QC, quantum Shannon theory | A |
| 2 | [15-859BB Quantum Computation](https://www.cs.cmu.edu/~odonnell/quantum18/) — 25 lectures + 2 half-lectures | CMU (O'Donnell) | TCS-first ordering; "Rotate, Compute, Rotate" framing; Elitzur-Vaidman, CHSH, quantum money, XOR-patterns → Simon → QFT → Shor; adversary method; query complexity | A |
| 3 | [8.370x / 8.371x Quantum Information Science I & II](https://ocw.mit.edu/courses/8-371x-quantum-information-science-ii-spring-2018/) | MIT (Chuang) | Two-tier split we mirror: QIS-I (states, circuits, algorithms) vs QIS-II (density matrices, noise, QEC, fault tolerance, magic states, toric codes, MBQC, complexity, Hamiltonian simulation, HSP, linear systems) | A |
| 4 | [Chem/CS/Phys C191A Qubits, Quantum Mechanics and Computers](https://www2.eecs.berkeley.edu/Courses/EECSCourseCode.phpC191A/) | UC Berkeley (Vazirani, Kolkowitz) | Physics-and-CS hybrid entry path; explicit linear-algebra bridge; physical realizations taught alongside theory | A |
| 5 | [CS269Q Elements of Quantum Computer Programming](https://cs269q.stanford.edu/) | Stanford (Boneh, Zeng) | The *programming* spine: low-level programming, instruction sets, classical control, noise & benchmarking, hybrid algorithms, hardware & compilation, QML, error-corrected algorithms. Project-based assessment model (benchmark a QPU → hybrid algorithms → QML/compilation → capstone) | A |
| 6 | [Quantum Processes and Computation](https://www.cs.ox.ac.uk/teaching/courses/quantum/) + [Quantum Information](https://www.cs.ox.ac.uk/teaching/courses/2025-2026/qi/) + [Quantum Software](https://www.cs.ox.ac.uk/teaching/courses/2023-2024/qsoft/) | Oxford (Coecke lineage) | ZX-calculus and diagrammatic reasoning as a first-class compilation/optimization tool; non-local games; steering; dense coding | B |
| 7 | [QIC 710 Quantum Information Processing](https://cleve.iqc.uwaterloo.ca/qic710/) + [2025 notes](https://cleve.iqc.uwaterloo.ca/resources/QIC-710-F25/Qic710LectureNotes2025V5.pdf) | Waterloo IQC (Cleve) | Three-part graduate structure (primer → algorithms → information theory); distance measures, Schmidt decomposition, non-locality, BB84 / Lo-Chau, bit commitment impossibility | A |
| 8 | [Watrous QC lecture notes, 22 lectures](https://cs.uwaterloo.ca/~watrous/QC-notes/) | Watrous (Calgary/Waterloo) | Clean derivation order for phase estimation → order finding → factoring; communication complexity; CSS codes | B |
| 9 | [IBM Quantum Learning — 14 courses](https://quantum.cloud.ibm.com/learning/en/courses) | IBM | Industry-canonical lesson granularity. Directly mirrored: Basics of quantum information, Fundamentals of quantum algorithms, General formulation of quantum information, Foundations of QEC, Variational algorithm design, Quantum chemistry with VQE, Quantum diagonalization (VQE/Krylov/SQD), QML, Utility-scale QC, Quantum + HPC, Quantum business foundations | A |
| 10 | [PennyLane Codebook — 15 modules](https://pennylane.ai/codebook) | Xanadu | Codercise pedagogy: every concept has an executable micro-exercise. Module order for gates → many qubits → Hamiltonian evolution → noisy theory → distance measures → QEC → algorithms → Grover → QFT → QPE → Shor → variational → Hamiltonian simulation | A |
| 11 | [Microsoft Quantum Katas](https://github.com/microsoft/QuantumKatas) (archived; superseded by Azure Quantum katas) | Microsoft | Exercise taxonomy and progression: complex arithmetic → linear algebra → qubit → gates → measurements → distinguish unitaries → oracles → DJ → Simon → Grover (SAT, graph colouring, knapsack) → QFT → QPE → CHSH/GHZ/Mermin-Peres → reversible computing → BB84 → bit-flip code | A |
| 12 | [QWorld QBook101](https://qworld.net/qbook101/) | QWorld | The single best *ramp* for absolute beginners: real-valued qubits before complex ones, probabilistic bits before quantum bits, coin-flipping games, tomography on the unit circle | A |
| 13 | [Quantum Algorithm Zoo](https://quantumalgorithmzoo.org/) | Jordan / Microsoft | Authoritative algorithm taxonomy + speedup classification used verbatim for our algorithm catalogue: algebraic/number-theoretic, oracular, approximation/simulation, optimization/numerics/ML | A |
| 14 | [Quantum Computing for the Very Curious](https://quantum.country/qcvc) | Matuschak & Nielsen | Mnemonic medium: embedded spaced-repetition prompts, "the promise each question makes is that you will remember the answer forever", deliberate redundancy, private self-assessment | C |
| 15 | [Cirq experiments & ReCirq](https://quantumai.google/cirq/experiments) | Google Quantum AI | Applied-experiment catalogue: QAOA (angles, hardware landscape, optimization path), Hartree-Fock VQE, Fermi-Hubbard, OTOC scrambling, toric code, KPZ dynamics, random circuit sampling, quantum walks, Fourier checking, hidden linear function | B |
| 16 | [qBraid docs](https://docs.qbraid.com/) | qBraid | Multi-backend abstraction: QRN device addressing `vendor:provider:type:name`, universal job submission endpoints, credit/cost pre-confirmation. Model for our provider adapter layer | C |
| 17 | [QuTech Academy / QuTube](https://www.qutube.nl/) | TU Delft | Nine-course ladder incl. Quantum Internet, Quantum Communication, Germanium quantum technology, ML for semiconductor quantum devices. Source for our hardware and networking tracks | B |
| 18 | [Nielsen & Chuang, *Quantum Computation and Quantum Information* (10th anniv.)](https://www.cambridge.org/highereducation/books/quantum-computation-and-quantum-information/01E10196D0A682A6AEFFEA52D53BE9AE) | Cambridge | Canonical reference; cited per-lesson for further reading. Universal prerequisite text across sources 1-8 | B |
| 19 | [30 real quantum coding & system-design interview questions](https://quantumcomputingjobs.co.uk/career-advice/quantum-computing-job-interview-warmup-30-real-coding-systemdesign-questions) + [100+ question bank](https://www.wecreateproblems.com/interview-questions/quantum-computing-interview-questions) + [IBM-specific set](https://www.jobaaj.com/blog/top-15-quantum-computing-interview-questions-ibm) | Industry | Interview-prep module: circuit construction, custom state init, hybrid preprocessing, Grover on 3 qubits, Shor pseudocode, ZNE / repetition codes, statevector storage, unitarity checks, VQE parameter optimization, controlled-Rz decomposition, Trotter-Suzuki, QRNG, quantum kernels, resource counting; plus 15 system-design prompts (full-stack platform, topology & QEC mapping, HPC↔QPU loop, compiler passes, cloud QPU service, QKD, 50→200 qubit scaling, mitigation service, annealer+HPC, distributed 30-qubit simulation, mid-circuit feedback, multi-tenancy, Shor resource estimation, QNN in PyTorch, lab instrument integration) | A |
| 20 | [Taste Skill docs](https://www.tasteskill.dev/docs) + [Impeccable docs](https://impeccable.style/docs/) + [awesome-design-md](https://github.com/voltagent/awesome-design-md) + [img2threejs](https://github.com/img2threejs/img2threejs) | Design references | Colour/shape/theme locks, hero discipline, anti-slop ban list; DESIGN.md schema; procedural code-only Three.js reconstruction methodology for our 3D instruments | C |

## What the benchmark says about the field's teaching gaps

Reading 20 syllabi side by side, five gaps repeat almost everywhere. Each one is a
product requirement for us.

1. **The linear-algebra cliff.** Sources 1-8 assume it; source 12 is the only one
   that builds up from probabilistic bits and real-valued qubits. Everyone else
   loses beginners in week two.
   → *We make T0 a real, gated, placement-tested track, and we teach real-valued
   qubits before complex ones.*
2. **Theory and code live in different buildings.** Sources 1-4, 6-8 are
   proof-driven with no executable artefact. Sources 9-11 are executable but
   thin on why. Only source 5 sits in the middle, and it is a 10-week course
   that has not run since 2019.
   → *Every lesson ships with a runnable circuit and every proof step has a
   simulation that confirms it numerically.*
3. **Nothing is retained.** Only source 14 addresses forgetting at all.
   → *Spaced-repetition drill cards are generated from every lesson, not bolted on.*
4. **No competitive practice loop.** No source has anything resembling LeetCode
   contests, and quantum hiring (source 19) demands exactly that muscle.
   → *Weekly rated contests with a real rating system.*
5. **Noise is taught last or not at all.** Sources 1, 3, 7, 9-11 put noise and QEC
   at the end. But every practitioner meets noise on day one of touching hardware.
   → *Noise is introduced in T1 as an observable phenomenon, formalised in T4.*
