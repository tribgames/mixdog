/**
 * Browser tab facts for the core (`hostState.browserTabs`): the core cannot
 * see Electron pages, so URL, title and loading changes of the main-workspace
 * tabs are sent as `host/state/set{section:'browserTabs', value:{tabs}}`.
 * `publish` is the browser host's `publishRemoteTabs`; while the host role is
 * held the tab watch runs, and the full list is sent again on every claim.
 */
import type { DesktopRemoteBrowserTab } from '../../shared/contract-browser';
import type { HostConnection } from './connection';

export const HOST_STATE_SET = 'host/state/set';

export interface BrowserTabsControl {
  /** The browser host's `remoteTabsWatch`: starting answers with the current list. */
  remoteTabsWatch(on: boolean): DesktopRemoteBrowserTab[];
}

export function createBrowserTabsReporter(connection: HostConnection, control: () => BrowserTabsControl) {
  const send = (tabs: DesktopRemoteBrowserTab[]): Promise<void> =>
    connection.request(HOST_STATE_SET, { section: 'browserTabs', value: { tabs } }).then(() => undefined);
  return {
    /** The browser host's `publishRemoteTabs`. */
    publish: send,
    start(): void {
      void send(control().remoteTabsWatch(true)).catch(() => undefined);
    },
    stop(): void {
      control().remoteTabsWatch(false);
    },
  };
}
