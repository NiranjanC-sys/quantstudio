import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  THEME_STORAGE_KEY,
  ThemeProvider,
  themeScript,
  useTheme,
  type ThemePreference,
} from '../src/theme.js';

/*
 * The theme lock: dark is the default, both themes are complete, and an
 * explicit choice wins in both directions. `light` and `dark` write
 * `data-theme` on <html>; `system` removes it and hands the decision back to
 * the prefers-color-scheme blocks in tokens.css.
 */

function Toggle() {
  const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="preference">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button type="button" onClick={toggleTheme}>
        Toggle theme
      </button>
      <button type="button" onClick={() => setTheme('light')}>
        Light
      </button>
      <button type="button" onClick={() => setTheme('dark')}>
        Dark
      </button>
      <button type="button" onClick={() => setTheme('system')}>
        System
      </button>
    </div>
  );
}

const attr = (): string | null => document.documentElement.getAttribute('data-theme');

/** Pin matchMedia so `system` resolves to a known value inside a test. */
function stubPrefersLight(light: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('prefers-color-scheme: light') ? light : false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

describe('ThemeProvider', () => {
  it('defaults to dark and writes data-theme on the root', async () => {
    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    await waitFor(() => expect(attr()).toBe('dark'));
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
  });

  it('toggles data-theme in both directions', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    await waitFor(() => expect(attr()).toBe('dark'));

    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
    expect(attr()).toBe('light');
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');

    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
    expect(attr()).toBe('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');

    // And once more, so the test proves a cycle rather than a single flip.
    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
    expect(attr()).toBe('light');
  });

  it('removes data-theme for system and restores it for an explicit choice', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    await waitFor(() => expect(attr()).toBe('dark'));

    await user.click(screen.getByRole('button', { name: 'System' }));
    expect(attr()).toBeNull();
    expect(screen.getByTestId('preference')).toHaveTextContent('system');

    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(attr()).toBe('light');
  });

  it('resolves system against prefers-color-scheme', async () => {
    stubPrefersLight(true);
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'System' }));
    await waitFor(() => expect(screen.getByTestId('resolved')).toHaveTextContent('light'));

    // Toggling away from system flips away from what is actually painted.
    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
    expect(attr()).toBe('dark');
  });

  it('persists the choice to localStorage and reads it back on the next mount', async () => {
    const user = userEvent.setup();
    const first = render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    await waitFor(() => expect(attr()).toBe('dark'));
    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    first.unmount();
    document.documentElement.removeAttribute('data-theme');

    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    await waitFor(() => expect(attr()).toBe('light'));
  });

  it('ignores a corrupt stored value and falls back to the default', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse');
    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    await waitFor(() => expect(attr()).toBe('dark'));
  });

  it('survives localStorage throwing on read', async () => {
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });

    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    await waitFor(() => expect(attr()).toBe('dark'));
    expect(getItem).toHaveBeenCalled();
  });

  it('survives localStorage throwing on write and still switches the theme', async () => {
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });

    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    await waitFor(() => expect(attr()).toBe('dark'));

    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
    expect(attr()).toBe('light');
    expect(setItem).toHaveBeenCalled();
  });

  it('does not touch storage when storage is disabled', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider disableStorage>
        <Toggle />
      </ThemeProvider>,
    );
    await waitFor(() => expect(attr()).toBe('dark'));
    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(attr()).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('honours a custom storage key and a light default', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider defaultTheme="light" storageKey="rq-test-theme">
        <Toggle />
      </ThemeProvider>,
    );
    await waitFor(() => expect(attr()).toBe('light'));
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(window.localStorage.getItem('rq-test-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('refuses to render a consumer outside a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Toggle />)).toThrow(/ThemeProvider/);
    spy.mockRestore();
  });
});

describe('themeScript', () => {
  const run = (script: string): void => {
    // eslint-disable-next-line no-new-func -- exercising the emitted head script
    act(() => {
      new Function(script)();
    });
  };

  it('sets the stored theme before paint', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    run(themeScript());
    expect(attr()).toBe('light');
  });

  it('sets the default when nothing is stored', () => {
    run(themeScript());
    expect(attr()).toBe('dark');
  });

  it('clears the attribute for system so the media query decides', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    run(themeScript());
    expect(attr()).toBeNull();
  });

  it('falls back to the default when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    run(themeScript());
    expect(attr()).toBe('dark');
    spy.mockRestore();
  });

  it('honours a custom key and default', () => {
    window.localStorage.setItem('rq-alt', 'light');
    run(themeScript('rq-alt', 'dark' satisfies ThemePreference));
    expect(attr()).toBe('light');
  });
});
