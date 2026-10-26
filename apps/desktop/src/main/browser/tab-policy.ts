/**
 * Background tab limits and visible guest selection: pure rules shared by the
 * session registry, the tab actions, and the command queue.
 */
export const MAX_BACKGROUND_TABS_PER_SESSION = 6;
/** Safety net across every session; a session can only free its own tabs. */
export const MAX_BACKGROUND_TABS_GLOBAL = 24;
/** Fallback for pages of a live turn nobody has used for this long. */
export const BACKGROUND_PAGE_IDLE_MS = 30 * 60_000;
/** A session's agent pages are reclaimed this long after its turn finishes. */
export const FINISHED_TURN_PAGE_IDLE_MS = 5 * 60_000;
/** A user page no panel shows is unloaded this soon; reopening restores it. */
export const USER_PAGE_IDLE_MS = 5 * 60_000;
const MAX_BACKGROUND_TAB_NAME_CHARS = 64;

interface BrowserGuestCandidate {
  id: number;
  isDestroyed(): boolean;
}

interface RepaintableBrowserGuestCandidate extends BrowserGuestCandidate {
  invalidate(): void;
}

export function selectActiveBrowserGuest<T extends BrowserGuestCandidate>(
  guests: Iterable<T>,
  current: T | null,
  webContentsId: number,
  active: boolean
): T | null {
  const liveCurrent = current && !current.isDestroyed() ? current : null;
  const guest = [...guests].find((candidate) => !candidate.isDestroyed() && candidate.id === webContentsId);
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
  active: boolean
): T | null {
  const selected = selectActiveBrowserGuest(guests, current, webContentsId, active);
  if (active && selected?.id === webContentsId) {
    try {
      selected.invalidate();
    } catch {
      /* guest teardown can race the renderer's foreground signal */
    }
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

/** One open background page as admission sees it. `blocker` says why it may
 *  not be evicted for another session's page; '' means it may. */
export interface BackgroundPageFacts {
  sessionId: string;
  name: string;
  lastUsedAt: number;
  blocker: string;
}

function idleAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  return minutes < 1 ? 'idle <1m' : `idle ${minutes}m`;
}

/** Which pages to evict so `adding` new background pages of `sessionId` fit.
 *  The session's own cap is the agent's to fix (list_tabs/close_tab); at the
 *  global ceiling the least-recently-used evictable page of ANOTHER session
 *  goes, and when none can, the error names the owners holding the space. */
export function planBackgroundAdmission(request: {
  sessionId: string;
  adding: number;
  pages: BackgroundPageFacts[];
  now: number;
}): Array<{ sessionId: string; name: string }> {
  const { sessionId, adding, pages, now } = request;
  const own = pages.filter((page) => page.sessionId === sessionId).length;
  if (own + adding > MAX_BACKGROUND_TABS_PER_SESSION) {
    throw new Error(
      `this session already has ${own} background tabs open (at most ${MAX_BACKGROUND_TABS_PER_SESSION} per session); call list_tabs and close_tab before opening another`
    );
  }
  const overflow = pages.length + adding - MAX_BACKGROUND_TABS_GLOBAL;
  if (overflow <= 0) return [];
  const others = pages.filter((page) => page.sessionId !== sessionId);
  const evictable = others.filter((page) => !page.blocker).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  if (evictable.length >= overflow) {
    return evictable.slice(0, overflow).map(({ sessionId: owner, name }) => ({ sessionId: owner, name }));
  }
  const blocking = others.filter((page) => page.blocker).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  // Every holder is named: their number is bounded by MAX_BACKGROUND_TABS_GLOBAL.
  const listed = blocking.map(
    (page) => `session ${page.sessionId} "${page.name}" (${page.blocker}, ${idleAge(now - page.lastUsedAt)})`
  );
  throw new Error(
    `at most ${MAX_BACKGROUND_TABS_GLOBAL} background tabs may be open across all sessions and none can be reclaimed yet; ` +
      `the other sessions' tabs are held by: ${listed.join('; ')}. Retry once those turns finish; they are not tabs this session can close`
  );
}

export function backgroundPageIdle(lastUsedAt: number, now = Date.now(), idleMs = BACKGROUND_PAGE_IDLE_MS): boolean {
  return (
    Number.isFinite(lastUsedAt) &&
    Number.isFinite(now) &&
    Number.isFinite(idleMs) &&
    idleMs >= 0 &&
    now - lastUsedAt >= idleMs
  );
}
