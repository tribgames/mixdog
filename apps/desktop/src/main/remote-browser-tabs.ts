// Which paired clients watch the main-workspace browser tab list. The window
// process polls the list only while somebody watches; every change it reports
// is pushed to each live watcher as a full snapshot.
import type { DesktopRemoteBrowserTab } from '../shared/contract';
import { REMOTE_BROWSER_TABS_EVENT } from '../shared/remote-browser';

export interface BrowserRemoteTabsDeps {
  isLive(clientId: string): boolean;
  send(clientId: string, payload: { event: string; payload: DesktopRemoteBrowserTab[] }): Promise<void>;
  /** Start (true) or stop (false) the window process's watch; answers the current list. */
  request(on: boolean): Promise<unknown>;
}

export function createBrowserRemoteTabSubscribers(deps: BrowserRemoteTabsDeps) {
  const watchers = new Set<string>();

  const release = (clientId: string): void => {
    if (!watchers.delete(clientId) || watchers.size > 0) return;
    void deps.request(false).catch(() => undefined);
  };

  return {
    /** Start or stop one client's watch; starting answers with the current list. */
    async watch(clientId: string, on: boolean): Promise<DesktopRemoteBrowserTab[]> {
      if (!on) {
        release(clientId);
        return [];
      }
      watchers.add(clientId);
      try {
        return (await deps.request(true)) as DesktopRemoteBrowserTab[];
      } catch (error) {
        release(clientId);
        throw error;
      }
    },
    publish(tabs: DesktopRemoteBrowserTab[]): void {
      for (const clientId of [...watchers]) {
        if (!deps.isLive(clientId)) {
          release(clientId);
          continue;
        }
        void deps.send(clientId, { event: REMOTE_BROWSER_TABS_EVENT, payload: tabs }).catch(() => undefined);
      }
    },
    dropClient: release,
    dispose(): void {
      watchers.clear();
    },
  };
}
