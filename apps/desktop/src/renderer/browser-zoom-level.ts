// Session-scoped zoom level for the Browser Use surfaces. 1 is the surface's
// own baseline: the auto-fit factor on the desktop pane, the fitted frame on
// the phone. The level multiplies that baseline, so the same "120%" reads
// alike on every surface. Persisted per session beside the viewport preset.

export const BROWSER_ZOOM_MIN = 0.5;
export const BROWSER_ZOOM_MAX = 2;
export const BROWSER_ZOOM_STEP = 0.1;

const BROWSER_ZOOM_STORAGE_PREFIX = "mixdog.browser-zoom.v1:";

type ZoomStorage = Pick<Storage, "getItem" | "setItem">;

export function clampBrowserZoom(value: unknown): number {
  const level = Number(value);
  if (!Number.isFinite(level)) return 1;
  const clamped = Math.min(BROWSER_ZOOM_MAX, Math.max(BROWSER_ZOOM_MIN, level));
  return Math.round(clamped * 100) / 100;
}

export function stepBrowserZoom(level: number, direction: 1 | -1): number {
  return clampBrowserZoom(level + BROWSER_ZOOM_STEP * direction);
}

function zoomStorageKey(sessionId: string): string | null {
  const normalized = sessionId.trim();
  return normalized ? `${BROWSER_ZOOM_STORAGE_PREFIX}${normalized}` : null;
}

export function readBrowserZoom(
  storage: ZoomStorage | null | undefined,
  sessionId: string,
): number {
  const key = zoomStorageKey(sessionId);
  if (!storage || !key) return 1;
  try {
    const stored = storage.getItem(key);
    return stored === null ? 1 : clampBrowserZoom(stored);
  } catch {
    return 1;
  }
}

export function writeBrowserZoom(
  storage: ZoomStorage | null | undefined,
  sessionId: string,
  level: number,
): number {
  const clamped = clampBrowserZoom(level);
  const key = zoomStorageKey(sessionId);
  if (!storage || !key) return clamped;
  try {
    storage.setItem(key, String(clamped));
  } catch {
    // The live level still applies when storage is blocked or full.
  }
  return clamped;
}
