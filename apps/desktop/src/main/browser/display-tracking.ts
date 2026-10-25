/**
 * What displays a page: a mounted panel (reported per guest), a natively
 * presented view, or a remote viewer streaming the session's current page.
 * Page power follows that classification.
 */
import type { WebContents } from 'electron';
import { createBrowserPagePower } from './page-power';
import type { BrowserSessionRegistry } from './session-registry';

type DisplaySessions = Pick<
  BrowserSessionRegistry,
  'sessionIdForGuest' | 'currentGuest' | 'visibleGuests' | 'backgroundPages'
>;

export function createBrowserDisplayTracking(sessions: DisplaySessions) {
  const panelActiveGuests = new Set<WebContents>();
  const nativeShownGuests = new Map<string, WebContents>();
  const remoteViewingSessions = new Set<string>();
  const power = createBrowserPagePower<WebContents>({
    isDisplayed: (guest) => {
      if (panelActiveGuests.has(guest)) return true;
      if ([...nativeShownGuests.values()].includes(guest)) return true;
      const owner = sessions.sessionIdForGuest(guest);
      return owner !== undefined && remoteViewingSessions.has(owner) && sessions.currentGuest(owner) === guest;
    },
  });
  const refreshSession = (sessionId: string) => {
    for (const guest of sessions.visibleGuests(sessionId)) power.refresh(guest);
    for (const page of sessions.backgroundPages(sessionId).values()) power.refresh(page.guest);
  };
  /** On this PC's screen: a mounted panel or a native view shows it (a
   *  phone streaming the page is not the desktop panel). */
  const isShown = (guest: WebContents) =>
    panelActiveGuests.has(guest) || [...nativeShownGuests.values()].includes(guest);
  const shownWaiters = new Set<() => void>();
  const shownChanged = () => {
    for (const waiter of [...shownWaiters]) waiter();
  };

  return {
    power,
    /** A new page: power tracks it, and its panel report dies with it. */
    track(guest: WebContents): void {
      power.track(guest);
      guest.once('destroyed', () => panelActiveGuests.delete(guest));
    },
    /** A panel mounted or unmounted this page; a shown page restores first. */
    setPanelActive(guest: WebContents, active: boolean): void {
      if (active) panelActiveGuests.add(guest);
      else panelActiveGuests.delete(guest);
      power.refresh(guest);
      shownChanged();
    },
    setNativeShown(sessionId: string, guest: WebContents | null): void {
      if (guest) nativeShownGuests.set(sessionId, guest);
      else nativeShownGuests.delete(sessionId);
      refreshSession(sessionId);
      shownChanged();
    },
    isShown,
    /** Resolves true once a panel or native view shows `guest`, false at
     *  `timeoutMs` (or when `signal` aborts) if none did. */
    waitUntilShown(guest: WebContents, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
      if (isShown(guest)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const finish = (shown: boolean) => {
          clearTimeout(timer);
          shownWaiters.delete(check);
          signal?.removeEventListener('abort', abort);
          resolve(shown);
        };
        const check = () => {
          if (isShown(guest)) finish(true);
        };
        const abort = () => finish(false);
        const timer = setTimeout(() => finish(false), timeoutMs);
        shownWaiters.add(check);
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
    setRemoteViewing(sessionId: string, viewing: boolean): void {
      if (viewing) remoteViewingSessions.add(sessionId);
      else remoteViewingSessions.delete(sessionId);
      refreshSession(sessionId);
    },
    isRemoteViewing: (sessionId: string) => remoteViewingSessions.has(sessionId),
    /** Forget a released session's native and remote displays. */
    release(sessionId: string): void {
      nativeShownGuests.delete(sessionId);
      remoteViewingSessions.delete(sessionId);
    },
  };
}
