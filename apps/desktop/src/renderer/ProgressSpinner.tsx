import { LoaderCircle } from "lucide-react";
import { type ComponentProps, type SVGProps } from "react";

type ProgressSpinnerProps = Omit<ComponentProps<typeof LoaderCircle>, "ref">;
type WindowLoadingMarkProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

// desktop.css draws every lucide stroke with `vector-effect: non-scaling-stroke`,
// so stroke-width is already CSS pixels at any size. ONE value therefore holds
// the same optical line from the 14px tab spinner to the 24px pane loader — the
// old size-relative formula existed only to undo lucide's 24-grid scaling.
const SPINNER_STROKE_WIDTH = 1;

export function ProgressSpinner({
  className,
  size,
  strokeWidth,
  style,
  ...props
}: ProgressSpinnerProps) {
  const opticalStrokeWidth = strokeWidth ?? SPINNER_STROKE_WIDTH;
  return <LoaderCircle
    {...props}
    size={size}
    strokeWidth={opticalStrokeWidth}
    className={["progress-spinner", "spin", className].filter(Boolean).join(" ")}
    style={{ willChange: "transform", strokeWidth: opticalStrokeWidth, ...style }}
  />;
}

// The brand loading mark belongs only to the full-window cold-boot cover.
// The knot stays fixed while its three arms carry a quiet light sweep.
export function WindowLoadingMark({
  className,
  size = 24,
  style,
  ...props
}: WindowLoadingMarkProps) {
  return <svg
    {...props}
    viewBox="44 44 168 168"
    width={size}
    height={size}
    fill="none"
    className={["window-loading-mark", className].filter(Boolean).join(" ")}
    style={{ color: "var(--mx-text-soft)", ...style }}
  >
    <g stroke="currentColor" strokeWidth={24} strokeLinecap="round">
      <path className="window-loading-mark-arc window-loading-mark-arc-1"
        d="M116.2 61A68 68 0 0 1 191.9 104.7" />
      <path className="window-loading-mark-arc window-loading-mark-arc-2"
        d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" />
      <path className="window-loading-mark-arc window-loading-mark-arc-3"
        d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" />
    </g>
    <polygon
      className="window-loading-mark-core"
      points="128,108 134.5,121.5 148,128 134.5,134.5 128,148 121.5,134.5 108,128 121.5,121.5"
      fill="currentColor" />
  </svg>;
}
