// This device's view of a remote picture (a streamed page, or a whole PC
// screen): pure math on the picture's size, the stage that shows it and the
// stage's insets. Nothing here touches the DOM; callers measure, then render
// `translate(x, y) scale(scale)` with the picture's top-left as the origin.
//
// Units: `picture` is in picture units (page CSS px, or host pixels), `stage`
// and every offset in stage (CSS) px, and `scale` is stage px per picture
// unit. A view's (x, y) is where the picture's top-left corner sits on the
// stage.
//
// The rules:
// - The first view fills one axis (the larger of the two fit ratios), so a
//   landscape PC on a portrait phone fills the height and pans sideways.
// - The smallest scale shows the whole picture (contain); no zoom goes below.
// - The largest is REMOTE_VIEW_MAX_SCALE stage px per picture unit (or the
//   fill scale, if that is larger).
// - Offsets keep the scaled picture covering the visible area; an axis on
//   which the picture is smaller than the stage is pinned to the centre.
// - Insets (soft keyboard, safe areas) never change the scale: they shrink
//   the visible area, the picture may be panned far enough to bring what lies
//   under them into view (overpan), and once they go `relaxView` returns the
//   view back inside the stage's own bounds.

export type ViewPoint = { x: number; y: number };
export type ViewSize = { width: number; height: number };
export type ViewInsets = { top: number; right: number; bottom: number; left: number };

export interface RemoteViewLayout {
  /** The picture, in picture units. */
  picture: ViewSize;
  /** The stage's full (inset-free) size, in stage px. */
  stage: ViewSize;
  /** Stage px covered by system UI along each edge (the soft keyboard is a
   *  bottom inset); omitted edges are 0. */
  insets?: Partial<ViewInsets>;
}

export interface RemoteView {
  /** Stage px per picture unit. */
  scale: number;
  /** The picture's top-left corner on the stage. */
  x: number;
  y: number;
}

/** Deepest zoom: stage px per picture unit. Four keeps a 1-px window border
 *  or a 9-px caption of a PC at 100% display scale ~4 and ~36 CSS px wide on
 *  the phone, yet two pinches back out. */
export const REMOTE_VIEW_MAX_SCALE = 4;
/** The ease back inside the bounds once an inset goes: a 250 ms decelerating
 *  return, the duration an established remote-desktop client uses to give
 *  back its overpan when system UI closes. */
export const OVERPAN_RETURN_MS = 250;

/** Remaining share of a decelerating ease at progress `t` (0…1): Android's
 *  DecelerateInterpolator at its default factor, 1 − (1 − t)², inverted. */
const decelerateRemaining = (t: number): number => (1 - t) * (1 - t);

const insetsOf = (layout: RemoteViewLayout): ViewInsets => ({
  top: Math.max(0, layout.insets?.top ?? 0),
  right: Math.max(0, layout.insets?.right ?? 0),
  bottom: Math.max(0, layout.insets?.bottom ?? 0),
  left: Math.max(0, layout.insets?.left ?? 0),
});

/** Both sizes are known and non-empty. */
export function viewReady(layout: RemoteViewLayout | null | undefined): layout is RemoteViewLayout {
  return Boolean(
    layout &&
      layout.picture.width > 0 &&
      layout.picture.height > 0 &&
      layout.stage.width > 0 &&
      layout.stage.height > 0
  );
}

/** The scale that fills the stage on one axis and overflows the other. */
export function fillScale(layout: RemoteViewLayout): number {
  return Math.max(layout.stage.width / layout.picture.width, layout.stage.height / layout.picture.height);
}

/** The scale that shows the whole picture: the minimum. */
export function containScale(layout: RemoteViewLayout): number {
  return Math.min(layout.stage.width / layout.picture.width, layout.stage.height / layout.picture.height);
}

/** The maximum scale; `maxScale` overrides REMOTE_VIEW_MAX_SCALE. */
export function maxViewScale(layout: RemoteViewLayout, maxScale = REMOTE_VIEW_MAX_SCALE): number {
  return Math.max(maxScale, fillScale(layout));
}

/** `scale` within [contain, max]. */
export function clampViewScale(layout: RemoteViewLayout, scale: number, maxScale?: number): number {
  return Math.min(maxViewScale(layout, maxScale), Math.max(containScale(layout), scale));
}

/** Offsets one axis allows: the picture covers [start, end] (a span of the
 *  stage) or, smaller than it, is centred on it. */
function axisRange(start: number, end: number, size: number): [number, number] {
  const span = end - start;
  if (size <= span) {
    const centred = start + (span - size) / 2;
    return [centred, centred];
  }
  return [end - size, start];
}

/** Per axis, the offsets a view at `scale` may take: those of the full stage,
 *  widened by those of the area the insets leave visible (overpan). */
