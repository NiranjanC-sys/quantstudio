import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Slider } from '../src/primitives/Slider.js';

/*
 * The Slider drives live gate parameters, so the keyboard model is load
 * bearing: a learner has to be able to sweep a rotation angle without a
 * pointer. These assert the ARIA slider contract, not Radix internals.
 */

function Harness({
  min = 0,
  max = 1,
  step = 0.01,
  initial = 0.5,
  onValueChange,
}: {
  min?: number;
  max?: number;
  step?: number;
  initial?: number;
  onValueChange?: (value: number[]) => void;
}) {
  const [value, setValue] = useState<number[]>([initial]);
  return (
    <Slider
      label="Rotation"
      min={min}
      max={max}
      step={step}
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onValueChange?.(next);
      }}
    />
  );
}

const thumb = (): HTMLElement => screen.getByRole('slider');
const readValue = (): number => Number(thumb().getAttribute('aria-valuenow'));

describe('Slider keyboard control', () => {
  it('exposes the ARIA slider contract', () => {
    render(<Harness />);
    const control = thumb();
    expect(control).toHaveAttribute('aria-valuemin', '0');
    expect(control).toHaveAttribute('aria-valuemax', '1');
    expect(control).toHaveAttribute('aria-valuenow', '0.5');
    expect(control).toHaveAccessibleName('Rotation');
  });

  it('takes focus from the keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    expect(document.activeElement).toBe(thumb());
  });

  it('moves one step right on ArrowRight and one step left on ArrowLeft', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);

    thumb().focus();
    await user.keyboard('{ArrowRight}');
    expect(readValue()).toBeCloseTo(0.51, 6);

    await user.keyboard('{ArrowLeft}');
    expect(readValue()).toBeCloseTo(0.5, 6);

    // Every key press reports upward, so a statevector can follow the thumb.
    expect(onValueChange).toHaveBeenCalledTimes(2);
  });

  it('moves on ArrowUp and ArrowDown as well', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    thumb().focus();

    await user.keyboard('{ArrowUp}');
    expect(readValue()).toBeCloseTo(0.51, 6);
    await user.keyboard('{ArrowDown}');
    expect(readValue()).toBeCloseTo(0.5, 6);
  });

  it('jumps to the ends on Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    thumb().focus();

    await user.keyboard('{End}');
    expect(readValue()).toBe(1);

    await user.keyboard('{Home}');
    expect(readValue()).toBe(0);
  });

  it('clamps at the ends instead of wrapping', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    thumb().focus();

    await user.keyboard('{Home}');
    await user.keyboard('{ArrowLeft}');
    expect(readValue()).toBe(0);

    await user.keyboard('{End}');
    await user.keyboard('{ArrowRight}');
    expect(readValue()).toBe(1);
  });

  it('moves by a larger increment on PageUp and PageDown', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    thumb().focus();

    const before = readValue();
    await user.keyboard('{PageUp}');
    const after = readValue();
    expect(after).toBeGreaterThan(before + 0.01);

    await user.keyboard('{PageDown}');
    expect(readValue()).toBeCloseTo(before, 6);
  });

  it('honours a custom step, including a radian step', async () => {
    const user = userEvent.setup();
    const step = Math.PI / 180;
    render(<Harness min={0} max={Math.PI * 2} step={step} initial={Math.PI} />);
    thumb().focus();

    await user.keyboard('{ArrowRight}');
    expect(readValue()).toBeCloseTo(Math.PI + step, 6);
  });

  it('ignores the keyboard when disabled', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Slider label="Rotation" disabled value={[0.5]} onValueChange={onValueChange} />,
    );
    await user.keyboard('{ArrowRight}');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('publishes a mono tabular readout that tracks the keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const output = screen.getByText('0.500');
    expect(output.tagName.toLowerCase()).toBe('output');

    thumb().focus();
    await user.keyboard('{End}');
    expect(screen.getByText('1')).toBeInTheDocument();
  });
});
