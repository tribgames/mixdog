// What main does with the core's pushes that no window shows: a change of the settings it applies itself (keep-awake,
// tray, computer and browser switches) and a deleted thread whose browser session it holds.
import type { DesktopSettings } from '../shared/contract';
import type { ProtocolConnection } from './protocol/connection';
import { readSettings } from './protocol/section-reads';

/** The `config` subtrees `desktopSettingsFromConfig` reads. */
const SETTINGS_SUBTREES: ReadonlySet<string | null> = new Set(['desktop', 'agent']);

export interface CoreObserversOptions {
  connection: Pick<ProtocolConnection, 'onStoreChange' | 'onEvent' | 'snapshot'>;
  applyDesktopSettings(settings: DesktopSettings): void;
  releaseBrowserSession(sessionId: string): void;
}

/** Returns the removal of both observers. */
export function observeCoreForMain({ connection, applyDesktopSettings, releaseBrowserSession }: CoreObserversOptions): () => void {
  const offStore = connection.onStoreChange((change) => {
    if (change.type !== 'section' || change.section !== 'config' || !SETTINGS_SUBTREES.has(change.key ?? null)) return;
    applyDesktopSettings(readSettings(connection.snapshot()));
  });
  // A thread removed from the app feed arrives as the `thread/deleted` notification (the store keeps no row for it).
  const offEvent = connection.onEvent((event) => {
    if (event.type !== 'notification') return;
    const { notification } = event as { notification: { method: string; params?: unknown } };
    if (notification.method !== 'thread/deleted') return;
    const threadId = (notification.params as { threadId?: unknown } | undefined)?.threadId;
    if (typeof threadId === 'string' && threadId) releaseBrowserSession(threadId);
  });
  return () => {
    offStore();
    offEvent();
  };
}
