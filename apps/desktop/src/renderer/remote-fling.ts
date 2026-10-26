// Momentum after a finger leaves the glass: linear drag, so the speed decays
// exponentially, v(t) = v0·e^(−t/T), and the distance covered approaches
// T·v0. Pure math; the gesture layer runs it on animation frames.

/** Time constant of a one-finger (viewport or cursor) fling. */
export const FLING_PAN_TIME_CONSTANT_MS = 180;
/** Time constant of a two-finger (wheel) fling: scrolling coasts longer. */
export const FLING_SCROLL_TIME_CONSTANT_MS = 250;
/** Below this speed (px/ms) the fling is over. */
export const FLING_STOP_SPEED = 0.01;
/** A fling that would travel less than this is no fling: a slow lift-off
 *  must not drift. */
export const FLING_MIN_DISTANCE_PX = 20;
/** Velocity is read from the motion of this last stretch before lift-off. */
export const FLING_SAMPLE_MS = 80;

export type FlingSample = { t: number; x: number; y: number };

export interface Fling {
  /** Unit direction. */
  dx: number;
  dy: number;
  /** Initial speed, px/ms. */
  speed: number;
  timeConstant: number;
  /** When the speed falls below FLING_STOP_SPEED, ms. */
  duration: number;
}

/** Velocity (px/ms) at `at` from the samples of the last FLING_SAMPLE_MS;
 *  zero when the finger had stopped or too little was recorded. */
export function flingVelocity(samples: readonly FlingSample[], at: number): { x: number; y: number } {
  const recent = samples.filter((sample) => at - sample.t <= FLING_SAMPLE_MS && sample.t <= at);
  if (recent.length < 2) return { x: 0, y: 0 };
  const first = recent[0];
  const last = recent[recent.length - 1];
  const span = last.t - first.t;
  if (!(span > 0)) return { x: 0, y: 0 };
  return { x: (last.x - first.x) / span, y: (last.y - first.y) / span };
}

/** A fling for a lift-off velocity (px/ms), or null when it would barely move. */
export function startFling(velocity: { x: number; y: number }, timeConstant: number): Fling | null {
  const speed = Math.hypot(velocity.x, velocity.y);
  if (!(speed > FLING_STOP_SPEED)) return null;
  if (timeConstant * (speed - FLING_STOP_SPEED) < FLING_MIN_DISTANCE_PX) return null;
  return {
    dx: velocity.x / speed,
    dy: velocity.y / speed,
    speed,
    timeConstant,
    duration: timeConstant * Math.log(speed / FLING_STOP_SPEED),
  };
}

/** Distance covered `elapsed` ms into the fling (capped at its end). */
export function flingTravel(fling: Fling, elapsed: number): { x: number; y: number } {
  const t = Math.min(Math.max(0, elapsed), fling.duration);
  const distance = fling.timeConstant * fling.speed * -Math.expm1(-t / fling.timeConstant);
  return { x: distance * fling.dx, y: distance * fling.dy };
}
