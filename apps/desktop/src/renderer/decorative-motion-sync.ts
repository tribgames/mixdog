/** Loops that step at 24 fps (14-live-activity.css, 22-markdown.css). A CSS animation starts on the display frame that mounted
 *  or resumed it, so anchoring every loop's start time to the timeline origin puts them on one 1/24 s grid. */
const DECORATIVE_LOOPS = new Set([
  'live-activity-arc-flow',
  'live-activity-logo-spin',
  'text-shimmer-window',
  'text-shimmer-window-copy',
]);

/** The phone's shimmer has no CSS animation (22-markdown.css): WebView re-evaluates a stepped mask animation every vsync. The mask
 *  position follows the step index written onto `--text-shimmer-step`. */
const SHIMMER_GLINT = '[data-slot="text-shimmer-glint"]';
const SHIMMER_STEP = '--text-shimmer-step';

interface ShimmerMask {
  frames: number;
  stepMs: number;
  /** The step index last written; -1 before the first write. */
  step: number;
}

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

/** Phase-locks the running decorative loops on `element` and its subtree to the timeline origin. A held loop is left alone: a
 *  start time would play it and detach it from its CSS play state for good. Every loop is read before any is written (a written
 *  start time invalidates style), and one document-wide `getAnimations` call serves all hosts (it flushes style and collects
 *  every animation of the document); a subtree without a host is skipped with a selector query. A loop on a host's
 *  pseudo-element reports the host as its target. */
function syncDecorativeLoops(...elements: Element[]): void {
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

/** Every lock a frame asks for runs in one pass in its animation callbacks, before the frame's style update and paint: one
 *  `getAnimations` read serves every host and the loops still paint locked. */
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

function queueDecorativeLocks(targets: Iterable<Element>): void {
  for (const queued of pendingLocks) if (!queued.isConnected) pendingLocks.delete(queued);
  for (const target of targets) pendingLocks.add(target);
  if (pendingLocks.size && !lockFrame) lockFrame = requestAnimationFrame(lockPending);
}

/** Ref callback for the element a loop mounts on: locks it before its first paint, in the frame's one lock pass. Its cleanup
 *  drops a lock still queued. */
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

/** Locks every decorative loop the window starts or resumes: on `animationstart` (Chromium dispatches it a frame after the
 *  animation's first, so the known causes below lock before the first paint instead), on a change of a pause signal (a resume
 *  raises no event), and on a root mode or reduced-motion change (both recreate loops page-wide). */
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
