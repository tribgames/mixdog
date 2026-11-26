// What main does with the core's pushes that no window shows: a change of the settings it applies itself (keep-awake,
// tray, computer and browser switches) and a deleted thread whose browser session it holds.
import type { DesktopSettings } from '../shared/contract';
import type { ProtocolConnection } from './protocol/connection';
import { hasConfigStub, readSettings, withPagedConfig } from './protocol/section-reads';

/** The `config` subtrees `desktopSettingsFromConfig` reads. */
const SETTINGS_SUBTREES: ReadonlySet<string> = new Set(['desktop', 'agent']);

export interface CoreObserversOptions {
  connection: Pick<ProtocolConnection, 'onStoreChange' | 'onEvent' | 'snapshot' | 'call'>;
  applyDesktopSettings(settings: DesktopSettings): void;
  releaseBrowserSession(sessionId: string): void;
  forgetSuspendedBrowserSession?(sessionId: string): void;
}

/** Returns the removal of both observers. */
export function observeCoreForMain({
  connection,
  applyDesktopSettings,
  releaseBrowserSession,
  forgetSuspendedBrowserSession,
}: CoreObserversOptions): () => void {
  // Each settings change supersedes the paged read still in flight, which would otherwise overwrite newer values.
  let latest = 0;
  let closed = false;
  const offStore = connection.onStoreChange((change) => {
    if (
      change.type !== 'section' ||
      change.section !== 'config' ||
      typeof change.key !== 'string' ||
      !SETTINGS_SUBTREES.has(change.key)
    )
      return;
    const mine = ++latest;
    const held = connection.snapshot();
    if (!hasConfigStub(held, [...SETTINGS_SUBTREES])) return applyDesktopSettings(readSettings(held));
    // A subtree over the inline limit arrives as a stub: it is read in full before the settings are applied.
    void withPagedConfig(held, (method, params) => connection.call(method, params), [...SETTINGS_SUBTREES]).then(
      (snapshot) => {
        if (!closed && mine === latest) applyDesktopSettings(readSettings(snapshot));
      },
      () => undefined
    );
  });
  const offEvent = connection.onEvent((event) => {
    if (event.type !== 'notification') return;
    const { notification } = event as { notification: { method: string; params?: unknown } };
    const threadId = (notification.params as { threadId?: unknown } | undefined)?.threadId;
    if (typeof threadId !== 'string' || !threadId) return;
    if (notification.method === 'thread/deleted') releaseBrowserSession(threadId);
    else if (notification.method === 'thread/archived' || notification.method === 'thread/closed') {
      forgetSuspendedBrowserSession?.(threadId);
    }
  });
  return () => {
    closed = true;
    offStore();
    offEvent();
  };
}
