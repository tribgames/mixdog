// Touch on a remote picture → abstract gestures. The recognizer knows no
// page or PC: it maps client points through the caller's `toTarget` (the
// "target" space is wherever input goes: page CSS px, host pixels), moves the
// view through `pan` / `zoom`, and reports what to inject as actions the
// caller turns into browser input or `screen-pointer` calls.
//
// The gesture map (both strategies):
// - tap: 1 finger = left click, 2 = right click, 3 = middle click;
// - long-press: the left button held; moving drags; lifting releases;
// - one-finger drag: pans the view (direct) or moves the cursor (trackpad);
// - two fingers: decided once as a swipe (wheel) or a pinch (zoom);
// - lift-off with speed: the pan or the wheel coasts on (fling), never after
//   a long-press drag or a touch that began at the screen edge;
// - a second tap close to the first, soon after it, clicks the first one's
//   point again (direct), so a double-click lands on one spot;
// - a touch that begins within EDGE_SLOP_PX of the screen edge and then
//   moves past the slop is the system's back/home swipe: from then on none of
//   it reaches the PC or the view. Held still there, it taps and long-presses
//   as anywhere else.
//
// `direct` puts input under the finger. `trackpad` moves a cursor by the
// finger's travel and clicks where the cursor is; the view follows the
// cursor, and a pinch zooms about it. The cursor's position is the caller's
// (`TouchCursor`), so a PC-side cursor can feed it.
import {
  FLING_PAN_TIME_CONSTANT_MS,
  FLING_SAMPLE_MS,
  FLING_SCROLL_TIME_CONSTANT_MS,
  type FlingSample,
  flingTravel,
  flingVelocity,
  startFling,
} from './remote-fling';
import {
  clampToPicture,
  followPoint,
  panView,
  pictureContains,
  pictureToStage,
  type RemoteView,
  type RemoteViewLayout,
  stageToPicture,
  type ViewPoint,
  type ViewSize,
  viewReady,
  visibleCenter,
  zoomView,
} from './remote-viewport';

/** Travel (CSS px) past which a touch is a move, not a tap. */
export const TOUCH_SLOP_PX = 9;
export const TOUCH_LONG_PRESS_MS = 500;
/** A second tap within this time of the first… */
export const DOUBLE_TAP_TIMEOUT_MS = 300;
/** …and this close to it (CSS px) reuses its point. A quarter of the
 *  platform's double-tap slop: remote UI is small, a target a finger's width
 *  away is another target. */
export const DOUBLE_TAP_SLOP_PX = 25;
/** The band along the screen edges that belongs to system gestures (CSS px). */
export const EDGE_SLOP_PX = 12;
/** Feedback ring radius (CSS px) per strategy and action; 0: no ring. */
export const FEEDBACK_RADIUS_PX = {
  direct: { tap: 25, press: 55 },
  trackpad: { tap: 0, press: 8 },
} as const;

export type TouchStrategy = 'direct' | 'trackpad';
export type TouchButton = 'left' | 'right' | 'middle';

/** What to inject; every point is in target space. */
export type TouchGestureAction =
  /** Press and release. `count` 2: the second click of a double-click. */
  | { type: 'click'; button: TouchButton; at: ViewPoint; count: 1 | 2 }
  /** The left button goes down (long-press). */
  | { type: 'press'; at: ViewPoint }
  /** The held left button moves. */
  | { type: 'drag'; at: ViewPoint }
  /** The held left button goes up. */
  | { type: 'release'; at: ViewPoint }
  /** The trackpad cursor moved, no button held. */
  | { type: 'move'; at: ViewPoint }
  /** Whole target units; fractions carry to the next wheel. Positive deltaY scrolls down. */
  | { type: 'wheel'; at: ViewPoint; deltaX: number; deltaY: number }
  /** Show a feedback ring at a client point: input was injected there. */
  | { type: 'feedback'; x: number; y: number; radius: number };

