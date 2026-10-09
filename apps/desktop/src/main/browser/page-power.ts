/**
 * Power state of browser pages. A page runs at full speed only while a Browser
 * panel displays it or an agent command drives it; any other page is throttled
 * and stops producing frames. A user page that stays unused past the idle
 * threshold is unloaded through the session's unload-and-restore path.
 */
import type { WebContents } from 'electron';

import type { BrowserSessionRegistry } from './session-registry';
import { BACKGROUND_PAGE_IDLE_MS, backgroundPageIdle, USER_PAGE_IDLE_MS } from './tab-policy';

type PowerGuest = Pick<
  WebContents,
  'isDestroyed' | 'isOffscreen' | 'setBackgroundThrottling' | 'startPainting' | 'stopPainting' | 'invalidate'
>;

export function createBrowserPagePower<T extends PowerGuest>(host: { isDisplayed(guest: T): boolean }) {
  const driving = new Map<T, number>();
  const running = new WeakMap<T, boolean>();
  const stoppedAt = new WeakMap<T, number>();

  const isActive = (guest: T) => host.isDisplayed(guest) || (driving.get(guest) ?? 0) > 0;

  /** Bring the page's throttling and painting in line with whether anything
   *  displays or drives it. Idempotent. */
  function refresh(guest: T): void {
    if (guest.isDestroyed()) return;
    const run = isActive(guest);
    if (running.get(guest) === run) return;
    running.set(guest, run);
    if (!run) stoppedAt.set(guest, Date.now());
    guest.setBackgroundThrottling(!run);
    if (!guest.isOffscreen()) return;
    if (run) {
      guest.startPainting();
      guest.invalidate();
    } else {
      guest.stopPainting();
    }
  }

  return {
    refresh,
    isActive,
    /** A new page counts as used now; it settles once nothing uses it. */
    track(guest: T): void {
      stoppedAt.set(guest, Date.now());
      refresh(guest);
    },
    /** When the page was last displayed or driven (now while it still is). */
    lastActiveAt(guest: T): number {
      return isActive(guest) ? Date.now() : (stoppedAt.get(guest) ?? 0);
    },
    /** Run the page unthrottled until the returned release is called. */
    drive(guest: T): () => void {
      driving.set(guest, (driving.get(guest) ?? 0) + 1);
      refresh(guest);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (driving.get(guest) ?? 1) - 1;
        if (remaining > 0) driving.set(guest, remaining);
        else driving.delete(guest);
        refresh(guest);
      };
    },
  };
}

/** Unload every session whose pages are all undisplayed, undriven, not kept
 *  alive, and idle past their threshold: user pages after USER_PAGE_IDLE_MS,
 *  agent pages after BACKGROUND_PAGE_IDLE_MS. The unload keeps each page's URL
 *  so the panel restores it on the next show. */
export function reclaimIdleUserSessions<T extends PowerGuest>(host: {
  sessions: BrowserSessionRegistry;
  power: Pick<ReturnType<typeof createBrowserPagePower<T>>, 'isActive' | 'lastActiveAt'>;
  isBackgroundBusy(sessionId: string, name: string): boolean;
  unload(sessionId: string): void;
  now?: number;
}): void {
  const { sessions, power, now = Date.now() } = host;
  for (const sessionId of sessions.sessionIds()) {
    const background = [...sessions.backgroundPages(sessionId)];
    const pages = [
      ...sessions.visibleGuests(sessionId).map((guest) => [guest, USER_PAGE_IDLE_MS] as const),
      ...background
        .filter(([, page]) => !page.guest.isDestroyed())
        .map(([, page]) => [page.guest, page.kind === 'agent' ? BACKGROUND_PAGE_IDLE_MS : USER_PAGE_IDLE_MS] as const),
    ] as unknown as Array<readonly [T, number]>;
    if (!pages.length) continue;
    if (background.some(([name, page]) => page.keepAlive || host.isBackgroundBusy(sessionId, name))) continue;
    if (
      pages.some(
        ([guest, idleMs]) => power.isActive(guest) || !backgroundPageIdle(power.lastActiveAt(guest), now, idleMs)
      )
    ) {
      continue;
    }
    host.unload(sessionId);
  }
}
