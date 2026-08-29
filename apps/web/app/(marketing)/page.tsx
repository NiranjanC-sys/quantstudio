import Link from 'next/link';
import type { Metadata } from 'next';
import { HeroInstrument } from '@/components/marketing/HeroInstrument';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';

export const metadata: Metadata = {
  description:
    'A 306 lesson quantum computing curriculum benchmarked against 20 university syllabi, a circuit builder that simulates as you type, autograded labs, and weekly rated contests.',
};

const TRACKS = [
  { id: 'T0', name: 'Mathematical and Computational Foundations', level: 'L0', lessons: 26, blurb: 'The linear algebra, probability and reversible computation every other course assumes you already have.' },
  { id: 'T1', name: 'Quantum Computing Core', level: 'L1', lessons: 61, blurb: 'Qubits, measurement, entanglement, nonlocality, the circuit model, and your first four algorithms.' },
  { id: 'T2', name: 'Quantum Algorithms and Complexity', level: 'L2', lessons: 48, blurb: 'Grover, the Fourier transform, phase estimation, Shor, hidden subgroups, walks, simulation, lower bounds.' },
  { id: 'T3', name: 'Quantum Software Engineering', level: 'L1', lessons: 41, blurb: 'Five SDKs, OpenQASM 3, transpilation, resource estimation, testing quantum code, benchmarking, mitigation.' },
  { id: 'T4', name: 'Noise, Error Correction and Fault Tolerance', level: 'L2', lessons: 42, blurb: 'Density matrices, channels, stabilizers, surface codes, decoding, magic states, the threshold theorem.' },
  { id: 'T5', name: 'Applications', level: 'L2', lessons: 43, blurb: 'Chemistry and VQE, optimisation and QAOA, quantum machine learning, cryptography and the migration to PQC.' },
  { id: 'T6', name: 'Hardware and Systems', level: 'L2', lessons: 30, blurb: 'Transmons, ions, photons, neutral atoms, spins. Coherence, calibration, cryogenics, cloud QPU systems.' },
  { id: 'T7', name: 'Career and Research', level: 'L1', lessons: 15, blurb: 'Reading papers, thirty recurring interview patterns, twenty employer briefings, a defended capstone.' },
];

const SOURCES = [
  'Caltech Ph219', 'CMU 15-859BB', 'MIT 8.370x and 8.371x', 'Berkeley C191A', 'Stanford CS269Q',
  'Oxford Quantum Processes', 'Waterloo QIC 710', 'IBM Quantum Learning', 'PennyLane Codebook',
  'Microsoft Quantum Katas', 'QWorld QBook101', 'Quantum Algorithm Zoo', 'Quantum Country',
  'Google Cirq and ReCirq', 'TU Delft QuTech Academy', 'Nielsen and Chuang',
];

