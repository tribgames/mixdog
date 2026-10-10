// Range/step arithmetic shared by every ZoomPill. The browser range is the
// browser-zoom-level constants, so the browser panes behave exactly as before.
import { BROWSER_ZOOM_MAX, BROWSER_ZOOM_MIN, BROWSER_ZOOM_STEP } from './browser-zoom-level';

export interface ZoomRange {
  min: number;
  max: number;
  step: number;
}

export const BROWSER_ZOOM_RANGE: ZoomRange = { min: BROWSER_ZOOM_MIN, max: BROWSER_ZOOM_MAX, step: BROWSER_ZOOM_STEP };
// Editor previews (image, SVG, PDF, Office): a user-picked scale is 25%–400%
// in 25% steps. Without a pick the preview fits its panel (see fitWidthScale).
export const PREVIEW_ZOOM_RANGE: ZoomRange = { min: 0.25, max: 4, step: 0.25 };
export const PREVIEW_ZOOM_PRESETS: readonly number[] = [0.5, 1, 1.5, 2];
// Browser pane presets, next to its "100%" reset.
export const BROWSER_ZOOM_PRESETS: readonly number[] = [0.5, 0.75, 1.25, 1.5, 2];

export type ZoomMode = 'fit' | 'fixed';

/** Scale that shrinks content wider than the viewport to the viewport width
 *  minus `inset`; smaller content stays at 100% (never upscaled). */
export function fitWidthScale(viewportWidth: number, intrinsicWidth: number | undefined, inset = 0): number {
  if (!intrinsicWidth || intrinsicWidth <= 0 || !(viewportWidth > 0)) return 1;
  return Math.min(1, Math.max(1, viewportWidth - inset) / intrinsicWidth);
}

/** Image fit ("contain"): the largest scale at which the whole image shows in
 *  the viewport, never above 100%. */
export function fitContainScale(
  viewportWidth: number,
  viewportHeight: number,
  intrinsicWidth: number | undefined,
  intrinsicHeight: number | undefined
): number {
  if (!intrinsicWidth || !intrinsicHeight || intrinsicWidth <= 0 || intrinsicHeight <= 0) return 1;
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) return 1;
  return Math.min(1, viewportWidth / intrinsicWidth, viewportHeight / intrinsicHeight);
}

/** Pixel size of `intrinsic` at `scale`, floored (with a float-error margin)
 *  so a fitted size never overflows its panel by a rounding pixel. */
export function scaledSize(intrinsic: number, scale: number): number {
  return Math.floor(intrinsic * scale + 1e-6);
}

/** Wheel delta normalised to pixels and clamped to ±40. */
export function normalizedWheelDelta(deltaY: number, deltaMode: number, pageSize: number): number {
  let unit = 1;
  if (deltaMode === 1) unit = 16;
  else if (deltaMode === 2) unit = pageSize;
  return Math.max(-40, Math.min(40, deltaY * unit));
}

/** Smooth exponential Ctrl+wheel step. */
export function wheelZoomScale(scale: number, deltaY: number, deltaMode: number, pageSize: number): number {
  return scale * Math.exp(-normalizedWheelDelta(deltaY, deltaMode, pageSize) * 0.01);
}

/** Scroll offset that keeps the content point under `pointer` (an offset in
 *  the viewport) fixed when the content scales by `ratio`. `origin` is where
 *  the content starts inside the scrollable extent before the change, and
 *  `nextOrigin` where it starts after. */
export function anchoredScroll(
  scroll: number,
  pointer: number,
  ratio: number,
  origin = 0,
  nextOrigin = origin
): number {
  return (scroll + pointer - origin) * ratio + nextOrigin - pointer;
}

/** Next stop on a `range.step` grid: steps snap, so 60% goes to 50% / 75%. */
export function stepSnapped(scale: number, direction: 1 | -1, range: ZoomRange): number {
  const cells = Math.round((scale / range.step) * 1e6) / 1e6;
  const next = direction === -1 ? Math.ceil(cells) - 1 : Math.floor(cells) + 1;
  return clampZoom(next * range.step, range);
}

export type ClickZoomTarget = { mode: 'fit' } | { mode: 'fixed'; scale: number };

/** Image click: from fit go to 100% (200% when 100% already is fit), from any
 *  other scale go back to fit. */
export function clickZoomTarget(fitLike: boolean, fit: number): ClickZoomTarget {
  if (!fitLike) return { mode: 'fit' };
  return { mode: 'fixed', scale: fit < 0.995 ? 1 : 2 };
}

export function clampZoom(value: unknown, range: ZoomRange): number {
  const level = Number(value);
  if (!Number.isFinite(level)) return 1;
  return Math.round(Math.min(range.max, Math.max(range.min, level)) * 100) / 100;
}

export function stepZoom(level: number, direction: 1 | -1, range: ZoomRange): number {
  return clampZoom(level + range.step * direction, range);
}
