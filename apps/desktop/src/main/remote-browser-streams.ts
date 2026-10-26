// Per-client pacing of a session's live Browser Use frames. The desktop's
// browser host produces one frame stream per session; each paired client
// subscribes to it, holds at most one unacknowledged frame in flight, and
// always receives the newest frame next — frames it was too slow for are
// dropped, never queued.
import type {
  DesktopRemoteBrowserStreamFrame,
  DesktopRemoteBrowserStreamOptions,
  DesktopRemoteBrowserViewport,
} from '../shared/contract';
import { REMOTE_BROWSER_FRAME_EVENT } from '../shared/remote-browser';

/** A frame is sent again after this long even if its ack never arrived. */
export const REMOTE_BROWSER_FRAME_ACK_TIMEOUT_MS = 1_500;
const ACK_TIMEOUT_MS = REMOTE_BROWSER_FRAME_ACK_TIMEOUT_MS;
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
  /** False while WebRTC owns this client's view: frames carry facts only. */
  images: boolean;
  /** A take-over subscriber that has not yet been sent a picture of the
   *  settled (fitted) layout: it is shown no picture until then. */
  awaitingFit: boolean;
  /** The subscription asked for a fit since its last release (it waits once). */
  fitAsked: boolean;
  /** The take-over's fit, held for the subscription's life (or until `fit: null`). */
  takeover: DesktopRemoteBrowserViewport | null;
}

/** A frame's facts with no picture described (as before a capture's first image). */
const withoutPicture = (frame: DesktopRemoteBrowserStreamFrame): DesktopRemoteBrowserStreamFrame => {
  const { image: _image, fitSettled: _settled, ...facts } = frame;
  return { ...facts, width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 };
};

/** A metadata-only frame carrying an earlier frame's image: settled only if both are. */
const withImageOf = (
  frame: DesktopRemoteBrowserStreamFrame,
  source: DesktopRemoteBrowserStreamFrame
): DesktopRemoteBrowserStreamFrame => {
  const { fitSettled: _settled, ...rest } = frame;
  const merged = { ...rest, image: source.image };
  return frame.fitSettled && source.fitSettled ? { ...merged, fitSettled: true } : merged;
};

export interface BrowserRemoteStreamsDeps {
  /** Whether the client is still attached to the relay. */
  isLive(clientId: string): boolean;
  /** One droppable encrypted push to that client only. */
  send(clientId: string, payload: { event: string; payload: DesktopRemoteBrowserStreamFrame }): Promise<void>;
  /** Start/renew (options) or stop (null) the desktop's screencast of a session. */
  request(sessionId: string, options: DesktopRemoteBrowserStreamOptions | null): Promise<unknown>;
  /** A client's subscription to a session ended (stop, lapse, or departure). */
  onDrop?(clientId: string, sessionId: string): void;
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
    let fit: DesktopRemoteBrowserStreamOptions['fit'];
    for (const { options, takeover } of subscriptions.values()) {
      maxWidth = Math.max(maxWidth, options.maxWidth);
      maxHeight = Math.max(maxHeight, options.maxHeight);
      // A take-over's fit: the earliest subscriber holding one (the desktop
      // applies a stream's first fit only).
      fit ??= takeover ?? undefined;
    }
    return fit ? { maxWidth, maxHeight, fit } : { maxWidth, maxHeight };
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
    void deps
      .send(clientId, { event: REMOTE_BROWSER_FRAME_EVENT, payload: shaped(subscription, frame) })
      .catch(() => undefined);
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
    deps.onDrop?.(clientId, sessionId);
  }

  /** What one client is sent of a frame: without its image while WebRTC owns its view. */
  const shaped = (subscription: Subscription, frame: DesktopRemoteBrowserStreamFrame) => {
    if (subscription.awaitingFit) {
      // A fit that failed ends the wait: the take-over falls back to watching.
      if (frame.fitFailed) subscription.awaitingFit = false;
      // Its facts (a dialog may hold the fit back) go out; no unfitted picture.
      else if (!frame.image || !frame.fitSettled) return withoutPicture(frame);
      else subscription.awaitingFit = false;
    }
    if (subscription.images || !frame.image) return frame;
    const { image: _image, ...facts } = frame;
    return facts;
  };

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
          images: true,
          awaitingFit: false,
          fitAsked: false,
          takeover: null,
        };
        subscriptions.set(clientId, subscription);
      }
      // Take-over intent lasts as long as the subscription: a renewal that
      // omits `fit` keeps it (no restore/re-fit flapping); only `fit: null`
      // (an explicit release) or the subscription's end ends it.
      const { fit, ...bound } = options;
      if (fit === null) {
        subscription.takeover = null;
        subscription.fitAsked = false;
        subscription.awaitingFit = false;
      } else if (fit) {
        subscription.takeover ??= fit;
      }
      // A take-over (first request with a fit) sees no picture until the
      // settled layout's first one, never the unfitted page before it.
      if (subscription.takeover && !subscription.fitAsked) {
        subscription.fitAsked = true;
        subscription.awaitingFit = true;
      }
      subscription.options = bound;
      armExpiry(sessionId, clientId, subscription);
      // Every renewal also keeps the desktop's own 4s lease alive.
      tell(sessionId, largest(subscriptions));
      const cached = latest.get(sessionId);
      if (isNew && cached) {
        subscription.slot = cached;
        flush(clientId, subscription);
      }
    },
    /** Whether the client holds a live subscription to the session. */
    subscribed(clientId: string, sessionId: string): boolean {
      return sessions.get(sessionId)?.has(clientId) === true;
    },
    /** A take-over subscriber not yet sent a picture of the settled (fitted)
     *  layout: its WebRTC view must not be promoted yet either. */
    awaitingFit(clientId: string, sessionId: string): boolean {
      return sessions.get(sessionId)?.get(clientId)?.awaitingFit === true;
    },
    /** Withhold (false) or resume (true) a client's images; resuming sends the
     *  newest picture at once, so the JPEG view comes back without a gap. */
    setImages(clientId: string, sessionId: string, enabled: boolean): void {
      const subscription = sessions.get(sessionId)?.get(clientId);
      if (!subscription || subscription.images === enabled) return;
      subscription.images = enabled;
      const cached = latest.get(sessionId);
      if (enabled && cached?.image) {
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
      latest.set(frame.sessionId, frame.image || !previous?.image ? frame : withImageOf(frame, previous));
      for (const [clientId, subscription] of [...subscriptions]) {
        if (!deps.isLive(clientId)) {
          drop(frame.sessionId, clientId);
          continue;
        }
        const waiting = subscription.slot;
        subscription.slot = frame.image || !waiting?.image ? frame : withImageOf(frame, waiting);
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
