'use client';

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { DropdownMenu as RadixMenu } from 'radix-ui';
import { cx } from '../utils.js';
import { CheckIcon, CircleIcon } from '../icons.js';

export interface MenuAction {
  kind?: 'action';
  id: string;
  label: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  /** Rendered right-aligned in mono. */
  shortcut?: string;
  icon?: ReactNode;
  variant?: 'default' | 'danger';
}

export interface MenuCheckbox {
  kind: 'checkbox';
  id: string;
  label: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

export interface MenuRadioGroup {
  kind: 'radio';
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: ReactNode; disabled?: boolean }>;
}

export interface MenuSeparator {
  kind: 'separator';
  id: string;
}

export interface MenuLabel {
  kind: 'label';
  id: string;
  label: ReactNode;
}

export type MenuItem = MenuAction | MenuCheckbox | MenuRadioGroup | MenuSeparator | MenuLabel;

export interface DropdownMenuProps {
  /** The trigger. Must be a single focusable element. */
  trigger: ReactNode;
  items: readonly MenuItem[];
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  /** Shown when `items` is empty. */
  emptyMessage?: string;
}

/**
 * Radix DropdownMenu supplies the full keyboard model: arrow keys, typeahead,
 * Escape, and focus returning to the trigger on close.
 */
export const DropdownMenu = forwardRef<HTMLDivElement, DropdownMenuProps>(function DropdownMenu(
  {
    trigger,
    items,
    side = 'bottom',
    align = 'start',
    sideOffset = 6,
    open,
    defaultOpen,
    onOpenChange,
    className,
    emptyMessage = 'Nothing here yet',
  },
  ref,
) {
  return (
    <RadixMenu.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          ref={ref}
          className={cx('rq-menu', 'rq-overlay-anim', className)}
          side={side}
          align={align}
          sideOffset={sideOffset}
        >
          {items.length === 0 ? (
            <div className="rq-menu__label">{emptyMessage}</div>
          ) : (
            items.map((item) => {
              if (item.kind === 'separator') {
                return <RadixMenu.Separator key={item.id} className="rq-menu__separator" />;
              }
              if (item.kind === 'label') {
                return (
                  <RadixMenu.Label key={item.id} className="rq-menu__label">
                    {item.label}
                  </RadixMenu.Label>
                );
              }
              if (item.kind === 'checkbox') {
                return (
                  <RadixMenu.CheckboxItem
                    key={item.id}
                    className="rq-menu__item"
                    checked={item.checked}
                    onCheckedChange={item.onCheckedChange}
                    disabled={item.disabled}
                  >
                    {item.label}
                    <RadixMenu.ItemIndicator className="rq-menu__indicator">
                      <CheckIcon size={14} />
                    </RadixMenu.ItemIndicator>
                  </RadixMenu.CheckboxItem>
                );
              }
              if (item.kind === 'radio') {
                return (
                  <RadixMenu.RadioGroup
                    key={item.id}
                    value={item.value}
                    onValueChange={item.onValueChange}
                  >
                    {item.options.map((option) => (
                      <RadixMenu.RadioItem
                        key={option.value}
                        className="rq-menu__item"
                        value={option.value}
                        disabled={option.disabled}
                      >
                        {option.label}
                        <RadixMenu.ItemIndicator className="rq-menu__indicator">
                          <CircleIcon size={8} />
                        </RadixMenu.ItemIndicator>
                      </RadixMenu.RadioItem>
                    ))}
                  </RadixMenu.RadioGroup>
                );
              }
              return (
                <RadixMenu.Item
                  key={item.id}
                  className="rq-menu__item"
                  data-variant={item.variant}
                  disabled={item.disabled}
                  onSelect={item.onSelect}
                >
                  {item.icon}
                  {item.label}
                  {item.shortcut === undefined ? null : (
                    <span className="rq-menu__shortcut">{item.shortcut}</span>
                  )}
                </RadixMenu.Item>
              );
            })
          )}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
});
