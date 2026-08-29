/**
 * Functional UI marks.
 *
 * These are affordances, not illustration. DESIGN.md bans decorative SVG, so
 * the set stays at the glyphs a control genuinely needs, all drawn on a 16px
 * grid with `currentColor` and a 1.5px stroke.
 */

import type { SVGProps } from 'react';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  /** px. Defaults to 16. */
  size?: number;
};

function Icon({ size = 16, ...props }: IconProps & { d?: string }): React.ReactElement {
  const { d, ...rest } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {d === undefined ? null : <path d={d} />}
    </svg>
  );
}

export const CheckIcon = (p: IconProps): React.ReactElement => <Icon {...p} d="M3 8.5 6.2 12 13 4" />;
export const MinusIcon = (p: IconProps): React.ReactElement => <Icon {...p} d="M3.5 8h9" />;
export const CloseIcon = (p: IconProps): React.ReactElement => (
  <Icon {...p} d="M3.75 3.75l8.5 8.5M12.25 3.75l-8.5 8.5" />
);
export const ChevronDownIcon = (p: IconProps): React.ReactElement => (
  <Icon {...p} d="M4 6.25 8 10.25l4-4" />
);
export const ChevronUpIcon = (p: IconProps): React.ReactElement => (
  <Icon {...p} d="M4 9.75 8 5.75l4 4" />
);
export const ChevronRightIcon = (p: IconProps): React.ReactElement => (
  <Icon {...p} d="M6.25 3.5 10.25 8l-4 4.5" />
);
export const CopyIcon = (p: IconProps): React.ReactElement => (
  <svg
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...p}
  >
    <rect x="5.25" y="5.25" width="7.5" height="7.5" rx="1.5" />
    <path d="M10.5 3.25h-6a1.25 1.25 0 0 0-1.25 1.25v6" />
  </svg>
);
export const AlertIcon = (p: IconProps): React.ReactElement => (
  <svg
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...p}
  >
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 4.75v3.75M8 10.9v.1" />
  </svg>
);
export const InfoIcon = (p: IconProps): React.ReactElement => (
  <svg
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...p}
  >
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 7.25v4M8 4.9v.1" />
  </svg>
);
export const CircleIcon = (p: IconProps): React.ReactElement => (
  <svg
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    aria-hidden="true"
    focusable="false"
    {...p}
  >
    <circle cx="8" cy="8" r="5.75" />
  </svg>
);
