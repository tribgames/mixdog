/**
 * Background tab limits and visible guest selection: pure rules shared by the
 * session registry, the tab actions, and the command queue.
 */
export const MAX_BACKGROUND_TABS = 8;
export const BACKGROUND_PAGE_IDLE_MS = 30 * 60_000;
const MAX_BACKGROUND_TAB_NAME_CHARS = 64;

export interface BrowserGuestCandidate {
  id: number;
  isDestroyed(): boolean;
}

export interface RepaintableBrowserGuestCandidate extends BrowserGuestCandidate {
  invalidate(): void;
}

export function selectActiveBrowserGuest<T extends BrowserGuestCandidate>(
  guests: Iterable<T>,
  current: T | null,
  webContentsId: number,
  active: boolean,
): T | null {
  const liveCurrent = current && !current.isDestroyed() ? current : null;
  const guest = [...guests].find((candidate) =>
    !candidate.isDestroyed() && candidate.id === webContentsId);
  if (!guest) return liveCurrent;
  if (active) return guest;
  return liveCurrent === guest ? null : liveCurrent;
}

/** Select the explicit Browser Use guest and repaint it on every active signal.
 * Repeated active signals represent app foreground returns, not only tab
 * changes, so they intentionally invalidate an already-selected guest too. */
export function selectAndRefreshActiveBrowserGuest<T extends RepaintableBrowserGuestCandidate>(
  guests: Iterable<T>,
  current: T | null,
  webContentsId: number,
  active: boolean,
): T | null {
  const selected = selectActiveBrowserGuest(guests, current, webContentsId, active);
  if (active && selected?.id === webContentsId) {
    try {
      selected.invalidate();
    } catch { /* guest teardown can race the renderer's foreground signal */ }
  }
  return selected;
}

export function normalizeBackgroundTabName(raw: string, options: { required?: boolean } = {}): string {
  const name = String(raw || '').trim();
  if (!name) {
    if (options.required) throw new Error('a background tab name is required');
    return 'bg';
  }
  if (name.length > MAX_BACKGROUND_TAB_NAME_CHARS) {
    throw new Error(`background tab names may not exceed ${MAX_BACKGROUND_TAB_NAME_CHARS} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('background tab names may not contain control characters');
  }
  if (/^[vp]\d+$/i.test(name)) {
    throw new Error('background tab names may not use the reserved p1/p2… or v1/v2… form');
  }
  return name;
}

export function assertBackgroundTabCapacity(openTabs: number): void {
  if (openTabs >= MAX_BACKGROUND_TABS) {
    throw new Error(
      `at most ${MAX_BACKGROUND_TABS} background tabs may be open; call list_tabs and close_tab before opening another`,
    );
  }
}

export function backgroundPageIdle(
  lastUsedAt: number,
  now = Date.now(),
  idleMs = BACKGROUND_PAGE_IDLE_MS,
): boolean {
  return Number.isFinite(lastUsedAt)
    && Number.isFinite(now)
    && Number.isFinite(idleMs)
    && idleMs >= 0
    && now - lastUsedAt >= idleMs;
}
