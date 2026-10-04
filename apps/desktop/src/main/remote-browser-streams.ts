// Per-client pacing of a session's live Browser Use frames. The desktop's
// browser host produces one frame stream per session; each paired client
// subscribes to it, holds at most one unacknowledged frame in flight, and
// always receives the newest frame next — frames it was too slow for are
// dropped, never queued.
import type { DesktopRemoteBrowserStreamFrame, DesktopRemoteBrowserStreamOptions } from '../shared/contract';
import { REMOTE_BROWSER_FRAME_EVENT } from '../shared/remote-browser';

/** A frame is sent again after this long even if its ack never arrived. */
const ACK_TIMEOUT_MS = 1_500;
/** A subscription not renewed within this window is dropped. */
const SUBSCRIPTION_EXPIRY_MS = 4_000;

interface Subscription {
  options: DesktopRemoteBrowserStreamOptions;
  expiry: ReturnType<typeof setTimeout>;
  /** The newest frame not yet sent: later frames replace it. */
  slot: DesktopRemoteBrowserStreamFrame | null;
  inflightSeq: number | null;
  sentAt: number;
  retry: ReturnType<typeof setTimeout> | null;
}

export interface BrowserRemoteStreamsDeps {
  /** Whether the client is still attached to the relay. */
  isLive(clientId: string): boolean;
  /** One droppable encrypted push to that client only. */
  send(clientId: string, payload: { event: string; payload: DesktopRemoteBrowserStreamFrame }): Promise<void>;
  /** Start/renew (options) or stop (null) the desktop's screencast of a session. */
  request(sessionId: string, options: DesktopRemoteBrowserStreamOptions | null): Promise<unknown>;
  ackTimeoutMs?: number;
  expiryMs?: number;
}

export function createBrowserRemoteStreams(deps: BrowserRemoteStreamsDeps) {
  const ackTimeoutMs = deps.ackTimeoutMs ?? ACK_TIMEOUT_MS;
  const expiryMs = deps.expiryMs ?? SUBSCRIPTION_EXPIRY_MS;
  const sessions = new Map<string, Map<string, Subscription>>();
  /** The latest frame per session, so a client joining a static page gets one. */
  const latest = new Map<string, DesktopRemoteBrowserStreamFrame>();

  const largest = (subscriptions: Map<string, Subscription>): DesktopRemoteBrowserStreamOptions => {
    let maxWidth = 0;
    let maxHeight = 0;
    for (const { options } of subscriptions.values()) {
      maxWidth = Math.max(maxWidth, options.maxWidth);
      maxHeight = Math.max(maxHeight, options.maxHeight);
    }
    return { maxWidth, maxHeight };
  };

  const tell = (sessionId: string, options: DesktopRemoteBrowserStreamOptions | null): void => {
    void deps.request(sessionId, options).catch(() => undefined);
  };

  function flush(clientId: string, subscription: Subscription): void {
    const frame = subscription.slot;
    if (!frame) return;
    const waiting = subscription.inflightSeq !== null ? subscription.sentAt + ackTimeoutMs - Date.now() : 0;
    if (waiting > 0) {
      if (!subscription.retry) {
        subscription.retry = setTimeout(() => {
          subscription.retry = null;
          flush(clientId, subscription);
        }, waiting);
        subscription.retry.unref?.();
      }
      return;
    }
    subscription.slot = null;
    subscription.inflightSeq = frame.seq;
    subscription.sentAt = Date.now();
    void deps.send(clientId, { event: REMOTE_BROWSER_FRAME_EVENT, payload: frame }).catch(() => undefined);
  }

  function drop(sessionId: string, clientId: string): void {
    const subscriptions = sessions.get(sessionId);
    const subscription = subscriptions?.get(clientId);
    if (!subscriptions || !subscription) return;
    clearTimeout(subscription.expiry);
    if (subscription.retry) clearTimeout(subscription.retry);
    subscriptions.delete(clientId);
    if (subscriptions.size === 0) {
      sessions.delete(sessionId);
      latest.delete(sessionId);
      tell(sessionId, null);
    } else {
      tell(sessionId, largest(subscriptions));
    }
  }

  function armExpiry(sessionId: string, clientId: string, subscription: Subscription): void {
    clearTimeout(subscription.expiry);
    subscription.expiry = setTimeout(() => drop(sessionId, clientId), expiryMs);
    subscription.expiry.unref?.();
  }

  return {
    /** Start or renew a client's subscription. */
    subscribe(clientId: string, sessionId: string, options: DesktopRemoteBrowserStreamOptions): void {
      let subscriptions = sessions.get(sessionId);
      if (!subscriptions) {
        subscriptions = new Map();
        sessions.set(sessionId, subscriptions);
      }
      let subscription = subscriptions.get(clientId);
      const isNew = !subscription;
      if (!subscription) {
        subscription = {
          options,
          expiry: setTimeout(() => undefined, 0),
          slot: null,
          inflightSeq: null,
          sentAt: 0,
          retry: null,
        };
        subscriptions.set(clientId, subscription);
      }
      subscription.options = options;
      armExpiry(sessionId, clientId, subscription);
      // Every renewal also keeps the desktop's own 4s lease alive.
      tell(sessionId, largest(subscriptions));
      const cached = latest.get(sessionId);
      if (isNew && cached) {
        subscription.slot = cached;
        flush(clientId, subscription);
      }
    },
    /** Stop a client's subscription. */
    unsubscribe(clientId: string, sessionId: string): void {
      drop(sessionId, clientId);
    },
    /** The client painted `seq`: its next (newest) frame may go out. */
    acknowledge(clientId: string, sessionId: string, seq: number): void {
      const subscription = sessions.get(sessionId)?.get(clientId);
      if (!subscription || subscription.inflightSeq !== seq) return;
      subscription.inflightSeq = null;
      if (subscription.retry) {
        clearTimeout(subscription.retry);
        subscription.retry = null;
      }
      flush(clientId, subscription);
    },
    /** A new frame from the desktop: every live subscriber's slot takes it. */
    publish(frame: DesktopRemoteBrowserStreamFrame): void {
      const subscriptions = sessions.get(frame.sessionId);
      if (!subscriptions) return;
      // A metadata-only frame inherits the newest image for anyone who has
      // not received it yet (a late joiner, or a slot still waiting).
      const previous = latest.get(frame.sessionId);
      latest.set(frame.sessionId, frame.image || !previous?.image ? frame : { ...frame, image: previous.image });
      for (const [clientId, subscription] of [...subscriptions]) {
        if (!deps.isLive(clientId)) {
          drop(frame.sessionId, clientId);
          continue;
        }
        const waiting = subscription.slot?.image;
        subscription.slot = frame.image || !waiting ? frame : { ...frame, image: waiting };
        flush(clientId, subscription);
      }
    },
    /** A client left the relay: everything it subscribed to ends. */
    dropClient(clientId: string): void {
      for (const sessionId of [...sessions.keys()]) drop(sessionId, clientId);
    },
    dispose(): void {
      for (const [sessionId, subscriptions] of [...sessions]) {
        for (const clientId of [...subscriptions.keys()]) drop(sessionId, clientId);
      }
    },
  };
}
