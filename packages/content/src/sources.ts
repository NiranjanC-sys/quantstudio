/**
 * The 20 primary sources of docs/research/01-curriculum-benchmark.md.
 *
 * Every lesson in the catalogue cites at least one of these by key. Keys are
 * stable; URLs are the ones recorded in the benchmark document. Where a source
 * has no single canonical URL (a printed book), the URL is the publisher page.
 */

export const SOURCE_KEYS = [
  'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10',
  'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18', 'S19', 'S20',
] as const;

export type SourceKey = (typeof SOURCE_KEYS)[number];

export interface SourceRef {
  label: string;
  url: string;
}

/** Weight: A = structural, B = topical, C = pedagogy or tooling. */
export interface BenchmarkSource extends SourceRef {
  key: SourceKey;
  owner: string;
  weight: 'A' | 'B' | 'C';
}

export const BENCHMARK_SOURCES: Record<SourceKey, BenchmarkSource> = {
  S1: {
    key: 'S1',
    label: 'Preskill, Ph219/CS219 Quantum Computation lecture notes (Caltech)',
    url: 'http://theory.caltech.edu/~preskill/ph219/ph219_2021-22.html',
    owner: 'Caltech',
    weight: 'A',
  },
  S2: {
    key: 'S2',
    label: "O'Donnell, 15-859BB Quantum Computation (CMU)",
    url: 'https://www.cs.cmu.edu/~odonnell/quantum18/',
    owner: 'Carnegie Mellon',
    weight: 'A',
  },
  S3: {
    key: 'S3',
    label: 'Chuang, 8.370x / 8.371x Quantum Information Science I & II (MIT)',
    url: 'https://ocw.mit.edu/courses/8-371x-quantum-information-science-ii-spring-2018/',
    owner: 'MIT',
    weight: 'A',
  },
  S4: {
    key: 'S4',
    label: 'C191A Qubits, Quantum Mechanics and Computers (UC Berkeley)',
    url: 'https://www2.eecs.berkeley.edu/Courses/EECSCourseCode.phpC191A/',
    owner: 'UC Berkeley',
    weight: 'A',
  },
  S5: {
    key: 'S5',
    label: 'CS269Q Elements of Quantum Computer Programming (Stanford)',
    url: 'https://cs269q.stanford.edu/',
    owner: 'Stanford',
    weight: 'A',
  },
  S6: {
    key: 'S6',
    label: 'Quantum Processes and Computation / Quantum Software (Oxford)',
    url: 'https://www.cs.ox.ac.uk/teaching/courses/quantum/',
    owner: 'Oxford',
    weight: 'B',
  },
  S7: {
    key: 'S7',
    label: 'Cleve, QIC 710 Quantum Information Processing (Waterloo IQC)',
    url: 'https://cleve.iqc.uwaterloo.ca/qic710/',
    owner: 'University of Waterloo',
    weight: 'A',
  },
  S8: {
    key: 'S8',
    label: 'Watrous, Quantum Computation lecture notes',
    url: 'https://cs.uwaterloo.ca/~watrous/QC-notes/',
    owner: 'John Watrous',
    weight: 'B',
  },
  S9: {
    key: 'S9',
    label: 'IBM Quantum Learning courses',
    url: 'https://quantum.cloud.ibm.com/learning/en/courses',
    owner: 'IBM',
    weight: 'A',
  },
  S10: {
    key: 'S10',
    label: 'PennyLane Codebook',
    url: 'https://pennylane.ai/codebook',
    owner: 'Xanadu',
    weight: 'A',
  },
  S11: {
    key: 'S11',
    label: 'Microsoft Quantum Katas',
    url: 'https://github.com/microsoft/QuantumKatas',
    owner: 'Microsoft',
    weight: 'A',
  },
  S12: {
    key: 'S12',
    label: 'QWorld QBook101',
    url: 'https://qworld.net/qbook101/',
    owner: 'QWorld',
    weight: 'A',
  },
  S13: {
    key: 'S13',
    label: 'Quantum Algorithm Zoo',
    url: 'https://quantumalgorithmzoo.org/',
    owner: 'Stephen Jordan / Microsoft',
    weight: 'A',
  },
  S14: {
    key: 'S14',
    label: 'Matuschak & Nielsen, Quantum Computing for the Very Curious',
    url: 'https://quantum.country/qcvc',
    owner: 'Andy Matuschak & Michael Nielsen',
    weight: 'C',
  },
  S15: {
    key: 'S15',
    label: 'Cirq experiments and ReCirq (Google Quantum AI)',
    url: 'https://quantumai.google/cirq/experiments',
    owner: 'Google Quantum AI',
    weight: 'B',
  },
  S16: {
    key: 'S16',
    label: 'qBraid documentation',
    url: 'https://docs.qbraid.com/',
    owner: 'qBraid',
    weight: 'C',
  },
  S17: {
    key: 'S17',
    label: 'QuTech Academy / QuTube (TU Delft)',
    url: 'https://www.qutube.nl/',
    owner: 'TU Delft',
    weight: 'B',
  },
  S18: {
    key: 'S18',
    label: 'Nielsen & Chuang, Quantum Computation and Quantum Information',
    url: 'https://www.cambridge.org/highereducation/books/quantum-computation-and-quantum-information/01E10196D0A682A6AEFFEA52D53BE9AE',
    owner: 'Cambridge University Press',
    weight: 'B',
  },
  S19: {
    key: 'S19',
    label: 'Real quantum coding and system-design interview questions',
    url: 'https://quantumcomputingjobs.co.uk/career-advice/quantum-computing-job-interview-warmup-30-real-coding-systemdesign-questions',
    owner: 'Industry',
    weight: 'A',
  },
  S20: {
    key: 'S20',
    label: 'RedQuant design references (Taste Skill, Impeccable, awesome-design-md)',
    url: 'https://www.tasteskill.dev/docs',
    owner: 'Design references',
    weight: 'C',
  },
};

/** Expand source keys to the {label, url} pairs stored on every lesson. */
export function refs(...keys: SourceKey[]): SourceRef[] {
  return keys.map((k) => {
    const s = BENCHMARK_SOURCES[k];
    return { label: s.label, url: s.url };
  });
}
