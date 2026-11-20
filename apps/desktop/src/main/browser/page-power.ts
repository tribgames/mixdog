/**
 * Power state of browser pages. A page runs at full speed only while a Browser
 * panel displays it or an agent command drives it; any other page is throttled
 * and stops producing frames. A session whose pages stay unused past the idle
 * threshold is unloaded through the session's unload-and-restore path.
 */
import type { WebContents } from 'electron';

import type { BrowserSessionRegistry } from './session-registry';
import { BACKGROUND_PAGE_IDLE_MS, backgroundPageIdle, FINISHED_TURN_PAGE_IDLE_MS } from './tab-policy';

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
    /** Whether an agent command is driving the page, shown or not. */
    isDriven: (guest: T) => (driving.get(guest) ?? 0) > 0,
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

/** Unload every session whose pages are all undisplayed, undriven, free of
 *  anything only the live document holds, and idle past the session's
 *  threshold: BACKGROUND_PAGE_IDLE_MS while a turn of it is live,
 *  FINISHED_TURN_PAGE_IDLE_MS otherwise, for every page alike. The unload
 *  keeps each tab and its URL (a kept page too), so the panel restores them on
 *  the next show; it cannot restore what was typed, a dialog, a download in
 *  progress, playing audio, a stored secret or a popup's link to its opener,
 *  so a session holding one stays loaded. */
export function reclaimIdleUserSessions<T extends PowerGuest>(host: {
  sessions: BrowserSessionRegistry;
  power: Pick<ReturnType<typeof createBrowserPagePower<T>>, 'isActive' | 'lastActiveAt'>;
  isBackgroundBusy(sessionId: string, name: string): boolean;
  /** The page holds state a reload loses: typing, a pending dialog or file
   *  chooser, audible media, a stored sensitive value. */
  holdsPage(guest: T): boolean;
  /** The session has a download in progress. */
  downloading(sessionId: string): boolean;
  unload(sessionId: string): void;
  now?: number;
}): void {
  const { sessions, power, now = Date.now() } = host;
  for (const sessionId of sessions.sessionIds()) {
    const background = [...sessions.backgroundPages(sessionId)].filter(([, page]) => !page.guest.isDestroyed());
    const pages = [...sessions.visibleGuests(sessionId), ...background.map(([, page]) => page.guest)] as unknown as T[];
    if (!pages.length) continue;
    // A turn that ended moments ago is usually continued by the next message.
    const finishedAt = sessions.turnFinishedAt(sessionId);
    if (finishedAt !== undefined && !backgroundPageIdle(finishedAt, now, FINISHED_TURN_PAGE_IDLE_MS)) continue;
    if (background.some(([name]) => host.isBackgroundBusy(sessionId, name))) continue;
    if (background.some(([, page]) => page.opener && !page.opener.isDestroyed())) continue;
    if (host.downloading(sessionId)) continue;
    const idleMs = sessions.turnLive(sessionId) ? BACKGROUND_PAGE_IDLE_MS : FINISHED_TURN_PAGE_IDLE_MS;
    if (
      pages.some(
        (guest) =>
          power.isActive(guest) || host.holdsPage(guest) || !backgroundPageIdle(power.lastActiveAt(guest), now, idleMs)
      )
    ) {
      continue;
    }
    host.unload(sessionId);
  }
}
