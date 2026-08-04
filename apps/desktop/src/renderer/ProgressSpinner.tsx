import { LoaderCircle } from "lucide-react";
import { type ComponentProps } from "react";

type ProgressSpinnerProps = Omit<ComponentProps<typeof LoaderCircle>, "ref">;

const TAB_SPINNER_SIZE = 14;
const TAB_SPINNER_STROKE_WIDTH = 1.75;

export function progressSpinnerStrokeWidth(size: unknown): number {
  const numericSize = Number(size ?? 24);
  if (!Number.isFinite(numericSize) || numericSize <= 0) return TAB_SPINNER_STROKE_WIDTH;
  return TAB_SPINNER_SIZE * TAB_SPINNER_STROKE_WIDTH / numericSize;
}

export function ProgressSpinner({
  className,
  size,
  strokeWidth,
  style,
  ...props
}: ProgressSpinnerProps) {
  // Preserve the working tab's optical line at every rendered size. A fixed
  // SVG stroke made compact indicators thinner and large loaders heavier.
  const opticalStrokeWidth = strokeWidth ?? progressSpinnerStrokeWidth(size);
  return <LoaderCircle
    {...props}
    size={size}
    strokeWidth={opticalStrokeWidth}
    className={["progress-spinner", "spin", className].filter(Boolean).join(" ")}
    style={{ willChange: "transform", strokeWidth: opticalStrokeWidth, ...style }}
  />;
}
