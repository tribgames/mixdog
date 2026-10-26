/** Decorative loops that step at 24 fps (14-live-activity.css,
 *  22-markdown.css). Each one's frame edges fall on its own start time, and a
 *  CSS animation starts on whichever display frame mounted or resumed it: two
 *  loops out of phase made the compositor draw both sets of edges (up to 48
 *  frames a second instead of 24). Anchoring every one to the document
 *  timeline's origin puts them all on one 1/24 s grid. */
const DECORATIVE_LOOPS = new Set([
  'live-activity-arc-flow',
  'live-activity-logo-spin',
  'text-shimmer-window',
  'text-shimmer-window-copy',
]);

/** The phone's shimmer has no CSS animation (22-markdown.css): WebView
 *  re-evaluated its stepped mask animation every vsync, between steps too.
 *  Its glint carries the same duration and `steps()` as declared CSS (the
 *  animation's name is `none`), and the mask position follows the step index
 *  this module writes, once per step, onto `--text-shimmer-step`. */
const SHIMMER_GLINT = '[data-slot="text-shimmer-glint"]';
const SHIMMER_STEP = '--text-shimmer-step';

interface ShimmerMask {
  frames: number;
  stepMs: number;
  /** The step index last written; -1 before the first write. */
  step: number;
}

/** Every mounted glint; `null` while it is not driven (desktop layout, or held
 *  by a pause rule or reduced motion). */
const maskGlints = new Map<Element, ShimmerMask | null>();
let maskTimer: ReturnType<typeof setTimeout> | undefined;

/** The cadence the glint's CSS declares, or `null` while its pause rules hold
 *  it (the same rules that paused the animation: `animation-play-state`, and
 *  reduced motion hiding the glint). The duration is read as a number: its
 *  serialized text keeps only six digits, which drift off the timeline's grid. */
