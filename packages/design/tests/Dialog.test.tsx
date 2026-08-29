import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../src/primitives/Button.js';
import { Dialog } from '../src/primitives/Dialog.js';

function Harness({ dismissible = true }: { dismissible?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open lab
      </button>
      <input aria-label="Outside field" />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Run circuit"
        description="Choose a backend and a shot count."
        dismissible={dismissible}
        footer={
          <>
            <Button variant="secondary">Cancel</Button>
            <Button variant="primary">Run</Button>
          </>
        }
      >
        <input aria-label="Shots" />
      </Dialog>
    </div>
  );
}

describe('Dialog', () => {
  it('announces itself with a title and a description', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open lab' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Run circuit');
    expect(dialog).toHaveAccessibleDescription('Choose a backend and a shot count.');
  });

  it('moves focus inside on open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open lab' }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it('traps Tab inside the dialog and cycles back to the first control', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open lab' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const outside = screen.getByLabelText('Outside field');
    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(outside);
    }
  });

  it('traps Shift and Tab in the other direction too', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open lab' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    for (let i = 0; i < 12; i += 1) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open lab' }));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('ignores Escape when it is not dismissible', async () => {
    const user = userEvent.setup();
    render(<Harness dismissible={false} />);
    await user.click(screen.getByRole('button', { name: 'Open lab' }));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');
    // Give the close animation a chance to have happened, then assert it did not.
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('returns focus to the trigger on close', async () => {
    const user = userEvent.setup();
    render(
      <Dialog trigger={<Button>Open lab</Button>} title="Run circuit" description="Pick a backend">
        <input aria-label="Shots" />
      </Dialog>,
    );
    const trigger = screen.getByRole('button', { name: 'Open lab' });
    await user.click(trigger);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('locks page scroll while open and releases it on close', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Open lab' }));
    await screen.findByRole('dialog');
    await waitFor(() => {
      expect(document.body.hasAttribute('data-scroll-locked')).toBe(true);
    });

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => {
      expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);
    });
  });

  it('closes from the close button', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} title="Delete run" closeLabel="Close">
        <p>Body</p>
      </Dialog>,
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
