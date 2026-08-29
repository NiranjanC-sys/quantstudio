'use client';

import { useState } from 'react';

export function Solution({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rq-solution">
      <button
        type="button"
        className="rq-btn rq-btn-secondary rq-btn-sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide the solution' : 'Show the solution'}
      </button>
      {open ? <div className="rq-solution-body">{children}</div> : null}
    </div>
  );
}
