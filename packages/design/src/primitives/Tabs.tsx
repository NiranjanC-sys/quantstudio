'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { Tabs as RadixTabs } from 'radix-ui';
import { cx } from '../utils.js';

export interface TabItem {
  value: string;
  label: ReactNode;
  /** Right-hand adornment, typically a Badge with a count. */
  adornment?: ReactNode;
  disabled?: boolean;
  content?: ReactNode;
}

export interface TabsProps {
  items: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: 'horizontal' | 'vertical';
  /**
   * `automatic` selects on arrow key, `manual` waits for Enter or Space. Use
   * `manual` when a panel is expensive to render.
   */
  activationMode?: 'automatic' | 'manual';
  className?: string;
  /** Right side of the tab list. */
  toolbar?: ReactNode;
  children?: ReactNode;
}

/**
 * Radix Tabs supplies the roving tabindex: the list is one tab stop, and arrow
 * keys move between triggers. The active tab is marked by a 2px accent rule on
 * the list hairline, never by a filled pill.
 */
export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  {
    items,
    value,
    defaultValue,
    onValueChange,
    orientation = 'horizontal',
    activationMode = 'automatic',
    className,
    toolbar,
    children,
  },
  ref,
) {
  const first = items[0];
  return (
    <RadixTabs.Root
      ref={ref}
      className={cx('rq-tabs', className)}
      value={value}
      defaultValue={defaultValue ?? first?.value}
      onValueChange={onValueChange}
      orientation={orientation}
      activationMode={activationMode}
    >
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 12 }}>
        <RadixTabs.List className="rq-tabs__list" style={{ flex: 1, minWidth: 0 }}>
          {items.map((item) => (
            <RadixTabs.Trigger
              key={item.value}
              value={item.value}
              disabled={item.disabled}
              className={cx('rq-tabs__trigger', 'rq-focusable')}
            >
              {item.label}
              {item.adornment}
            </RadixTabs.Trigger>
          ))}
        </RadixTabs.List>
        {toolbar === undefined ? null : (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 4, borderBottom: '1px solid var(--rq-hairline)' }}
          >
            {toolbar}
          </div>
        )}
      </div>

      {items.map((item) =>
        item.content === undefined ? null : (
          <RadixTabs.Content key={item.value} value={item.value} className="rq-tabs__content">
            {item.content}
          </RadixTabs.Content>
        ),
      )}
      {children}
    </RadixTabs.Root>
  );
});

export interface TabPanelProps {
  value: string;
  className?: string;
  children?: ReactNode;
}

/** Escape hatch for panels declared outside the `items` array. */
export const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(function TabPanel(
  { value, className, children },
  ref,
) {
  return (
    <RadixTabs.Content ref={ref} value={value} className={cx('rq-tabs__content', className)}>
      {children}
    </RadixTabs.Content>
  );
});
