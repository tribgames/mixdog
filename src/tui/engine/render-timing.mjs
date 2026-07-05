/**
 * src/tui/engine/render-timing.mjs - render-throttle timing helper.
 *
 * Extracted from engine.mjs (no behavior change).
 *
 * Ink renders through a maxFps throttle (120fps in index.jsx, ≈8.3ms). A plain
 * setImmediate only yields to the event loop; if Ink already painted within the
 * current throttle window, the next paint may still be queued and our following
 * transcript mutation can coalesce into the same visible frame. Wait just past
 * one render window when we intentionally split transcript commits for visual
 * stability (preamble frame → tool-card frame).
 */
export const RENDER_THROTTLE_FLUSH_MS = 12;

export const yieldToRenderer = () => new Promise((resolve) => {
  setTimeout(resolve, RENDER_THROTTLE_FLUSH_MS);
});
