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
  'text-shimmer-mask',
]);

/** The attributes below the root whose changes pause or resume these loops
 *  (the CSS pause rules). A resumed CSS animation restarts its clock where it
 *  was held, and no event reports it. */
const MOTION_SIGNALS = ['data-offscreen', 'data-conversation-parked', 'data-retained', 'data-surface-active'];

/** Phase-locks the running decorative loops on `element` and its subtree
 *  (pseudo-elements included) to the timeline origin. A held loop is left
 *  alone: giving it a start time would play it and detach it from its CSS
 *  play state for good; it is locked when it resumes. */
export function syncDecorativeLoops(element: Element): void {
  for (const animation of element.getAnimations({ subtree: true })) {
    // Only CSS animations carry a name; transitions and script animations do not.
    if (!DECORATIVE_LOOPS.has((animation as CSSAnimation).animationName)) continue;
    if (animation.playState !== 'running' || animation.startTime === 0) continue;
    animation.startTime = 0;
  }
}

/** Ref callback for the element a loop mounts on: locks it before its first
 *  paint. */
export function lockDecorativeLoops(element: Element | null): void {
  if (element) syncDecorativeLoops(element);
}

/** Locks every decorative loop the window starts or resumes.
 *  - Any start, whatever recreated the animation: `animationstart`. Chromium
 *    dispatches it on the frame after the animation's first, so that one
 *    frame still shows the unlocked pose; the hooks below lock the known
 *    causes before the first paint instead.
 *  - Resumes, which raise no event: a pause signal changed.
 *  - Root modes (hidden document, phone layout, theme...) and the reduced
 *    motion preference recreate loops page-wide: their change runs before the
 *    frame's style update, so locking there forces that update and locks the
 *    new animations before they paint. */
export function installDecorativeMotionSync(root: HTMLElement = document.documentElement): () => void {
  const onStart = (event: AnimationEvent) => {
    if (DECORATIVE_LOOPS.has(event.animationName) && event.target instanceof Element) {
      syncDecorativeLoops(event.target);
    }
  };
  const onRoot = () => syncDecorativeLoops(root);
  const signals = new MutationObserver((records) => {
    const targets = new Set<Element>();
    for (const record of records) if (record.target instanceof Element) targets.add(record.target);
    for (const target of targets) if (target.isConnected) syncDecorativeLoops(target);
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
    root.removeEventListener('animationstart', onStart, true);
    signals.disconnect();
    modes.disconnect();
    reducedMotion.removeEventListener('change', onRoot);
  };
}
