/**
 * @redquant/design
 *
 * The RedQuant design system. Import the stylesheet once in the consuming app:
 *
 * ```css
 * @import "@redquant/design/styles.css";
 * @source "../../packages/design/src";
 * ```
 */

/* -- Foundations ---------------------------------------------------------- */
export * from './color.js';
export * from './tokens.js';
export * from './motion.js';
export * from './fonts.js';
export * from './utils.js';
export {
  ThemeProvider,
  useTheme,
  themeScript,
  THEME_STORAGE_KEY,
  type ThemePreference,
  type ResolvedTheme,
  type ThemeContextValue,
  type ThemeProviderProps,
} from './theme.js';

/* -- Icons ---------------------------------------------------------------- */
export {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleIcon,
  CloseIcon,
  CopyIcon,
  InfoIcon,
  MinusIcon,
  type IconProps,
} from './icons.js';

/* -- Primitives ----------------------------------------------------------- */
export { Avatar, type AvatarProps } from './primitives/Avatar.js';
export { Badge, type BadgeProps, type BadgeTone } from './primitives/Badge.js';
export {
  Breadcrumb,
  type BreadcrumbItem,
  type BreadcrumbProps,
} from './primitives/Breadcrumb.js';
export {
  Button,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from './primitives/Button.js';
export { Callout, type CalloutProps, type CalloutTone } from './primitives/Callout.js';
export { Card, type CardProps } from './primitives/Card.js';
export {
  Checkbox,
  type CheckboxProps,
  type CheckedState,
} from './primitives/Checkbox.js';
export { CodeBlock, type CodeBlockProps } from './primitives/CodeBlock.js';
export { Dialog, DialogClose, type DialogProps, type DialogSize } from './primitives/Dialog.js';
export {
  DropdownMenu,
  type DropdownMenuProps,
  type MenuAction,
  type MenuCheckbox,
  type MenuItem,
  type MenuLabel,
  type MenuRadioGroup,
  type MenuSeparator,
} from './primitives/DropdownMenu.js';
export { EmptyState, type EmptyStateProps } from './primitives/EmptyState.js';
export {
  FieldShell,
  useFieldIds,
  type FieldIds,
  type FieldParts,
  type FieldShellProps,
} from './primitives/field.js';
export {
  IconButton,
  type IconButtonProps,
  type IconButtonSize,
  type IconButtonVariant,
} from './primitives/IconButton.js';
export { Input, type InputProps, type InputSize } from './primitives/Input.js';
export { KBD, type KBDProps } from './primitives/KBD.js';
export { Marginalia, type MarginaliaProps } from './primitives/Marginalia.js';
export { Meter, type MeterProps, type MeterTone } from './primitives/Meter.js';
export {
  NumericValue,
  type NumericFormat,
  type NumericTone,
  type NumericValueProps,
} from './primitives/NumericValue.js';
export { Panel, type PanelProps } from './primitives/Panel.js';
export { Popover, PopoverClose, type PopoverProps } from './primitives/Popover.js';
export { Progress, type ProgressProps } from './primitives/Progress.js';
export {
  Radio,
  RadioGroup,
  type RadioGroupProps,
  type RadioOption,
  type RadioProps,
} from './primitives/Radio.js';
export {
  Select,
  type SelectOption,
  type SelectProps,
} from './primitives/Select.js';
export { Separator, type SeparatorProps } from './primitives/Separator.js';
export { Sheet, SheetClose, type SheetProps, type SheetSide } from './primitives/Sheet.js';
export { Skeleton, type SkeletonProps } from './primitives/Skeleton.js';
export { Slider, type SliderProps } from './primitives/Slider.js';
export { Spinner, type SpinnerProps } from './primitives/Spinner.js';
export { Switch, type SwitchProps } from './primitives/Switch.js';
export {
  Table,
  type SortDirection,
  type TableColumn,
  type TableProps,
} from './primitives/Table.js';
export { TabPanel, Tabs, type TabItem, type TabPanelProps, type TabsProps } from './primitives/Tabs.js';
export { Tag, type TagProps } from './primitives/Tag.js';
export { Textarea, type TextareaProps } from './primitives/Textarea.js';
export {
  Toast,
  ToastProvider,
  useToast,
  type ToastContextValue,
  type ToastOptions,
  type ToastProps,
  type ToastProviderProps,
  type ToastRecord,
  type ToastTone,
} from './primitives/Toast.js';
export {
  Tooltip,
  TooltipProvider,
  type TooltipProps,
  type TooltipProviderProps,
} from './primitives/Tooltip.js';
export {
  VerdictStrip,
  type VerdictStatus,
  type VerdictStripProps,
} from './primitives/VerdictStrip.js';

/* -- Charts --------------------------------------------------------------- */
export {
  ChartFrame,
  type ChartDataColumn,
  type ChartDataTable,
  type ChartFrameProps,
} from './charts/chartFrame.js';
export {
  AmplitudeBars,
  PhaseLegend,
  type Amplitude,
  type AmplitudeBarsProps,
  type PhaseLegendProps,
} from './charts/AmplitudeBars.js';
export {
  DensityHeatmap,
  type DensityHeatmapProps,
  type HeatmapCell,
} from './charts/DensityHeatmap.js';
export {
  ProbabilityHistogram,
  type HistogramBin,
  type ProbabilityHistogramProps,
} from './charts/ProbabilityHistogram.js';
export {
  RatingCurve,
  type RatingCurveProps,
  type RatingPoint,
} from './charts/RatingCurve.js';
export { Sparkline, type SparklineProps } from './charts/Sparkline.js';