export default function HomePage() {
  return (
    <>
      <SiteHeader />

      <main id="main">
        <section className="rq-hero">
          <div className="rq-hero-copy">
            <h1 className="rq-display">Learn quantum computing by building it.</h1>
            <p className="rq-lead">
              A 306 lesson curriculum benchmarked against 20 university syllabi, a circuit builder
              that simulates as you type, and weekly rated contests.
            </p>
            <div className="rq-hero-cta">
              <Link href="/lab" className="rq-btn rq-btn-primary rq-btn-lg">Open the lab</Link>
              <Link href="/curriculum" className="rq-btn rq-btn-secondary rq-btn-lg">See the curriculum</Link>
            </div>
          </div>
          <HeroInstrument />
        </section>

        <section className="rq-section" aria-labelledby="why">
          <div className="rq-split">
            <div className="rq-split-narrow">
              <h2 id="why" className="rq-h2">Reading about superposition is not the same as steering it.</h2>
            </div>
            <div className="rq-split-wide">
              <p className="rq-prose-p">
                We read twenty syllabi from Caltech, MIT, Berkeley, Stanford, CMU, Oxford, Waterloo,
                Delft, IBM, Google, Microsoft and Xanadu before writing a single lesson. Five gaps
                repeated almost everywhere, and each one became a product requirement.
              </p>
              <dl className="rq-gap-list">
                <div>
                  <dt>The linear algebra cliff</dt>
                  <dd>Most courses assume it and lose people in week two. Ours builds up from probabilistic bits and real-valued qubits, and the placement test lets you skip what you already know.</dd>
                </div>
                <div>
                  <dt>Theory and code in different buildings</dt>
                  <dd>Proof-driven courses ship nothing runnable. Exercise platforms are thin on why. Every lesson here carries a circuit you can run, and every claim has a simulation that confirms it numerically.</dd>
                </div>
                <div>
                  <dt>Nothing is retained</dt>
                  <dd>Spaced repetition drills are generated from every module, not bolted on afterwards.</dd>
                </div>
                <div>
                  <dt>No competitive practice</dt>
                  <dd>Quantum hiring asks for exactly the muscle that timed problems build. Contests run weekly and are rated.</dd>
                </div>
                <div>
                  <dt>Noise taught last</dt>
                  <dd>Every practitioner meets noise on day one of touching hardware, so we introduce it as an observable phenomenon in the core track and formalise it later.</dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        <section className="rq-section" aria-labelledby="curriculum">
          <h2 id="curriculum" className="rq-h2">Eight tracks, 64 modules, 306 lessons.</h2>
          <p className="rq-section-sub">
            Arranged as a prerequisite graph, not a playlist. The placement test writes straight into
            it, so you start where you actually are.
          </p>
          <ol className="rq-track-list">
            {TRACKS.map((t) => (
              <li key={t.id}>
                <span className="rq-track-id rq-numeric">{t.id}</span>
                <div className="rq-track-body">
                  <h3 className="rq-track-name">{t.name}</h3>
                  <p className="rq-track-blurb">{t.blurb}</p>
                </div>
                <span className="rq-track-meta rq-numeric">{t.level}</span>
                <span className="rq-track-meta rq-numeric">{t.lessons} lessons</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="rq-section" aria-labelledby="sources">
          <h2 id="sources" className="rq-h2">Where the curriculum comes from.</h2>
          <p className="rq-section-sub">
            Every topic traces to at least two of these. Each lesson cites its sources at the foot of
            the page, with links.
          </p>
          <ul className="rq-source-list">
            {SOURCES.map((s) => (
              <li key={s} className="rq-tag">{s}</li>
            ))}
          </ul>
        </section>

        <section className="rq-section rq-section-quiet" aria-labelledby="lab">
          <div className="rq-split">
            <div className="rq-split-narrow">
              <h2 id="lab" className="rq-h2">The lab simulates as you type.</h2>
              <p className="rq-prose-p">
                Up to fourteen qubits runs in your browser, so the Bloch sphere and the amplitude
                table move at frame rate with no round trip. Past that it goes to the server, and
                the interface says so rather than quietly stalling.
              </p>
              <p className="rq-prose-p">
                Drag gates onto wires or write OpenQASM 3. Both are views of one circuit
                representation, so editing either changes the other. Export to Qiskit, Cirq or
                PennyLane in one click.
              </p>
              <Link href="/lab" className="rq-btn rq-btn-primary">Open the lab</Link>
            </div>
            <div className="rq-split-wide">
              <ul className="rq-feature-rows">
                <li><span className="rq-feature-k">42 gates</span><span className="rq-feature-v">including parameterised rotations, arbitrary controls, mid-circuit measurement, reset and classical conditions</span></li>
                <li><span className="rq-feature-k">4 dialects</span><span className="rq-feature-v">OpenQASM 3 round trips into the builder; Qiskit, Cirq and PennyLane are export targets</span></li>
                <li><span className="rq-feature-k">Real noise</span><span className="rq-feature-v">depolarising, amplitude and phase damping, readout error, and device-derived models</span></li>
                <li><span className="rq-feature-k">Honest numbers</span><span className="rq-feature-v">depth, two-qubit count, T-count, Clifford status and shot-noise error bars, on every run</span></li>
              </ul>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
