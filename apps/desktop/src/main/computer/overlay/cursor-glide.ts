export interface GlidePoint {
  x: number;
  y: number;
}

export interface GlideArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GlidePlan {
  from: GlidePoint;
  to: GlidePoint;
  durationMs: number;
}

/** A cursor that has never been shown starts a short distance up-left of its first target. */
export const GLIDE_SEED_OFFSET = 140;
export const GLIDE_MIN_MS = 140;
/** The native worker waits this long after announcing a target before it acts. */
export const GLIDE_MAX_MS = 360;
export const GLIDE_SPEED_PX_PER_S = 1400;
const GLIDE_MIN_DISTANCE = 4;
const AREA_MARGIN = 2;
const COLLAPSED_SEED = 8;

const GLIDE_EFFECTS = new Set(['prepare', 'click', 'press', 'type', 'scroll']);

/** Only a virtual pointer travels; a foreground halo decorates the OS pointer where it already is. */
export function glideAllowed(cursor: { mode: string; effect?: string; tracking?: boolean }): boolean {
  return cursor.mode === 'background' && GLIDE_EFFECTS.has(String(cursor.effect || ''));
}

export function seedGlideStart(target: GlidePoint, area: GlideArea): GlidePoint {
  let x = target.x - GLIDE_SEED_OFFSET;
  let y = target.y - GLIDE_SEED_OFFSET;
  if (area.width > 0 && area.height > 0) {
    const minX = area.x + AREA_MARGIN;
    const minY = area.y + AREA_MARGIN;
    const maxX = area.x + area.width - AREA_MARGIN;
    const maxY = area.y + area.height - AREA_MARGIN;
    x = Math.min(Math.max(x, minX), maxX);
    y = Math.min(Math.max(y, minY), maxY);
    if (Math.abs(x - target.x) < COLLAPSED_SEED && Math.abs(y - target.y) < COLLAPSED_SEED) {
      x = Math.min(target.x + GLIDE_SEED_OFFSET, maxX);
      y = Math.min(target.y + GLIDE_SEED_OFFSET, maxY);
    }
  }
  return { x: Math.round(x), y: Math.round(y) };
}

export function planGlide(from: GlidePoint | undefined, to: GlidePoint, area: GlideArea): GlidePlan | null {
  const start = from ?? seedGlideStart(to, area);
  const distance = Math.hypot(to.x - start.x, to.y - start.y);
  if (!Number.isFinite(distance) || distance < GLIDE_MIN_DISTANCE) return null;
  const durationMs = Math.min(
    GLIDE_MAX_MS,
    Math.max(GLIDE_MIN_MS, Math.round((distance / GLIDE_SPEED_PX_PER_S) * 1000))
  );
  return { from: { x: start.x, y: start.y }, to: { x: to.x, y: to.y }, durationMs };
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function glidePosition(plan: GlidePlan, elapsedMs: number): GlidePoint {
  const progress = plan.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, elapsedMs / plan.durationMs));
  const eased = easeInOutCubic(progress);
  return {
    x: Math.round(plan.from.x + (plan.to.x - plan.from.x) * eased),
    y: Math.round(plan.from.y + (plan.to.y - plan.from.y) * eased),
  };
}

export function glideFinished(plan: GlidePlan, elapsedMs: number): boolean {
  return elapsedMs >= plan.durationMs;
}
