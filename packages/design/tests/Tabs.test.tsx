import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs, type TabItem } from '../src/primitives/Tabs.js';

/*
 * Roving tabindex: the whole tab list is one tab stop. The selected trigger
 * carries tabindex="0" and every other trigger carries tabindex="-1", so Tab
 * enters and leaves the list once and arrow keys move within it.
 */

const items: readonly TabItem[] = [
  { value: 'circuit', label: 'Circuit', content: <p>Circuit panel</p> },
  { value: 'state', label: 'State', content: <p>State panel</p> },
  { value: 'tests', label: 'Tests', content: <p>Tests panel</p> },
];

const triggers = (): HTMLElement[] => screen.getAllByRole('tab');

const tabIndexes = (): Array<string | null> =>
  triggers().map((tab) => tab.getAttribute('tabindex'));

describe('Tabs roving tabindex', () => {
  it('holds no trigger in the tab order before focus enters the list', () => {
    render(<Tabs items={items} defaultValue="circuit" />);
    // The list itself is the single entry point; the triggers are all -1 until
    // focus arrives, which is what keeps the list to one tab stop.
    expect(screen.getByRole('tablist')).toHaveAttribute('tabindex', '0');
    expect(tabIndexes()).toEqual(['-1', '-1', '-1']);
    expect(triggers()[0]).toHaveAttribute('aria-selected', 'true');
    expect(triggers()[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('gives the selected trigger the only tabindex of 0 once focus enters', async () => {
    const user = userEvent.setup();
    render(<Tabs items={items} defaultValue="state" />);

    await user.tab();
    expect(document.activeElement).toBe(triggers()[1]);
    expect(tabIndexes()).toEqual(['-1', '0', '-1']);
  });

  it('moves the tabindex of 0 with the selection', async () => {
    const user = userEvent.setup();
    render(<Tabs items={items} defaultValue="circuit" />);

    act(() => triggers()[0]?.focus());
    await user.keyboard('{ArrowRight}');

    await waitFor(() => expect(tabIndexes()).toEqual(['-1', '0', '-1']));
    expect(document.activeElement).toBe(triggers()[1]);
  });

  it('enters the list in one Tab press and leaves it in one more', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Before</button>
        <Tabs items={items} defaultValue="state" />
        <button type="button">After</button>
      </div>,
    );

    await user.tab(); // Before
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Before' }));

    await user.tab(); // into the list, landing on the selected trigger
    expect(document.activeElement).toBe(triggers()[1]);

    await user.tab(); // out of the list, into the panel
    expect(document.activeElement).not.toBe(triggers()[0]);
    expect(document.activeElement).not.toBe(triggers()[2]);
  });

  it('wraps at both ends with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<Tabs items={items} defaultValue="circuit" />);
    act(() => triggers()[0]?.focus());

    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(document.activeElement).toBe(triggers()[2]));

    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(document.activeElement).toBe(triggers()[0]));
  });

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup();
    render(<Tabs items={items} defaultValue="circuit" />);
    act(() => triggers()[0]?.focus());

    await user.keyboard('{End}');
    await waitFor(() => expect(document.activeElement).toBe(triggers()[2]));

    await user.keyboard('{Home}');
    await waitFor(() => expect(document.activeElement).toBe(triggers()[0]));
  });

  it('shows only the selected panel and wires it to its trigger', async () => {
    const user = userEvent.setup();
    render(<Tabs items={items} defaultValue="circuit" />);

    expect(screen.getByText('Circuit panel')).toBeInTheDocument();
    expect(screen.queryByText('State panel')).not.toBeInTheDocument();

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', triggers()[0]?.id);

    act(() => triggers()[0]?.focus());
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(screen.getByText('State panel')).toBeInTheDocument());
    expect(screen.queryByText('Circuit panel')).not.toBeInTheDocument();
  });

  it('waits for Enter in manual activation mode', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Tabs
        items={items}
        defaultValue="circuit"
        activationMode="manual"
        onValueChange={onValueChange}
      />,
    );

    act(() => triggers()[0]?.focus());
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(document.activeElement).toBe(triggers()[1]));
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByText('Circuit panel')).toBeInTheDocument();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith('state'));
  });

  it('skips a disabled trigger when arrowing', async () => {
    const user = userEvent.setup();
    render(
      <Tabs
        items={[
          { value: 'a', label: 'A', content: <p>A panel</p> },
          { value: 'b', label: 'B', disabled: true, content: <p>B panel</p> },
          { value: 'c', label: 'C', content: <p>C panel</p> },
        ]}
        defaultValue="a"
      />,
    );

    act(() => triggers()[0]?.focus());
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(document.activeElement).toBe(triggers()[2]));
  });

  it('reports the orientation so assistive tech announces the right axis', () => {
    render(<Tabs items={items} defaultValue="circuit" orientation="vertical" />);
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
  });
});
