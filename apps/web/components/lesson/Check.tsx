'use client';

import { useState } from 'react';

/**
 * A self-test prompt. The answer is hidden behind a deliberate action because
 * the retrieval attempt is the part that does the work; revealing it by
 * default would turn the prompt into another sentence to skim.
 */
export function Check({ question, children }: { question: string; children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="rq-check">
      <p className="rq-check-q">{question}</p>
      {shown ? (
        <div className="rq-check-a">{children}</div>
      ) : (
        <button type="button" className="rq-btn rq-btn-secondary rq-btn-sm" onClick={() => setShown(true)}>
          Show the answer
        </button>
      )}
    </div>
  );
}
