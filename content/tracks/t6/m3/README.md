# T6.M3 Calibration

Compilers trust numbers that were measured hours ago. This module explains where those numbers come from and how fast they rot. Spectroscopy sweeps locate the qubit transition frequency, Rabi amplitude sweeps fix the pulse amplitude of a pi rotation, and a detuned drive produces an oscillation whose changed rate and reduced contrast are themselves diagnostic. Drift follows: two-level-system defects and slow flux or temperature variation move the operating point, so a benchmark run late in the day disagrees with the published figure. The module ends with calibration modelled as a dependency graph, checked node by node so a failure repairs a subtree rather than a whole device.

| id | title | type | minutes |
| --- | --- | --- | --- |
| t6.m3.l1 | Rabi and Frequency Sweeps | concept | 13 |
| t6.m3.l2 | Calibration Drift | concept | 12 |
| t6.m3.l3 | Automated Calibration Graphs | concept | 13 |

**Prerequisites:** t6.m2.l1, t6.m2.l3

**Sources:** S9 IBM Quantum Learning courses (https://quantum.cloud.ibm.com/learning/en/courses); S15 Cirq experiments and ReCirq (Google Quantum AI) (https://quantumai.google/cirq/experiments); S17 QuTech Academy / QuTube (TU Delft) (https://www.qutube.nl/)