export function viewBounds(
  layout: RemoteViewLayout,
  scale: number
): { x: [number, number]; y: [number, number] } {
  const insets = insetsOf(layout);
  const width = layout.picture.width * scale;
  const height = layout.picture.height * scale;
  const union = (a: [number, number], b: [number, number]): [number, number] => [
    Math.min(a[0], b[0]),
    Math.max(a[1], b[1]),
  ];
  return {
    x: union(
      axisRange(0, layout.stage.width, width),
      axisRange(insets.left, layout.stage.width - insets.right, width)
    ),
    y: union(
      axisRange(0, layout.stage.height, height),
      axisRange(insets.top, layout.stage.height - insets.bottom, height)
    ),
  };
}

const clampTo = (value: number, [low, high]: [number, number]): number => Math.min(high, Math.max(low, value));

/** `view` with its scale and offsets inside the bounds. */
export function clampView(view: RemoteView, layout: RemoteViewLayout, maxScale?: number): RemoteView {
  const scale = clampViewScale(layout, view.scale, maxScale);
  const bounds = viewBounds(layout, scale);
  return { scale, x: clampTo(view.x, bounds.x), y: clampTo(view.y, bounds.y) };
}

/** The first view: filled on one axis, from the picture's top-left corner. */
export function initialView(layout: RemoteViewLayout, maxScale?: number): RemoteView {
  return clampView({ scale: fillScale(layout), x: 0, y: 0 }, layout, maxScale);
}

/** Move the picture by a stage-px delta. */
export function panView(view: RemoteView, layout: RemoteViewLayout, dx: number, dy: number, maxScale?: number): RemoteView {
  return clampView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, layout, maxScale);
}

/** Zoom by `factor` keeping the picture point under stage point `pivot`
 *  there, then move by `shift` (the fingers' own travel). */
export function zoomView(
  view: RemoteView,
  layout: RemoteViewLayout,
  factor: number,
  pivot: ViewPoint,
  shift: ViewPoint = { x: 0, y: 0 },
  maxScale?: number
): RemoteView {
  const scale = clampViewScale(layout, view.scale * factor, maxScale);
  const ratio = scale / view.scale;
  return clampView(
    {
      scale,
      x: pivot.x - (pivot.x - view.x) * ratio + shift.x,
      y: pivot.y - (pivot.y - view.y) * ratio + shift.y,
    },
    layout,
    maxScale
  );
}

/** The centre of the area the insets leave visible, in stage px. */
export function visibleCenter(layout: RemoteViewLayout): ViewPoint {
  const insets = insetsOf(layout);
  return {
    x: (insets.left + layout.stage.width - insets.right) / 2,
    y: (insets.top + layout.stage.height - insets.bottom) / 2,
  };
}

