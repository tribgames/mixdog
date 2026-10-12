/**
 * The main-workspace browser tabs a paired client lists: every live page whose
 * id carries the main-tab prefix, in the order first seen. While a client
 * watches, a change to any tab's title, address or loading state is published.
 */
import { MAIN_BROWSER_PAGE_PREFIX, type DesktopRemoteBrowserTab } from '../../shared/contract-browser';

/** How often a watched list is compared with the last published one. */
const TAB_WATCH_MS = 750;

interface TabPage {
  isDestroyed(): boolean;
  getTitle(): string;
  getURL(): string;
  isLoadingMainFrame(): boolean;
}

export interface BrowserRemoteTabsDeps {
  /** Every session that currently owns a page. */
  sessionIds(): string[];
  liveGuest(sessionId: string): TabPage | null;
  publish(tabs: DesktopRemoteBrowserTab[]): Promise<void>;
  watchMs?: number;
}

export function createBrowserRemoteTabs(deps: BrowserRemoteTabsDeps) {
  const order: string[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let published = '';

  function list(): DesktopRemoteBrowserTab[] {
    const live = new Map<string, TabPage>();
    for (const id of deps.sessionIds()) {
      if (!id.startsWith(MAIN_BROWSER_PAGE_PREFIX)) continue;
      const guest = deps.liveGuest(id);
      if (guest && !guest.isDestroyed()) live.set(id, guest);
    }
    for (let index = order.length - 1; index >= 0; index -= 1) {
      if (!live.has(order[index])) order.splice(index, 1);
    }
    for (const id of live.keys()) if (!order.includes(id)) order.push(id);
    return order.map((id) => {
      const guest = live.get(id) as TabPage;
      return { id, title: guest.getTitle(), url: guest.getURL(), loading: guest.isLoadingMainFrame() };
    });
  }

  /** Publish the list when it differs from the one clients last received. */
  function check(): void {
    const tabs = list();
    const signature = JSON.stringify(tabs);
    if (signature === published) return;
    published = signature;
    void deps.publish(tabs).catch(() => undefined);
  }

  return {
    list,
    /** A page was created or released: tell watchers without waiting for the poll. */
    changed(): void {
      if (timer) check();
    },
    /** Start or stop the watch; starting answers with the current list. */
    watch(on: boolean): DesktopRemoteBrowserTab[] {
      if (on && !timer) {
        timer = setInterval(check, deps.watchMs ?? TAB_WATCH_MS);
        timer.unref?.();
      } else if (!on && timer) {
        clearInterval(timer);
        timer = null;
      }
      const tabs = list();
      published = JSON.stringify(tabs);
      return tabs;
    },
    dispose(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
