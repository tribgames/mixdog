// What the phone tells the core about its own screen: the same `ui/screenSessions/changed` notification the desktop sends, with
// the visibility rules applied here. The set is empty while the page is hidden or the app is in the background, so the core
// needs no phone-specific frames and decides "is the user already looking at this thread" for push suppression from this alone.
import type { ClientEvent, ConnectionStatus, Json } from '../../../packages/protocol-client/src/index.ts';

export const SCREEN_SESSIONS_CHANGED = 'ui/screenSessions/changed';

/** The browser id is at most this many UTF-16 units on the wire; the core clips longer ones. */
export const BROWSER_ID_MAX = 64;

export interface ScreenSource {
  /** The page is visible and the app is in the foreground. */
  active(): boolean;
  /** The threads the UI paints right now. */
  threads(): readonly string[];
  /** The id this phone's direct Web Push subscription is keyed by, once it has one. */
  browserId(): string | undefined;
}

/** The part of the protocol client the reporter needs. */
export interface ScreenSink {
  readonly status: ConnectionStatus;
  notify(method: string, params: Json): void;
  on(listener: (event: ClientEvent) => void): () => void;
}

export interface ScreenReporter {
  /** The page or the shown threads changed: send the new set if it differs from the last one the core has. */
  refresh(): void;
  stop(): void;
}

/**
 * Sends the set on every change, and once again whenever the connection becomes ready: a new connection starts with the core
 * knowing nothing about this phone's screen, so a reconnect must not wait for the next change.
 */
export function createScreenReporter(client: ScreenSink, source: ScreenSource): ScreenReporter {
  let sent: string | undefined;
  const send = (): void => {
    if (client.status.state !== 'ready') return;
    const sessionIds = source.active() ? [...new Set(source.threads())] : [];
    const browserId = source.browserId()?.slice(0, BROWSER_ID_MAX);
    const params = browserId ? { sessionIds, browserId } : { sessionIds };
    const key = JSON.stringify(params);
    if (key === sent) return;
    try {
      client.notify(SCREEN_SESSIONS_CHANGED, params);
      sent = key;
    } catch {
      // The connection dropped between the check and the send; the next ready sends it.
    }
  };
  const off = client.on((event) => {
    if (event.type !== 'status') return;
    if (event.status.state === 'ready') {
      sent = undefined;
      send();
    }
  });
  send();
  return { refresh: send, stop: off };
}
