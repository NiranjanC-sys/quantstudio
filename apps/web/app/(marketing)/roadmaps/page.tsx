import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';

export const metadata: Metadata = {
  title: 'Roadmaps',
  description: 'Seven paths through the prerequisite graph, one per starting point.',
};

interface Roadmap {
  id: string;
  who: string;
  duration: string;
  why: string;
  path: { label: string; note: string }[];
}

const ROADMAPS: Roadmap[] = [
  {
    id: 'cs-student', who: 'Computer science student', duration: '14 weeks',
    why: 'You have discrete maths and algorithms. You need the linear algebra bridge and then the algorithmic core.',
    path: [
      { label: 'T0.M2 to M6', note: 'complex numbers through classical computation' },
      { label: 'T1 complete', note: 'the quantum core' },
      { label: 'T2 complete', note: 'algorithms and complexity' },
      { label: 'T3.M1 to M3', note: 'SDKs, OpenQASM, transpilation' },
      { label: 'T7.M2', note: 'coding interviews' },
    ],
  },
  {
    id: 'physics-student', who: 'Physics student', duration: '12 weeks',
    why: 'You have the quantum mechanics. You need the computation, the software, and the engineering reality.',
    path: [
      { label: 'T0.M6 to M7', note: 'classical computation and Python' },
      { label: 'T1 accelerated', note: 'concepts you can skim, notation you cannot' },
      { label: 'T4 complete', note: 'noise, codes, fault tolerance' },
      { label: 'T5A', note: 'chemistry and materials' },
      { label: 'T6 complete', note: 'hardware and systems' },
    ],
  },
  {
    id: 'swe', who: 'Software engineer moving to quantum', duration: '16 weeks',
    why: 'The longest path, because it is the one that ends in a job offer. Heavy on the software track.',
    path: [
      { label: 'T0 complete', note: 'no shortcuts here' },
      { label: 'T1 complete', note: 'the quantum core' },
      { label: 'T3 complete', note: 'the software engineering track' },
      { label: 'T2.M1 to M5', note: 'query model through Shor' },
      { label: 'T7.M2 to M4', note: 'interviews and employer briefings' },
    ],
  },
  {
    id: 'ds', who: 'Data scientist moving to QML', duration: '9 weeks',
    why: 'Straight to variational methods, with only the theory you need to read the papers.',
    path: [
      { label: 'T0.M2 to M5', note: 'complex numbers through tensor products' },
      { label: 'T1.M1 to M9', note: 'qubits through interference' },
      { label: 'T5C complete', note: 'quantum machine learning' },
      { label: 'T3.M6 to M8', note: 'testing, benchmarking, mitigation' },
    ],
  },
  {
    id: 'researcher', who: 'Researcher', duration: '20 weeks',
    why: 'Placement test first, then depth. You choose the application track.',
    path: [
      { label: 'Placement test', note: 'writes straight into the DAG' },
      { label: 'T2 complete', note: 'algorithms and complexity' },
      { label: 'T4 complete', note: 'error correction and fault tolerance' },
      { label: 'One T5 sub-track', note: 'your application area' },
      { label: 'T7.M1 and M6', note: 'reading the literature, then a defended capstone' },
    ],
  },
  {
    id: 'security', who: 'Security engineer moving to PQC', duration: '7 weeks',
    why: 'The shortest technical path. What actually breaks, when, and what to migrate to.',
    path: [
      { label: 'T0.M1 to M2', note: 'probability and complex numbers' },
      { label: 'T1.M1 to M7', note: 'qubits through protocols' },
      { label: 'T2.M2 and M5', note: 'Grover and Shor' },
      { label: 'T5D complete', note: 'cryptography, QKD, post-quantum migration' },
    ],
  },
  {
    id: 'manager', who: 'Technical manager', duration: '4 weeks',
    why: 'Enough to read a proposal honestly and call a bluff. Concept lessons only, no labs.',
    path: [
      { label: 'T1.M1 to M5', note: 'concepts only' },
      { label: 'T3.M4', note: 'resource estimation' },
      { label: 'T6.M5', note: 'cloud QPU systems' },
      { label: 'T5B', note: 'optimisation, including the honest benchmarking lesson' },
    ],
  },
];

export default function RoadmapsPage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="rq-section">
          <h1 className="rq-display rq-display-sm">Seven ways in.</h1>
          <p className="rq-section-sub">
            The curriculum is a prerequisite graph, so there is no single order. These are the seven
            paths through it that we have seen work, one per starting point. The placement test can
            shorten any of them.
          </p>
        </section>

        {ROADMAPS.map((r) => (
          <section key={r.id} className="rq-section rq-roadmap" aria-labelledby={r.id}>
            <div className="rq-split">
              <div className="rq-split-narrow">
                <h2 id={r.id} className="rq-h2">{r.who}</h2>
                <p className="rq-roadmap-duration rq-numeric">{r.duration}</p>
                <p className="rq-prose-p">{r.why}</p>
              </div>
              <div className="rq-split-wide">
                <ol className="rq-roadmap-steps">
                  {r.path.map((step, i) => (
                    <li key={step.label}>
                      <span className="rq-roadmap-step-n rq-numeric">{i + 1}</span>
                      <span className="rq-roadmap-step-label">{step.label}</span>
                      <span className="rq-roadmap-step-note">{step.note}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </section>
        ))}

        <section className="rq-section">
          <Link href="/curriculum" className="rq-btn rq-btn-primary">See the full curriculum</Link>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