/** The trackpad cursor, owned by the caller. */
export interface TouchCursor {
  /** Where it is, in target space. */
  position(): ViewPoint;
  /** Move it by a target-space delta; the caller keeps it on the picture and
   *  the view on it, and returns where it ended. */
  moveBy(dx: number, dy: number): ViewPoint;
  /** Its client point (pinch pivot, feedback ring); null when off screen. */
  client(): ViewPoint | null;
}

export interface TouchGestureOptions {
  /** Default 'direct'. 'trackpad' needs `cursor`. */
  strategy?: TouchStrategy;
  /** Client point → target point, or null off the picture. */
  toTarget(x: number, y: number): ViewPoint | null;
  /** Client-px delta → target delta at the current zoom. */
  toTargetDelta(dx: number, dy: number): ViewPoint;
  /** Move the view by a client-px delta (direct one-finger drag and fling). */
  pan(dx: number, dy: number): void;
  /** Zoom the view by `factor` about client point (x, y), then move it by
   *  (dx, dy). Absent: two fingers always swipe. */
  zoom?(factor: number, x: number, y: number, dx: number, dy: number): void;
  cursor?: TouchCursor;
  emit(action: TouchGestureAction): void;
  /** Called before any press or click goes out (finish IME composition). */
  beforePress?(): void;
  /** The screen's client size, for the edge band; absent: no edge band. */
  screen?(): ViewSize;
  edgeSlopPx?: number;
  longPressMs?: number;
  now?(): number;
  /** Animation frames for flings; default requestAnimationFrame. */
  requestFrame?(callback: () => void): unknown;
  cancelFrame?(handle: unknown): void;
}

export interface TouchGestures {
  down(id: number, x: number, y: number): void;
  move(id: number, x: number, y: number): void;
  up(id: number, x: number, y: number): void;
  cancel(id: number): void;
  /**
   * Every contact's client position read in one event (a TouchEvent's
   * touches). Pointer events carry one finger each, and one finger's report
   * can come frames after another's, so two-finger motion — the swipe-or-pinch
   * decision included — is read from these snapshots whenever they arrive. A
   * snapshot of another number of contacts than are down is ignored.
   */
  contacts(points: ViewPoint[]): void;
  /** Stop any fling. */
  stop(): void;
  dispose(): void;
}

type Mode = 'idle' | 'pan' | 'held' | 'two' | 'scroll' | 'pinch' | 'multi' | 'ended';
type Touch = { x: number; y: number; startX: number; startY: number; lastX: number; lastY: number };

const BUTTONS: Partial<Record<number, TouchButton>> = { 1: 'left', 2: 'right', 3: 'middle' };
/** Whole part of a carried wheel delta, immune to float error at integers. */
const whole = (value: number): number => Math.trunc(value + Math.sign(value) * 1e-9);

