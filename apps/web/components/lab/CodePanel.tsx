'use client';

/**
 * The code half of the workspace.
 *
 * The builder and the editor are two views of one IR, so changing either one
 * changes the other. Only OpenQASM 3 parses back into the builder; the three
 * Python dialects are export targets, which the panel says plainly rather than
 * pretending to be bidirectional.
 */

import { useEffect, useState } from 'react';
import { DIALECTS, type Dialect } from '@redquant/qir';
import { useCircuit } from '@/lib/circuit-store';

export function CodePanel() {
  const dialect = useCircuit((s) => s.dialect);
  const setDialect = useCircuit((s) => s.setDialect);
  const source = useCircuit((s) => s.source);
  const hash = useCircuit((s) => s.hash);
  const importQasm = useCircuit((s) => s.importQasm);

  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Regenerate whenever the circuit or dialect changes, unless the learner is
  // mid-edit; clobbering their typing would be the worst possible behaviour.
  useEffect(() => {
    if (!dirty) {
      setDraft(source());
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, dialect]);

  const editable = dialect === 'qasm3';

  const apply = () => {
    const res = importQasm(draft);
    if (res.ok) {
      setDirty(false);
      setError(null);
    } else {
      setError(res.error);
    }
  };

  return (
    <div className="rq-code">
      <header className="rq-panel-head">
        <div className="rq-tabs" role="tablist" aria-label="Code dialect">
          {DIALECTS.map((d) => (
            <button
              key={d.id}
              role="tab"
              aria-selected={dialect === d.id}
              className={`rq-tab${dialect === d.id ? ' is-active' : ''}`}
              onClick={() => {
                setDialect(d.id as Dialect);
                setDirty(false);
              }}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="rq-panel-actions">
          {editable && dirty && (
            <button type="button" className="rq-btn rq-btn-primary rq-btn-sm" onClick={apply}>
              Apply to circuit
            </button>
          )}
          <button
            type="button"
            className="rq-btn rq-btn-secondary rq-btn-sm"
            onClick={async () => {
              await navigator.clipboard.writeText(draft);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </header>

      <textarea
        className="rq-code-area rq-mono"
        spellCheck={false}
        value={draft}
        readOnly={!editable}
        aria-label={`${dialect} source`}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
          setError(null);
        }}
      />

      {!editable && (
        <p className="rq-note">
          {DIALECTS.find((d) => d.id === dialect)?.label} is an export target. Edit the OpenQASM 3 tab
          or the canvas to change the circuit.
        </p>
      )}
      {error && (
        <div className="rq-verdict rq-verdict-error" role="alert">
          <span className="rq-mono">{error}</span>
        </div>
      )}
    </div>
  );
}
