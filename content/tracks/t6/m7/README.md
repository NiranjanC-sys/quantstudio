# T6.M7 Quantum and HPC

Quantum processors will arrive inside supercomputing centres, scheduled beside CPUs and GPUs rather than instead of them. This module contrasts loosely coupled offload, where a job is submitted and awaited, with tight co-scheduling that reserves the device for the lifetime of a classical allocation, and derives the latency requirement a per-iteration variational loop imposes. Programming models follow: the QPU as an accelerator kernel against the QPU as a job endpoint, and what an intermediate representation contributes when several devices are targets. The last lesson sets the bar the hardware must clear, because 16 bytes times 2 to the n is what distributed statevector simulation costs.

| id | title | type | minutes |
| --- | --- | --- | --- |
| t6.m7.l1 | Co-Scheduling Models | concept | 13 |
| t6.m7.l2 | Programming Models | concept | 13 |
| t6.m7.l3 | Distributed Statevector Simulation | concept | 14 |

**Prerequisites:** t2.m9.l5, t3.m1.l3, t3.m5.l4, t6.m5.l1

**Sources:** S5 CS269Q Elements of Quantum Computer Programming (Stanford) (https://cs269q.stanford.edu/); S9 IBM Quantum Learning courses (https://quantum.cloud.ibm.com/learning/en/courses); S15 Cirq experiments and ReCirq (Google Quantum AI) (https://quantumai.google/cirq/experiments); S17 QuTech Academy / QuTube (TU Delft) (https://www.qutube.nl/)