export function createTouchGestures(options: TouchGestureOptions): TouchGestures {
  const trackpad = options.strategy === 'trackpad' ? (options.cursor ?? null) : null;
  const radius = trackpad ? FEEDBACK_RADIUS_PX.trackpad : FEEDBACK_RADIUS_PX.direct;
  const now = options.now ?? (() => Date.now());
  const frames = typeof globalThis.requestAnimationFrame === 'function';
  const requestFrame =
    options.requestFrame ??
    ((callback: () => void): unknown =>
      frames ? globalThis.requestAnimationFrame(() => callback()) : setTimeout(callback, 16));
  const cancelFrame =
    options.cancelFrame ??
    ((handle: unknown): void => {
      if (frames) globalThis.cancelAnimationFrame(handle as number);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

  const touches = new Map<number, Touch>();
  /** One event's positions of every contact, since the set last changed. */
  let snapshot: ViewPoint[] | null = null;
  /** This two-finger gesture's touch lists arrive: it moves only by them. */
  let snapshotSeen = false;
  /** Fingers whose pointer moved since the last touch list. A touch list
   *  follows each frame's pointer moves, so once every finger has reported
   *  and one reports again with no list between, the lists stopped. */
  const movedSinceSnapshot = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let mode: Mode = 'idle';
  /** This touch sequence began in the edge band. */
  let edge = false;
  /** …and moved: an edge swipe, ignored to its end. */
  let ignored = false;
  /** Client point where the sequence's first finger went down. */
  let first: ViewPoint = { x: 0, y: 0 };
  /** Most fingers down at once in this sequence. */
  let fingers = 0;
  /** Still a tap: nothing moved past the slop, nothing was sent. */
  let tap = false;
  let suppressFling = false;
  /** Target point of the held left button. */
  let held: ViewPoint | null = null;
  let centroid: ViewPoint | null = null;
  let spread = 0;
  let lastTap: { at: number; client: ViewPoint; target: ViewPoint } | null = null;
  let samples: FlingSample[] = [];
  /** The swipe's velocity when its first finger lifted. */
  let swipeRelease: { at: number; velocity: ViewPoint } | null = null;
  let wheelAt: ViewPoint | null = null;
  let carry = { x: 0, y: 0 };
  let flingHandle: unknown = null;

  const emit = (action: TouchGestureAction): void => options.emit(action);
  const feedback = (point: ViewPoint | null, size: number): void => {
    if (point && size > 0) emit({ type: 'feedback', x: point.x, y: point.y, radius: size });
  };
  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const stop = (): void => {
    if (flingHandle !== null) cancelFrame(flingHandle);
    flingHandle = null;
  };
  const sample = (point: ViewPoint): void => {
    const t = now();
    samples.push({ t, x: point.x, y: point.y });
    while (samples.length > 2 && t - samples[0].t > FLING_SAMPLE_MS * 2) samples.shift();
  };
  const atEdge = (x: number, y: number): boolean => {
    const screen = options.screen?.();
    if (!screen) return false;
    const slop = options.edgeSlopPx ?? EDGE_SLOP_PX;
    return x < slop || y < slop || x > screen.width - slop || y > screen.height - slop;
  };

  const positions = (): ViewPoint[] => snapshot ?? [...touches.values()];
  const center = (): ViewPoint => {
    const all = positions();
    return {
      x: all.reduce((sum, touch) => sum + touch.x, 0) / all.length,
      y: all.reduce((sum, touch) => sum + touch.y, 0) / all.length,
    };
  };
  const spreadOf = (): number => {
    const [a, b] = positions();
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  /** Wheel by a client-px delta at `at`, carrying fractions. Trackpad
   *  deltas are not rescaled: the cursor is where the scroll goes. */
  const wheel = (dx: number, dy: number, at: ViewPoint | null): void => {
    if (!at) return;
    const delta = trackpad ? { x: dx, y: dy } : options.toTargetDelta(dx, dy);
    carry = { x: carry.x + delta.x, y: carry.y + delta.y };
    const deltaX = whole(carry.x);
    const deltaY = whole(carry.y);
    carry = { x: carry.x - deltaX, y: carry.y - deltaY };
    wheelAt = at;
    if (!deltaX && !deltaY) return;
    tap = false;
    emit({ type: 'wheel', at, deltaX, deltaY });
  };
  /** One-finger travel: the view (direct) or the cursor (trackpad). */
  const travel = (dx: number, dy: number): void => {
    if (!trackpad) {
      options.pan(dx, dy);
      return;
    }
    const delta = options.toTargetDelta(dx, dy);
    const at = trackpad.moveBy(delta.x, delta.y);
    if (mode === 'held') held = at;
    emit({ type: mode === 'held' ? 'drag' : 'move', at });
  };
  const releaseHeld = (): void => {
    if (held) emit({ type: 'release', at: held });
    held = null;
  };
  /** A sequence from the edge band starting to move is the system's swipe:
   *  true (and ignored from here on) instead of panning or swiping. */
  const edgeSwipe = (): boolean => {
    if (!edge) return false;
    ignored = true;
    tap = false;
    clearTimer();
    return true;
  };

  /** Two fingers decide once, from one snapshot of every finger: spreading
   *  or closing more than moving together pinches; the swipe or zoom then
   *  starts from where the fingers began, losing nothing. */
  const classify = (): void => {
    if (mode !== 'two' || !centroid) return;
    const next = center();
    const spreadChange = Math.abs(spreadOf() - spread);
    const shift = Math.hypot(next.x - centroid.x, next.y - centroid.y);
    if (Math.max(spreadChange, shift) <= TOUCH_SLOP_PX || edgeSwipe()) return;
    mode = spreadChange > shift ? 'pinch' : 'scroll';
    tap = false;
    clearTimer();
    follow();
  };
  /** Pinch or swipe by the fingers' change since the last one applied. */
  const follow = (): void => {
    if (!centroid) return;
    const next = center();
    if (mode === 'pinch') {
      const nextSpread = spreadOf();
      if (spread > 0 && nextSpread > 0) {
        if (trackpad) {
          const pivot = trackpad.client() ?? centroid;
          options.zoom?.(nextSpread / spread, pivot.x, pivot.y, 0, 0);
          trackpad.moveBy(0, 0);
        } else {
          // Anchored where the fingers were: the point under them there
          // moves with them to `next`.
          options.zoom?.(nextSpread / spread, centroid.x, centroid.y, next.x - centroid.x, next.y - centroid.y);
        }
      }
      spread = nextSpread;
    } else if (next.x !== centroid.x || next.y !== centroid.y) {
      // Without a pinch, two fingers swipe from the first motion: from the
      // edge band, motion past the slop is the system's swipe instead.
      if (edge) {
        if (!tap) edgeSwipe();
        return;
      }
      // Fingers moving up scroll the content down.
      wheel(centroid.x - next.x, centroid.y - next.y, trackpad ? trackpad.position() : options.toTarget(next.x, next.y));
      sample(next);
    }
    centroid = next;
  };

  const fling = (kind: 'pan' | 'scroll', velocity: ViewPoint): void => {
    const motion = startFling(velocity, kind === 'pan' ? FLING_PAN_TIME_CONSTANT_MS : FLING_SCROLL_TIME_CONSTANT_MS);
    if (!motion) return;
    const start = now();
    let done = { x: 0, y: 0 };
    const tick = (): void => {
      flingHandle = null;
      const elapsed = now() - start;
      const reached = flingTravel(motion, elapsed);
      const dx = reached.x - done.x;
      const dy = reached.y - done.y;
      done = reached;
      if (kind === 'pan') travel(dx, dy);
      else wheel(-dx, -dy, trackpad ? trackpad.position() : wheelAt);
      if (elapsed < motion.duration) flingHandle = requestFrame(tick);
    };
    flingHandle = requestFrame(tick);
  };

  const click = (count: number): void => {
    const button = BUTTONS[count];
    if (!button) return;
    let at = trackpad ? trackpad.position() : options.toTarget(first.x, first.y);
    let ring: ViewPoint | null = trackpad ? trackpad.client() : first;
    if (!at) return;
    let clicks: 1 | 2 = 1;
    if (button === 'left' && !trackpad) {
      const tappedAt = now();
      if (
        lastTap &&
        tappedAt - lastTap.at <= DOUBLE_TAP_TIMEOUT_MS &&
        Math.hypot(first.x - lastTap.client.x, first.y - lastTap.client.y) <= DOUBLE_TAP_SLOP_PX
      ) {
        at = lastTap.target;
        ring = lastTap.client;
        clicks = 2;
        lastTap = null;
      } else {
        lastTap = { at: tappedAt, client: first, target: at };
      }
    } else {
      lastTap = null;
    }
    options.beforePress?.();
    emit({ type: 'click', button, at, count: clicks });
    feedback(ring, radius.tap);
  };

  const longPress = (): void => {
    timer = null;
    const single = mode === 'idle' && tap && touches.size === 1;
    tap = false;
    if (!single) return;
    const at = trackpad ? trackpad.position() : options.toTarget(first.x, first.y);
    if (!at) {
      mode = 'ended';
      return;
    }
    options.beforePress?.();
    mode = 'held';
    held = at;
    suppressFling = true;
    emit({ type: 'press', at });
    feedback(trackpad ? trackpad.client() : first, radius.press);
  };

  const begin = (x: number, y: number): void => {
    stop();
    clearTimer();
    edge = atEdge(x, y);
    ignored = false;
    first = { x, y };
    fingers = 0;
    tap = true;
    suppressFling = false;
    mode = 'idle';
    samples = [];
    swipeRelease = null;
    snapshotSeen = false;
    carry = { x: 0, y: 0 };
    held = null;
    timer = setTimeout(longPress, options.longPressMs ?? TOUCH_LONG_PRESS_MS);
  };

  const move = (id: number, x: number, y: number): void => {
    const touch = touches.get(id);
    if (!touch) return;
    touch.x = x;
    touch.y = y;
    if (ignored) return;
    if (tap && Math.hypot(x - touch.startX, y - touch.startY) > TOUCH_SLOP_PX) {
      tap = false;
      clearTimer();
    }
    if (mode === 'two' || mode === 'pinch' || mode === 'scroll') {
      // A gesture whose touch lists arrive moves only through `contacts`;
      // without them, pointer reports swipe and never zoom (partial reports
      // cannot tell a zoom from a swipe). Both move one shared centroid, so
      // no motion is dispatched twice; lists that stop coming hand the
      // gesture back to the pointer reports.
      if (snapshotSeen) {
        if (!movedSinceSnapshot.has(id) || movedSinceSnapshot.size < touches.size) {
          movedSinceSnapshot.add(id);
          return;
        }
        snapshotSeen = false;
        snapshot = null;
      }
      if (mode === 'pinch' || !centroid) return;
      if (mode === 'two') {
        const next = center();
        if (Math.hypot(next.x - centroid.x, next.y - centroid.y) <= TOUCH_SLOP_PX || edgeSwipe()) return;
        mode = 'scroll';
        tap = false;
      }
      follow();
      return;
    }
    if (touches.size !== 1) return;
    if (mode === 'idle' && !tap) {
      if (edgeSwipe()) return;
      mode = 'pan';
    }
    if (mode !== 'pan' && mode !== 'held') return;
    const dx = x - touch.lastX;
    const dy = y - touch.lastY;
    touch.lastX = x;
    touch.lastY = y;
    sample({ x, y });
    if (!dx && !dy) return;
    if (mode === 'pan' || trackpad) {
      travel(dx, dy);
      return;
    }
    const at = options.toTarget(x, y);
    if (!at) return;
    held = at;
    emit({ type: 'drag', at });
  };

  return {
    down(id, x, y) {
      if (!touches.size) begin(x, y);
      touches.set(id, { x, y, startX: x, startY: y, lastX: x, lastY: y });
      snapshot = null;
      movedSinceSnapshot.clear();
      if (ignored) return;
      fingers = Math.max(fingers, touches.size);
      if (touches.size === 1 || mode === 'multi') return;
      if (mode === 'held') {
        releaseHeld();
        mode = 'ended';
      }
      if (touches.size >= 3) {
        mode = 'multi';
        return;
      }
      mode = options.zoom ? 'two' : 'scroll';
      centroid = center();
      spread = spreadOf();
      samples = [];
    },
    move,
    up(id, x, y) {
      const touch = touches.get(id);
      if (!touch) return;
      if (!ignored && touches.size === 1 && (mode === 'pan' || mode === 'held')) move(id, x, y);
      if (!ignored && mode === 'scroll' && touches.size === 2) swipeRelease = { at: now(), velocity: flingVelocity(samples, now()) };
      touches.delete(id);
      snapshot = null;
      if (ignored) return;
      if (touches.size) {
        if (mode === 'scroll') centroid = center();
        else if (mode === 'two' || mode === 'pinch') mode = 'ended';
        return;
      }
      clearTimer();
      const ending = mode;
      mode = 'idle';
      if (ending === 'held') {
        releaseHeld();
        return;
      }
      if (tap) {
        click(fingers);
        return;
      }
      if (suppressFling) return;
      if (ending === 'pan') fling('pan', flingVelocity(samples, now()));
      else if (ending === 'scroll' && swipeRelease && now() - swipeRelease.at <= FLING_SAMPLE_MS) {
        fling('scroll', swipeRelease.velocity);
      }
    },
    cancel(id) {
      if (!touches.delete(id)) return;
      snapshot = null;
      clearTimer();
      tap = false;
      releaseHeld();
      mode = touches.size ? 'ended' : 'idle';
    },
    contacts(points) {
      if (ignored || (mode !== 'two' && mode !== 'pinch' && mode !== 'scroll')) return;
      if (!points.length || points.length !== touches.size) return;
      snapshot = points.map(({ x, y }) => ({ x, y }));
      snapshotSeen = true;
      movedSinceSnapshot.clear();
      if (mode === 'two') classify();
      else follow();
    },
    stop,
    dispose() {
      clearTimer();
      stop();
      releaseHeld();
      touches.clear();
      snapshot = null;
      mode = 'idle';
    },
  };
}

/** The view a gesture layer drives, as the caller keeps it. */
export interface ViewportStore {
  layout(): RemoteViewLayout | null;
  view(): RemoteView | null;
  setView(view: RemoteView): void;
  /** The stage's top-left corner, client px. */
  origin(): ViewPoint;
  /** Deepest zoom (stage px per picture unit); default REMOTE_VIEW_MAX_SCALE. */
  maxScale?: number;
}

/** The trackpad cursor's position, as the caller keeps it (picture units);
 *  null: unknown yet, the visible centre is used. */
export interface CursorStore {
  get(): ViewPoint | null;
  set(point: ViewPoint): void;
}

/**
 * `toTarget`, `toTargetDelta`, `pan`, `zoom` and (with `cursor`) the
 * trackpad cursor for `createTouchGestures`, over a viewport the caller
 * stores: target space is picture units. Moving the cursor keeps the view
 * centred on it as far as the bounds allow.
 */
export function viewportGestureBindings(
  store: ViewportStore,
  cursor?: CursorStore
): Pick<TouchGestureOptions, 'toTarget' | 'toTargetDelta' | 'pan' | 'zoom' | 'cursor'> {
  const current = (): { layout: RemoteViewLayout; view: RemoteView } | null => {
    const layout = store.layout();
    const view = store.view();
    return viewReady(layout) && view ? { layout, view } : null;
  };
  const stagePoint = (x: number, y: number): ViewPoint => {
    const origin = store.origin();
    return { x: x - origin.x, y: y - origin.y };
  };
  const position = (): ViewPoint => {
    const known = cursor?.get();
    if (known) return known;
    const state = current();
    return state ? stageToPicture(state.view, visibleCenter(state.layout)) : { x: 0, y: 0 };
  };
  return {
    toTarget(x, y) {
      const state = current();
      if (!state) return null;
      const point = stageToPicture(state.view, stagePoint(x, y));
      return pictureContains(state.layout, point) ? point : null;
    },
    toTargetDelta(dx, dy) {
      const state = current();
      return state ? { x: dx / state.view.scale, y: dy / state.view.scale } : { x: 0, y: 0 };
    },
    pan(dx, dy) {
      const state = current();
      if (state) store.setView(panView(state.view, state.layout, dx, dy, store.maxScale));
    },
    zoom(factor, x, y, dx, dy) {
      const state = current();
      if (!state) return;
      store.setView(zoomView(state.view, state.layout, factor, stagePoint(x, y), { x: dx, y: dy }, store.maxScale));
    },
    cursor: cursor && {
      position,
      moveBy(dx, dy) {
        const state = current();
        const from = position();
        if (!state) return from;
        const at = clampToPicture(state.layout, { x: from.x + dx, y: from.y + dy });
        cursor.set(at);
        store.setView(followPoint(state.view, state.layout, at, store.maxScale));
        return at;
      },
      client() {
        const state = current();
        if (!state) return null;
        const point = pictureToStage(state.view, position());
        const origin = store.origin();
        return { x: point.x + origin.x, y: point.y + origin.y };
      },
    },
  };
}
