import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils.js';

export interface BreadcrumbItem {
  label: ReactNode;
  href?: string;
  onClick?: () => void;
}

export interface BreadcrumbProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  items: readonly BreadcrumbItem[];
  /** Defaults to a forward slash. Never a chevron glyph in a text run. */
  separator?: ReactNode;
  label?: string;
}

/** The last item is the current page and is not a link. */
export const Breadcrumb = forwardRef<HTMLElement, BreadcrumbProps>(function Breadcrumb(
  { items, separator = '/', label = 'Breadcrumb', className, ...props },
  ref,
) {
  return (
    <nav ref={ref} className={cx('rq-breadcrumb', className)} aria-label={label} {...props}>
      <ol className="rq-breadcrumb__list">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li className="rq-breadcrumb__item" key={`${index}-${String(item.href ?? '')}`}>
              {isLast ? (
                <span className="rq-breadcrumb__current" aria-current="page">
                  {item.label}
                </span>
              ) : (
                <>
                  <a
                    className={cx('rq-breadcrumb__link', 'rq-focusable')}
                    href={item.href}
                    onClick={
                      item.onClick === undefined
                        ? undefined
                        : (event) => {
                            if (item.href === undefined) event.preventDefault();
                            item.onClick?.();
                          }
                    }
                  >
                    {item.label}
                  </a>
                  <span className="rq-breadcrumb__separator" aria-hidden="true">
                    {separator}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
});
