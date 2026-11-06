// The sessions the user is looking at, sent to the core as `ui/screenSessions/changed` (DS §12): what Node's
// `isSessionOnScreen` answers (screen-sessions.ts) as one set. It changes with the page's paint report and with the
// window's visibility, minimize and focus; a reload, navigation or renderer crash clears the report and so the set.
import type { UiScreenSessionsChangedParams } from '../../../../../packages/protocol/src/index.ts';
import type { ProtocolConnection } from './connection';
import { screenSessionIds, watchScreenSessions, type ScreenWindow } from '../screen-sessions';

const WINDOW_EVENTS = ['show', 'hide', 'minimize', 'restore', 'focus', 'blur', 'closed'] as const;

export interface ScreenSessionsWindow extends ScreenWindow {
  on(event: (typeof WINDOW_EVENTS)[number], listener: () => void): unknown;
  removeListener(event: (typeof WINDOW_EVENTS)[number], listener: () => void): unknown;
}

/** Calls `listener` each time the link becomes ready: a reconnect is a new attach, and the core treats a detached UI
 *  as the empty set. Returns the stop. */
export function onProtocolAttached(
  protocol: Pick<ProtocolConnection, 'onEvent'>,
  listener: () => void
): () => void {
  let ready = false;
  return protocol.onEvent((event) => {
    if (event.type !== 'status') return;
    const next = (event as { status: { state: string } }).status.state === 'ready';
    if (next && !ready) listener();
    ready = next;
  });
}

/** Sends the window's on-screen set when the UI attaches (now, and again at every `attached`) and after each change
 *  of it. A send while the link is down is dropped; the next attach carries the current set. Returns the stop. */
export function publishScreenSessions(
  window: ScreenSessionsWindow,
  notify: (method: 'ui/screenSessions/changed', params: UiScreenSessionsChangedParams) => void,
  attached: (listener: () => void) => () => void
): () => void {
  let sent = '';
  const send = (force: boolean): void => {
    const sessionIds = screenSessionIds(window).sort();
    const key = JSON.stringify(sessionIds);
    if (!force && key === sent) return;
    sent = key;
    try {
      notify('ui/screenSessions/changed', { sessionIds });
    } catch {
      // Not connected: the attach that follows sends the set.
    }
  };
  const onChange = (): void => send(false);
  for (const event of WINDOW_EVENTS) window.on(event, onChange);
  const stopWatching = watchScreenSessions(window, onChange);
  const stopAttached = attached(() => send(true));
  send(true);
  return () => {
    stopAttached();
    stopWatching();
    if (!window.isDestroyed()) for (const event of WINDOW_EVENTS) window.removeListener(event, onChange);
  };
}
