export const MIN_RENDERER_WATCH_IDLE_MS = 60_000;
export const DEFAULT_RENDERER_WATCH_IDLE_MS = 2 * 60_000;

export function resolveRendererWatchIdleMs(value) {
  const configured = Number(value);
  return Math.max(
    MIN_RENDERER_WATCH_IDLE_MS,
    Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_RENDERER_WATCH_IDLE_MS,
  );
}