function readShimmerMask(glint: Element): ShimmerMask | null {
  const style = glint.ownerDocument.defaultView?.getComputedStyle(glint);
  if (!style || style.display === 'none' || style.animationPlayState !== 'running') return null;
  const frames = Number(/steps\((\d+)/.exec(style.animationTimingFunction)?.[1]);
  const duration = (
    glint as unknown as { computedStyleMap(): { get(property: string): { value: number } | undefined } }
  )
    .computedStyleMap()
    .get('animation-duration')?.value;
  if (!(frames > 0) || !duration) return null;
  return { frames, stepMs: (duration * 1000) / frames, step: -1 };
}

/** Writes the step each driven glint is on at `now`, only where it changed.
 *  The index counts steps from the timeline's origin, where the locked CSS
 *  loops start: the shimmer stays on the running mark's beat. */
function writeShimmerMasks(now: number): void {
  for (const [glint, mask] of maskGlints) {
    if (!mask) continue;
    const step = Math.floor(now / mask.stepMs) % mask.frames;
    if (step === mask.step) continue;
    mask.step = step;
    (glint as HTMLElement).style.setProperty(SHIMMER_STEP, String(step));
  }
}

/** Wakes at the next step boundary of any driven glint; nothing between. */
function scheduleShimmerMasks(): void {
  clearTimeout(maskTimer);
  maskTimer = undefined;
  const now = performance.now();
  let next = Number.POSITIVE_INFINITY;
  for (const mask of maskGlints.values())
    if (mask) next = Math.min(next, (Math.floor(now / mask.stepMs) + 1) * mask.stepMs);
  if (next < Number.POSITIVE_INFINITY) maskTimer = setTimeout(tickShimmerMasks, next - now);
}

function tickShimmerMasks(): void {
  maskTimer = undefined;
  writeShimmerMasks(performance.now());
  scheduleShimmerMasks();
}

/** Re-reads which glints run: on the phone layout, those no pause rule holds.
 *  A resumed glint writes the step of the current time at once, so it lands on
 *  the beat, and a held one keeps its pose. */
function refreshShimmerMasks(): void {
  const [first] = maskGlints.keys();
  if (!first) return;
  const phone = first.ownerDocument.documentElement.hasAttribute('data-mixdog-mobile-tabs');
  const reads = [...maskGlints].map(([glint, previous]) => {
    const mask = phone ? readShimmerMask(glint) : null;
    if (mask && previous) mask.step = previous.step;
    return [glint, mask] as const;
  });
  for (const [glint, mask] of reads) maskGlints.set(glint, mask);
  writeShimmerMasks(performance.now());
  scheduleShimmerMasks();
}

/** Whether a changed element holds or covers a mounted glint. */
function coversShimmer(target: Element): boolean {
  for (const glint of maskGlints.keys()) if (target.contains(glint)) return true;
  return false;
}

/** The only elements the stylesheets run those loops on (their `animation`
 *  rules; decorative-motion-sync.test.mjs keeps the two in step): the arcs
 *  mark, its strip, and the shimmer glint (with its ::before copy). */
export const DECORATIVE_LOOP_HOSTS = '.live-activity-arcs, .live-activity-arc-strip, [data-slot="text-shimmer-glint"]';

/** The attributes below the root whose changes pause or resume these loops
 *  (the CSS pause rules). A resumed CSS animation restarts its clock where it
 *  was held, and no event reports it. */
const MOTION_SIGNALS = ['data-offscreen', 'data-conversation-parked', 'data-retained', 'data-surface-active'];

/** Whether a signal's current value holds the loops below it (the CSS pause
 *  rules): a pause needs no lock, only the resume does. */
function signalHolds(target: Element, attribute: string | null): boolean {
  if (attribute === 'data-retained') return target.hasAttribute(attribute);
  if (attribute === 'data-surface-active') return target.getAttribute(attribute) === 'false';
  return attribute !== null && target.getAttribute(attribute) === 'true';
}

/** Phase-locks the running decorative loops on `element` and its subtree
 *  (pseudo-elements included) to the timeline origin. A held loop is left
 *  alone: giving it a start time would play it and detach it from its CSS
 *  play state for good; it is locked when it resumes. Every element's loops
 *  are read before any is written: a written start time invalidates style,
 *  and a read after it forced another full style update.
 *  Only loop hosts are asked for their animations: `getAnimations` flushes
 *  style for the whole document, and asked of every transcript row whose
 *  offscreen mark changed it ran a full style update after each scroll range
 *  change (and a 224ms one on a phone opening a session) though no loop
 *  was there. A subtree without a host is skipped with a selector query,
 *  which reads no style.
 *  The hosts share one document read: every `getAnimations` call, an
 *  element's too, collects and orders all of the document's animations (a
 *  transcript's word fades included) before it filters them, so a read per
 *  host repeated that for each one (81-97 ms locking the hosts of a phone
 *  back from the background). A loop runs on its host or the host's
 *  pseudo-element, and both report the host as their target. */
export function syncDecorativeLoops(...elements: Element[]): void {
  const hosts = new Set<Element>();
  for (const element of elements) {
    if (element.matches(DECORATIVE_LOOP_HOSTS)) hosts.add(element);
    for (const host of element.querySelectorAll(DECORATIVE_LOOP_HOSTS)) hosts.add(host);
  }
  const [first] = hosts;
  if (!first) return;
  const unlocked: Animation[] = [];
  for (const animation of first.ownerDocument.getAnimations()) {
    // Only CSS animations carry a name; transitions and script animations do not.
    if (!DECORATIVE_LOOPS.has((animation as CSSAnimation).animationName)) continue;
    const target = (animation.effect as KeyframeEffect | null)?.target;
    if (!target || !hosts.has(target)) continue;
    if (animation.playState !== 'running' || animation.startTime === 0) continue;
    unlocked.push(animation);
  }
  for (const animation of unlocked) animation.startTime = 0;
}

/** Every lock a frame asks for (mounts, starts, resumes, root modes) runs in
 *  one pass in its animation callbacks, which come after the frame's tasks and
 *  before its style update and paint: the pass shares that style update, one
 *  `getAnimations` read serves every host, and the loops still paint locked.
 *  A lock per cause forced a full style update and a read of every animation
 *  each time: a resume (a phone back from the background) changes the root
 *  mode and unpauses rows across many commits (31 ms in one resumed task),
 *  and a commit mounting several marks read once per mark. */
const pendingLocks = new Set<Element>();
let lockFrame = 0;

function lockPending(): void {
  lockFrame = 0;
  const targets = [...pendingLocks];
  pendingLocks.clear();
  // A root mode change locks the whole page, which covers every other cause.
  const page = targets.find((target) => target === target.ownerDocument.documentElement);
  syncDecorativeLoops(...(page ? [page] : targets.filter((target) => target.isConnected)));
  // Mounts and root modes reach the phone's shimmer here, ahead of the paint.
  refreshShimmerMasks();
}

/** A hidden window runs no frames, and rows resumed or started meanwhile
 *  may be removed before one comes: each enqueue first drops the queued
 *  elements no longer in the document (the frame pass skips them anyway), so
 *  the queue holds at most the connected elements still waiting, never a
 *  removed row's subtree. */
function queueDecorativeLocks(targets: Iterable<Element>): void {
  for (const queued of pendingLocks) if (!queued.isConnected) pendingLocks.delete(queued);
  for (const target of targets) pendingLocks.add(target);
  if (pendingLocks.size && !lockFrame) lockFrame = requestAnimationFrame(lockPending);
}

/** Ref callback for the element a loop mounts on: locks it before its first
 *  paint, in the frame's one lock pass. Its cleanup (React runs it on unmount)
 *  drops a lock still queued: a hidden window runs no frames, and the queue
 *  held every element mounted and unmounted meanwhile, with its subtree. */
export function lockDecorativeLoops(element: Element | null): (() => void) | undefined {
  if (!element) return undefined;
  if (element.matches(SHIMMER_GLINT)) maskGlints.set(element, null);
  queueDecorativeLocks([element]);
  return () => {
    pendingLocks.delete(element);
    // The last running glint leaving takes the pending timer with it.
    if (maskGlints.delete(element)) scheduleShimmerMasks();
  };
}

/** Locks every decorative loop the window starts or resumes.
 *  - Any start, whatever recreated the animation: `animationstart`. Chromium
 *    dispatches it on the frame after the animation's first, so that one
 *    frame still shows the unlocked pose; the hooks below lock the known
 *    causes before the first paint instead. The starts of one frame lock
 *    together in its animation callbacks.
 *  - Resumes, which raise no event: a pause signal changed.
 *  - Root modes (hidden document, phone layout, theme...) and the reduced
 *    motion preference recreate loops page-wide.
 *  All of a frame's causes lock together in its animation callbacks, ahead
 *  of its style update and paint. */
export function installDecorativeMotionSync(root: HTMLElement = document.documentElement): () => void {
  // A burst of starts (a list mounting its running marks) arrives as one
  // event each in the same frame: they lock together in that frame's pass.
  const onStart = (event: AnimationEvent) => {
    if (DECORATIVE_LOOPS.has(event.animationName) && event.target instanceof Element)
      queueDecorativeLocks([event.target]);
  };
  const onRoot = () => {
    queueDecorativeLocks([root]);
    refreshShimmerMasks();
  };
  const signals = new MutationObserver((records) => {
    const targets = new Set<Element>();
    let shimmer = false;
    for (const record of records) {
      if (!(record.target instanceof Element)) continue;
      // A pause stops the phone's shimmer writes as a resume restarts them;
      // only a signal above a mounted glint reads any style.
      if (!shimmer && coversShimmer(record.target)) shimmer = true;
      if (record.target.isConnected && !signalHolds(record.target, record.attributeName)) targets.add(record.target);
    }
    queueDecorativeLocks(targets);
    if (shimmer) refreshShimmerMasks();
  });
  // The root's inline style holds only custom properties (viewport metrics,
  // skin values) that never create an animation, and it changes on every
  // resize and slider drag: those changes would only force style updates.
  const modes = new MutationObserver((records) => {
    if (records.some((record) => record.attributeName !== 'style')) onRoot();
  });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  root.addEventListener('animationstart', onStart, true);
  signals.observe(root, { attributes: true, attributeFilter: MOTION_SIGNALS, subtree: true });
  modes.observe(root, { attributes: true });
  reducedMotion.addEventListener('change', onRoot);
  return () => {
    if (lockFrame) cancelAnimationFrame(lockFrame);
    lockFrame = 0;
    pendingLocks.clear();
    clearTimeout(maskTimer);
    maskTimer = undefined;
    maskGlints.clear();
    root.removeEventListener('animationstart', onStart, true);
    signals.disconnect();
    modes.disconnect();
    reducedMotion.removeEventListener('change', onRoot);
  };
}
