// One place decides which zoom host a keyboard zoom (Ctrl/Cmd + = / − / 0)
// belongs to. Every zoom host (an editor preview, the Visualize panel)
// registers a target; the single document listener below hands the key to
// exactly ONE of them - the target holding focus first, the hovered one only
// as a fallback - and skips a key someone else already handled. Without this
// every host listened on its own and a focus in one pane with the pointer over
// another zoomed both.
//
// Gestures a frame swallowed arrive here too (`dispatchZoomAt` for ones that
// know where they happened, `dispatchZoomKey` for keys).

export type ZoomKey = 'in' | 'out' | 'reset';
export interface ZoomPoint {
  x: number;
  y: number;
}
/** Wheel motion behind a zoom, when the sender has it (else a plain step). */
export interface ZoomWheel {
  deltaY: number;
  deltaMode: number;
}

export interface ZoomTarget {
  element: HTMLElement;
  /** A target that cannot zoom right now (content not loaded) is skipped. */
  enabled(): boolean;
  /** The pointer is over the target. */
  hovered(): boolean;
  /** `point` (window CSS px) anchors a pointer gesture; `wheel` carries its delta. */
  command(input: ZoomKey, point?: ZoomPoint, wheel?: ZoomWheel): void;
}

const targets = new Set<ZoomTarget>();

export function zoomKeyInput(key: string): ZoomKey | null {
  if (key === '=' || key === '+') return 'in';
  if (key === '-' || key === '_') return 'out';
  if (key === '0') return 'reset';
  return null;
}

const enabledTargets = () => [...targets].filter((target) => target.enabled());

/** The target a keyboard zoom belongs to: focus decides, hover is the fallback. */
export function keyZoomTarget(): ZoomTarget | null {
  const live = enabledTargets();
  const active = document.activeElement;
  return live.find((target) => target.element.contains(active)) ?? live.find((target) => target.hovered()) ?? null;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey)) return;
  const input = zoomKeyInput(event.key);
  if (!input) return;
  const target = keyZoomTarget();
  if (!target) return;
  event.preventDefault();
  target.command(input);
}

export function registerZoomTarget(target: ZoomTarget): () => void {
  if (targets.size === 0) document.addEventListener('keydown', onKeyDown);
  targets.add(target);
  return () => {
    targets.delete(target);
    if (targets.size === 0) document.removeEventListener('keydown', onKeyDown);
  };
}

/** A key a frame took that main forwarded: the focused target's. */
export function dispatchZoomKey(input: ZoomKey): void {
  keyZoomTarget()?.command(input);
}

/** A gesture made inside a frame at `point`: the target that frame is in. */
export function dispatchZoomAt(input: ZoomKey, point: ZoomPoint, wheel?: ZoomWheel): void {
  const hit = document.elementFromPoint(point.x, point.y);
  enabledTargets()
    .find((target) => target.element.contains(hit))
    ?.command(input, point, wheel);
}