/** Stage point → picture point (unbounded; see `pictureContains`). */
export function stageToPicture(view: RemoteView, point: ViewPoint): ViewPoint {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

/** Picture point → stage point. */
export function pictureToStage(view: RemoteView, point: ViewPoint): ViewPoint {
  return { x: view.x + point.x * view.scale, y: view.y + point.y * view.scale };
}

/** Whether a picture point lies on the picture. */
export function pictureContains(layout: RemoteViewLayout, point: ViewPoint): boolean {
  return point.x >= 0 && point.y >= 0 && point.x < layout.picture.width && point.y < layout.picture.height;
}

/** A picture point moved onto the picture (the trackpad cursor's bounds). */
export function clampToPicture(layout: RemoteViewLayout, point: ViewPoint): ViewPoint {
  return {
    x: Math.min(layout.picture.width, Math.max(0, point.x)),
    y: Math.min(layout.picture.height, Math.max(0, point.y)),
  };
}

/** The view moved so picture point `point` sits at the visible centre, as
 *  far as the bounds allow (the viewport following a trackpad cursor). */
export function followPoint(view: RemoteView, layout: RemoteViewLayout, point: ViewPoint, maxScale?: number): RemoteView {
  const center = visibleCenter(layout);
  return clampView(
    { scale: view.scale, x: center.x - point.x * view.scale, y: center.y - point.y * view.scale },
    layout,
    maxScale
  );
}

/** `view` re-expressed for a picture of the same aspect at another size (a
 *  JPEG frame replaced by the video), so nothing moves on screen. */
export function rescaleView(view: RemoteView, from: ViewSize, to: ViewSize): RemoteView {
  return { ...view, scale: (view.scale * from.width) / to.width };
}

/** Whether two pictures have the same shape (within half a percent). */
export function sameAspect(a: ViewSize, b: ViewSize): boolean {
  return Math.abs(a.width / a.height - b.width / b.height) <= (0.005 * a.width) / a.height;
}

/** An ease back inside the bounds: the view it started from and the time
 *  since it started. */
export interface ViewReturn {
  from: RemoteView;
  elapsedMs: number;
}

/**
 * The view `elapsedMs` into the ease back inside the bounds (an inset went
 * away and left `from` overpanned): it travels to the clamped view over
 * OVERPAN_RETURN_MS, decelerating. `settled` at the end (or when `from` was
 * already inside), with the clamped view exactly. Call it every frame with the
 * same `from` and the time since the ease began.
 */
export function relaxView(
  ease: ViewReturn,
  layout: RemoteViewLayout,
  maxScale?: number
): { view: RemoteView; settled: boolean } {
  const { from } = ease;
  const target = clampView(from, layout, maxScale);
  const progress = Math.max(0, ease.elapsedMs) / OVERPAN_RETURN_MS;
  if (progress >= 1 || (target.x === from.x && target.y === from.y)) return { view: target, settled: true };
  const remaining = decelerateRemaining(progress);
  return {
    view: { scale: target.scale, x: target.x + (from.x - target.x) * remaining, y: target.y + (from.y - target.y) * remaining },
    settled: false,
  };
}

export function sameView(a: RemoteView | null, b: RemoteView | null): boolean {
  return a === b || (a !== null && b !== null && a.scale === b.scale && a.x === b.x && a.y === b.y);
}

/** A measured stage, kept apart from the keyboard covering it. */
export interface StageTrack {
  /** The stage's full size: the layout the view fits to. */
  width: number;
  height: number;
  /** How much of its bottom the soft keyboard takes now. */
  bottom: number;
}

/**
 * Next stage track from a measurement. While the soft keyboard is up (see
 * `keyboardEvidence`), a shorter stage of the same width is the same stage
 * with a bottom inset, so the view keeps its scale and position. Without that
 * evidence there is no inset, and any change of size is a new layout, which
 * the view fits again.
 */
export function trackStage(
  prev: StageTrack | null,
  measured: ViewSize,
  keyboardOpen: boolean,
  overlay = 0
): StageTrack {
  const { width, height } = measured;
  const covered = Math.max(0, Math.min(height, overlay));
  if (!keyboardOpen) return { width, height, bottom: 0 };
  if (!prev || width !== prev.width || height >= prev.height) return { width, height, bottom: covered };
  return { width, height: prev.height, bottom: prev.height - height + covered };
}

/**
 * Whether a soft keyboard covers the screen, from evidence only:
 * - the platform reports it: `overlay`, the stage px the VirtualKeyboard
 *   API's `boundingRect` (its intersection with the page's viewport) covers;
 * - a field has focus and the visual viewport is below its height without a
 *   keyboard, by any amount; or
 * - the keyboard is sliding away after its field lost focus (`closing`, see
 *   `keyboardClosing`) and the visual viewport is still below that height.
 *
 * Where the page is resized for the keyboard (the Android app's WebView takes
 * the IME inset as a margin, `interactive-widget=resizes-content` in a
 * browser), the keyboard does not intersect the viewport and `overlay` stays
 * 0; the visual viewport says it instead. No size floor is needed to tell it
 * from browser chrome: the app's own hosts (the Android app's WebView, an
 * installed web app) have no URL bar, and in a browser tab the phone layout
 * never scrolls its document (`mobile-web-runtime.css` pins the root) while a
 * mobile browser retracts its URL bar only for a scroll of the root scroller
 * (Chrome for Developers, "URL bar resizing"). So with a field focused, the
 * visual viewport shrinking is the keyboard. `baseline` is the height without
 * one, the caller's memory: it follows the visual viewport whenever no field
 * is focused or closing (so a rotation or a split screen resize is the
 * layout's own), at any new width, and whenever the viewport grows past it.
 * The updated value comes back.
 */
export function keyboardEvidence(
  baseline: ViewSize | null,
  state: { visual: ViewSize; focused: boolean; closing: boolean; overlay?: number }
): { open: boolean; baseline: ViewSize } {
  const { visual, focused, closing } = state;
  const next =
    !baseline || (!focused && !closing) || baseline.width !== visual.width || visual.height > baseline.height
      ? { width: visual.width, height: visual.height }
      : baseline;
  const shrunk = visual.height < next.height;
  return { open: (state.overlay ?? 0) > 0 || ((focused || closing) && shrunk), baseline: next };
}

/** A keyboard sliding away after its field lost focus: the visual viewport
 *  height its last resize reported. */
export type KeyboardClosing = { height: number };

/**
 * The closing keyboard, advanced by one visual viewport resize event. It is
 * still sliding away while each resize grows the viewport and leaves it below
 * `baseline` (its height without a keyboard); the resize that reaches the
 * baseline, or one that does not grow it, ends the closing (null). Start one
 * at blur with `{ height }` of the viewport then, only if a keyboard was up.
 */
export function keyboardClosing(
  closing: KeyboardClosing | null,
  visual: ViewSize,
  baseline: ViewSize | null
): KeyboardClosing | null {
  if (!closing || !baseline || visual.width !== baseline.width) return null;
  if (visual.height >= baseline.height || visual.height <= closing.height) return null;
  return { height: visual.height };
}
