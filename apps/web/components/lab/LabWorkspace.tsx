'use client';

import { useEffect } from 'react';
import { CircuitCanvas } from '@/components/circuit/CircuitCanvas';
import { GatePalette } from '@/components/circuit/GatePalette';
import { Inspector } from '@/components/circuit/Inspector';
import { ResultsPanel } from '@/components/lab/ResultsPanel';
import { CodePanel } from '@/components/lab/CodePanel';
import { ServerRun } from '@/components/lab/ServerRun';
import { Toolbar } from '@/components/lab/Toolbar';
import { useCircuit } from '@/lib/circuit-store';

export function LabWorkspace() {
  const undo = useCircuit((s) => s.undo);
  const redo = useCircuit((s) => s.redo);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  return (
    <div className="rq-lab" data-register="instrument">
      <aside className="rq-lab-palette" aria-label="Gate palette">
        <GatePalette />
      </aside>

      <main className="rq-lab-main">
        <Toolbar />
        <CircuitCanvas />
        <div className="rq-lab-lower">
          <section className="rq-lab-code" aria-label="Source code">
            <CodePanel />
          </section>
          <section className="rq-lab-results" aria-label="Simulation results">
            <ResultsPanel />
          </section>
          <section className="rq-lab-server" aria-label="Server backends">
            <ServerRun />
          </section>
        </div>
      </main>

      <aside className="rq-lab-inspector" aria-label="Gate inspector">
        <Inspector />
      </aside>
    </div>
  );
}
