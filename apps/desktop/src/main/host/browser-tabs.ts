/**
 * Browser tab facts for the core (`hostState.browserTabs`): the core cannot
 * see Electron pages, so URL, title and loading changes of the main-workspace
 * tabs are sent as `host/state/set{key:'browserTabs', value:{tabs}}`.
 * `publish` is the browser host's `publishRemoteTabs`; while the host role is
 * held the tab watch runs, and the full list is sent again on every claim.
 */
import type { HostStateSetParams } from '../../../../../packages/protocol/src/index.ts';
import type { DesktopRemoteBrowserTab } from '../../shared/contract-browser';
import type { HostConnection } from './connection';

export const HOST_STATE_SET = 'host/state/set';

/** Every `host/state/set` goes out typed by the generated protocol: `{key, value}`. */
export function sendHostState(connection: HostConnection, params: HostStateSetParams): Promise<void> {
  return connection.request(HOST_STATE_SET, params).then(() => undefined);
}

export interface BrowserTabsControl {
  /** The browser host's `remoteTabsWatch`: starting answers with the current list. */
  remoteTabsWatch(on: boolean): DesktopRemoteBrowserTab[];
}

export function createBrowserTabsReporter(connection: HostConnection, control: () => BrowserTabsControl) {
  const send = (tabs: DesktopRemoteBrowserTab[]): Promise<void> =>
    // The copy is what makes each tab a plain JSON object for the generated `JsonValue`.
    sendHostState(connection, { key: 'browserTabs', value: { tabs: tabs.map((tab) => ({ ...tab })) } });
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
