/**
 * src/tui/engine/render-timing.mjs - render-throttle timing helper.
 *
 * Extracted from engine.mjs (no behavior change originally).
 *
 * Ink renders through a maxFps throttle (60fps in index.jsx, ≈16.7ms). A plain
 * setImmediate only yields to the event loop; if Ink already painted within the
 * current throttle window, the next paint may still be queued and our following
 * transcript mutation can coalesce into the same visible frame. When we
 * intentionally split transcript commits for visual stability (preamble frame →
 * tool-card frame), we must wait for the split-off commit to actually paint.
 *
 * A fixed 12ms wait was below the 60fps frame budget, so the tool card could
 * land in the same frame as the preamble and the bottom-pinned viewport jumped.
 * Instead we wait for the next real Ink render frame: index.jsx routes its
 * onRender hook through notifyRenderFrame(), which resolves any pending yields.
 * The fixed timeout below is only a fallback ceiling for when no renderer ack is
 * wired (or the renderer is idle) so a yield can never hang the turn.
 */
export const RENDER_ACK_FALLBACK_MS = 32;
export const RENDER_ACK_HANG_GUARD_MS = 250;
export const RENDER_SETTLE_IDLE_MS = 64;

// Back-compat alias: previously the fixed wait duration, now the fallback only.
export const RENDER_THROTTLE_FLUSH_MS = RENDER_ACK_FALLBACK_MS;

let pendingRenderAcks = [];
let renderAckSeq = 0;

/**
 * Called by the Ink onRender hook once per painted frame. The sequence is
 * allocated synchronously at onRender time, BEFORE the deferred post-write ack,
 * so a yield that starts after onRender but before setImmediate delivery can
 * identify and ignore that stale/previous-frame ack.
 */
export const scheduleRenderFrameAck = () => {
  const seq = ++renderAckSeq;
  setImmediate(() => notifyRenderFrame(seq));
};

export const notifyRenderFrame = (seq = ++renderAckSeq) => {
  if (pendingRenderAcks.length === 0) return;
  const acks = pendingRenderAcks;
  pendingRenderAcks = [];
  for (const ack of acks) ack(seq);
};

export const yieldToRenderer = ({ frames = 1 } = {}) => new Promise((resolve) => {
  const minSeq = renderAckSeq;
  let remainingFrames = Math.max(1, Math.floor(Number(frames) || 1));
  let settled = false;
  let sawRealFrame = false;
  let timer = null;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    const idx = pendingRenderAcks.indexOf(onFrame);
    if (idx !== -1) pendingRenderAcks.splice(idx, 1);
    resolve();
  };
  const onTimeout = () => {
    if (settled) return;
    // A render has already reached onRender and scheduled its deferred
    // post-write ack, but the event loop may run expired timers before the
    // check-phase setImmediate. Do NOT let the first-frame hang guard beat that
    // queued real-frame ack; keep waiting for it so frames:2 cannot collapse to
    // zero/one actual paints under a slow preamble render.
    if (!sawRealFrame && renderAckSeq > minSeq) {
      // Yield exactly one check phase: a legitimate queued notifyRenderFrame(seq)
      // was scheduled before this timeout callback and should run first. If it is
      // lost/skipped, this follow-up finishes the hang guard instead of
      // re-arming forever.
      setImmediate(() => {
        if (!settled && !sawRealFrame) finish();
      });
      return;
    }
    finish();
  };
  const armWait = () => {
    if (settled) return;
    if (!pendingRenderAcks.includes(onFrame)) pendingRenderAcks.push(onFrame);
    if (timer) clearTimeout(timer);
    // Before the FIRST real frame, the timer is only a long hang guard for
    // no-ack/no-render paths. After at least one frame painted, the timer becomes
    // a short "settle idle" fallback: if no follow-up measurement/correction
    // render arrives within roughly four 60fps frames, treat the preamble as
    // stable instead of forcing a visible 250ms pause before the tool card.
    timer = setTimeout(onTimeout, sawRealFrame ? RENDER_SETTLE_IDLE_MS : RENDER_ACK_HANG_GUARD_MS);
  };
  const onFrame = (seq = 0) => {
    if (settled) return;
    if (seq <= minSeq) {
      if (!pendingRenderAcks.includes(onFrame)) pendingRenderAcks.push(onFrame);
      return;
    }
    sawRealFrame = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const idx = pendingRenderAcks.indexOf(onFrame);
    if (idx !== -1) pendingRenderAcks.splice(idx, 1);
    remainingFrames -= 1;
    if (remainingFrames <= 0) finish();
    else armWait();
  };
  // Count real render acks as frames. The pre-first-frame timeout is a hang
  // guard, while the post-first-frame timeout is an idle-settle fallback so a
  // missing second frame does not add a quarter-second tool-card delay.
  armWait();
});
