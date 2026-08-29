'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

/**
 * Theme choice is persisted, but localStorage throws in some privacy modes, so
 * every access is guarded and the control still works without persistence.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    try {
      const stored = localStorage.getItem('rq-theme');
      if (stored === 'light' || stored === 'dark') setTheme(stored);
    } catch {
      /* storage unavailable; stay on system */
    }
  }, []);

  const apply = (next: Theme) => {
    setTheme(next);
    const root = document.documentElement;
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);
    try {
      if (next === 'system') localStorage.removeItem('rq-theme');
      else localStorage.setItem('rq-theme', next);
    } catch {
      /* storage unavailable; the attribute is already applied */
    }
  };

  const next: Theme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
  const labels: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' };

  return (
    <button
      type="button"
      className="rq-btn rq-btn-tertiary rq-btn-sm"
      onClick={() => apply(next)}
      aria-label={`Theme: ${labels[theme]}. Switch to ${labels[next]}.`}
    >
      {labels[theme]}
    </button>
  );
}
