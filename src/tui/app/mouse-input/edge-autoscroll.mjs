/**
 * mouse-input/edge-autoscroll.mjs — held-at-edge auto-scroll timer.
 *
 * One responsibility: keep the transcript scrolling while a drag is parked
 * against the viewport's top/bottom row. The timer state object is owned by
 * the caller (a hook-scoped ref) so it survives the input effect's
 * re-subscribes; see use-mouse-input.mjs.
 */
const EDGE_AUTOSCROLL_INTERVAL_MS = 50;

export function createEdgeAutoscroll({ stateRef, dragRef, scrollTargetRef, queueScrollCoalesced }) {
  const stop = () => {
    const st = stateRef.current;
    if (st.timer) {
      clearInterval(st.timer);
      st.timer = null;
    }
    st.dir = 0;
    st.noMove = 0;
  };
  const start = (dir) => {
    const st = stateRef.current;
    if (st.dir === dir && st.timer) return; // already scrolling this way
    stop();
    st.dir = dir;
    st.noMove = 0;
    st.timer = setInterval(() => {
      const drag = dragRef.current;
      const st2 = stateRef.current;
      if (!drag.active || drag.region !== 'transcript' || st2.dir === 0) {
        stop();
        return;
      }
      const before = Number(scrollTargetRef.current) || 0;
      queueScrollCoalesced(st2.dir * 3);
      // A SINGLE unchanged tick is ambiguous: the coalescer may not have
      // flushed this delta yet (queued behind its 16ms leading-edge timer),
      // so scrollTarget legitimately reads the same value mid-flight. Only a
      // real top/bottom clamp keeps it pinned across several ticks. Require
      // CONSECUTIVE no-move ticks (>=3 ⇒ >150ms ≫ the 16ms coalescer window,
      // so any pending scroll has certainly flushed) before stopping — any
      // movement resets the counter (ref useDragToScroll's getScrollTop<=0 /
      // >=max boundary stop).
      if ((Number(scrollTargetRef.current) || 0) !== before) {
        st2.noMove = 0;
      } else if (++st2.noMove >= 3) {
        stop();
      }
    }, EDGE_AUTOSCROLL_INTERVAL_MS);
    st.timer.unref?.();
  };
  return { start, stop };
}
