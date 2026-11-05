/**
 * The main-workspace browser tabs a paired client lists: every live page whose
 * id carries the main-tab prefix, in the order first seen. While a client
 * watches, a change to any tab's title, address or loading state is published.
 */
import { MAIN_BROWSER_PAGE_PREFIX, type DesktopRemoteBrowserTab } from '../../shared/contract-browser';

/** Page events that can change a tab's title, address or loading state. */
const TAB_EVENTS = [
  'did-navigate',
  'did-navigate-in-page',
  'page-title-updated',
  'did-start-loading',
  'did-stop-loading',
] as const;

interface TabPage {
  isDestroyed(): boolean;
  getTitle(): string;
  getURL(): string;
  isLoadingMainFrame(): boolean;
}

/** The page events `observe` listens to; a Electron `WebContents` fits. */
interface ObservedPage {
  on(event: (typeof TAB_EVENTS)[number], listener: () => void): unknown;
  once(event: 'destroyed', listener: () => void): unknown;
}

export interface BrowserRemoteTabsDeps {
  /** Every session that currently owns a page. */
  sessionIds(): string[];
  liveGuest(sessionId: string): TabPage | null;
  publish(tabs: DesktopRemoteBrowserTab[]): Promise<void>;
}

export function createBrowserRemoteTabs(deps: BrowserRemoteTabsDeps) {
  const order: string[] = [];
  let watching = false;
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

  /** A page was created, changed or released. */
  function changed(): void {
    if (watching) check();
  }

  return {
    list,
    changed,
    /** A new page: its own events publish a change, and so does its closing. */
    observe(page: ObservedPage): void {
      for (const event of TAB_EVENTS) page.on(event, changed);
      page.once('destroyed', changed);
      changed();
    },
    /** Start or stop publishing; starting answers with the current list. */
    watch(on: boolean): DesktopRemoteBrowserTab[] {
      watching = on;
      const tabs = list();
      published = JSON.stringify(tabs);
      return tabs;
    },
    dispose(): void {
      watching = false;
    },
  };
}
