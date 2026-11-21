import {
  REMOTE_WEBRTC_SIGNAL_EVENT,
  parseRemoteWebrtcClientSignal,
  parseRemoteWebrtcDesktopSignal,
  remoteWebrtcSourceKey,
  type RemoteWebrtcClientSignal,
  type RemoteWebrtcDesktopSignal,
  type RemoteWebrtcIceServer,
} from '../../shared/remote-webrtc';

interface Ownership {
  connectionId: string;
  /** The epoch `promote` named, until a `demote` supersedes it. */
  promoteEpoch: number | null;
  owner: 'relay' | 'channel' | 'none';
  /** The epoch `demote` named while owner is `none`. */
  demoteEpoch: number;
}

interface RemoteWebrtcRelayDeps {
  /** The client holds a live stream subscription of this browser session. */
  subscribed(clientId: string, sessionId: string): boolean;
  /** The client's subscription is a take-over still waiting for its first
   *  picture of the fitted layout (remote-browser-streams). */
  awaitingFit(clientId: string, sessionId: string): boolean;
  /** The whole-PC screen source is allowed for this signal's connection
   *  (`origin`, the relay connection that delivered it): the client id still
   *  names that connection, which is paired, E2EE-established and not unpaired
   *  (pairing is the approval; docs/remote-screen.md). */
  screenAuthorized(clientId: string, origin: RemoteWebrtcOrigin): Promise<boolean>;
  /** Withhold (false) or resume (true) that client's JPEG images of the session. */
  setImages(clientId: string, sessionId: string, enabled: boolean): void;
  resolveIceServers(): Promise<RTCIceServer[]>;
  /** To the window process: a phone signal (with the connection that
   *  delivered it), or the viewer's departure. */
  forward(
    clientId: string,
    signal: RemoteWebrtcClientSignal,
    iceServers: RemoteWebrtcIceServer[] | undefined,
    origin: RemoteWebrtcOrigin
  ): Promise<unknown>;
  viewerLeft(clientId: string, sourceKey: string): Promise<unknown>;
  /** The window's display list (RemoteScreenDisplaySummary[]). */
  screenDisplays(): Promise<unknown>;
  /** One encrypted, non-droppable push to that client. */
  send(clientId: string, payload: { event: string; payload: RemoteWebrtcDesktopSignal }): Promise<void>;
}

/** The relay connection a phone signal arrived on (its client state object),
 *  captured when the signal is decoded: a client id the relay reuses for a
 *  new connection names a different object. */
type RemoteWebrtcOrigin = object;

/** The signals whose order against relay input matters: they must reach the
 *  window behind every relay call decoded before them. */
export function remoteWebrtcSignalIsBarrier(signal: RemoteWebrtcClientSignal): boolean {
  return signal.type === 'promote-ack' || signal.type === 'demote-ack';
}

const toIceServers = (servers: RTCIceServer[]): RemoteWebrtcIceServer[] =>
  servers.map((server) => ({
    urls: Array.isArray(server.urls) ? [...server.urls] : [server.urls],
    ...(server.username === undefined ? {} : { username: server.username }),
    ...(typeof server.credential === 'string' ? { credential: server.credential } : {}),
  }));

/** The window promoted its connection: the epoch the phone's ack must carry. */
function promoteOwnership(entry: Ownership | undefined, signal: { connectionId: string; inputEpoch: number }): void {
  if (entry?.connectionId === signal.connectionId && entry.owner === 'relay') {
    entry.promoteEpoch = signal.inputEpoch;
  }
}

/** The window demoted its connection: relay input and JPEG return, the phone's ack settles it. */
function demoteOwnership(
  deps: Pick<RemoteWebrtcRelayDeps, 'setImages'>,
  entry: Ownership | undefined,
  signal: { connectionId: string; inputEpoch: number },
  clientId: string,
  sessionId: string | null
): void {
  if (entry?.connectionId !== signal.connectionId) return;
  // JPEG comes back at once; no page input until the phone's ack.
  if (entry.owner === 'channel' && sessionId) deps.setImages(clientId, sessionId, true);
  entry.owner = 'none';
  entry.promoteEpoch = null;
  entry.demoteEpoch = signal.inputEpoch;
}

/** A phone's ack settles the hand-over it answers: a promote-ack gives the
 *  page to the channel (JPEG stops), a demote-ack ends the entry. */
function settleAck(
  deps: Pick<RemoteWebrtcRelayDeps, 'setImages'>,
  ownership: Map<string, Ownership>,
  ownerKey: string,
  signal: RemoteWebrtcClientSignal,
  clientId: string,
  sessionId: string
): void {
  const entry = ownership.get(ownerKey);
  if (
    signal.type === 'promote-ack' &&
    entry?.owner === 'relay' &&
    entry.connectionId === signal.connectionId &&
    entry.promoteEpoch === signal.inputEpoch
  ) {
    entry.owner = 'channel';
    deps.setImages(clientId, sessionId, false);
  } else if (
    signal.type === 'demote-ack' &&
    entry?.owner === 'none' &&
    entry.connectionId === signal.connectionId &&
    entry.demoteEpoch === signal.inputEpoch
  ) {
    ownership.delete(ownerKey);
  }
}

const SCREEN_NOT_ALLOWED = 'Remote screen is not allowed for this device.';
const NOT_STREAMED = 'remote webrtc source is not streamed by this client.';
const SCREEN_REPLAY_LIMIT = 64;
const SCREEN_RESYNC = 'Screen signaling needs resynchronization. Reconnect before starting another screen viewer.';

class ScreenReplay {
  // Attempt IDs are unique within the authenticated origin, but execution
  // order is not guaranteed. Only known cancellations enter the exact ranges.
  private readonly starts = new Map<number, string>();
  private readonly retired: { first: number; last: number }[] = [];
  private readonly earlyCloses: { sourceKey: string; id: number }[] = [];
  private needsResync = false;

  allowsReady(sourceKey: string, id: number): boolean {
    if (this.isRetired(id)) return false;
    const start = this.starts.get(id);
    if (start !== undefined) return start === sourceKey;
    const early = this.earlyCloses.findIndex((close) => close.sourceKey === sourceKey && close.id === id);
    if (early !== -1) {
      this.earlyCloses.splice(early, 1);
      this.retire(id);
      return false;
    }
    this.reserve();
    this.starts.set(id, sourceKey);
    return true;
  }

  cancel(sourceKey: string, id: number): void {
    if (this.isRetired(id)) return;
    const start = this.starts.get(id);
    if (start !== undefined) {
      if (start === sourceKey) {
        this.starts.delete(id);
        this.retire(id);
      }
    } else if (!this.earlyCloses.some((close) => close.sourceKey === sourceKey && close.id === id)) {
      this.reserve();
      this.earlyCloses.push({ sourceKey, id });
    }
  }

  private isRetired(id: number): boolean {
    return this.retired.some(({ first, last }) => first <= id && id <= last);
  }

  private retire(id: number): void {
    // Replaces an existing slot; merging adjacent IDs never fills a hole.
    let first = id;
    let last = id;
    for (let i = this.retired.length - 1; i >= 0; i--) {
      const range = this.retired[i];
      if (range.first > id + 1 || range.last + 1 < id) continue;
      first = Math.min(first, range.first);
      last = Math.max(last, range.last);
      this.retired.splice(i, 1);
    }
    this.retired.push({ first, last });
  }

  private reserve(): void {
    if (this.needsResync || this.starts.size + this.retired.length + this.earlyCloses.length >= SCREEN_REPLAY_LIMIT) {
      // An unmatched close may no longer be recorded. Never admit a new ID
      // on this origin again; the RPC error asks for a fresh authenticated
      // connection. Repeats and closes for known viewers still work.
      this.needsResync = true;
      throw new Error(SCREEN_RESYNC);
    }
  }
}

export function createRemoteWebrtcRelay(deps: RemoteWebrtcRelayDeps) {
  const ownership = new Map<string, Ownership>();
  /** The `ready` per client × source still resolving its ICE servers; a newer
   *  `ready` or the viewer's departure makes an older one stale. */
  const attempts = new Map<string, { viewerAttempt?: number; origin: RemoteWebrtcOrigin }>();
  const screenReplays = new Map<string, WeakMap<RemoteWebrtcOrigin, ScreenReplay>>();
  const key = (clientId: string, sourceKey: string) => `${clientId}\u0000${sourceKey}`;
  const sessionOf = (signal: { source: RemoteWebrtcClientSignal['source'] }): string | null =>
    signal.source.kind === 'browser' ? signal.source.sessionId : null;

  function screenReplay(clientId: string, origin: RemoteWebrtcOrigin): ScreenReplay {
    let byOrigin = screenReplays.get(clientId);
    if (!byOrigin) {
      byOrigin = new WeakMap();
      screenReplays.set(clientId, byOrigin);
    }
    let replay = byOrigin.get(origin);
    if (!replay) {
      replay = new ScreenReplay();
      byOrigin.set(origin, replay);
    }
    return replay;
  }

  function release(clientId: string, sourceKey: string, sessionId: string | null): void {
    const k = key(clientId, sourceKey);
    const entry = ownership.get(k);
    ownership.delete(k);
    if (entry?.owner === 'channel' && sessionId) deps.setImages(clientId, sessionId, true);
  }

  async function requireScreen(clientId: string, origin: RemoteWebrtcOrigin): Promise<void> {
    if (!(await deps.screenAuthorized(clientId, origin))) throw new TypeError(SCREEN_NOT_ALLOWED);
  }

  async function forwardAttemptClose(
    clientId: string,
    signal: Extract<RemoteWebrtcClientSignal, { type: 'close'; viewerAttempt: number }>,
    origin: RemoteWebrtcOrigin
  ): Promise<void> {
    const sourceKey = remoteWebrtcSourceKey(signal.source);
    const k = key(clientId, sourceKey);
    const replay = screenReplay(clientId, origin);
    await requireScreen(clientId, origin);
    // The connection may have left during authorization.
    if (screenReplays.get(clientId)?.get(origin) !== replay) return;
    const pending = attempts.get(k);
    const matches = pending?.origin === origin && pending?.viewerAttempt === signal.viewerAttempt;
    replay.cancel(sourceKey, signal.viewerAttempt);
    if (matches) attempts.delete(k);
    await deps.forward(clientId, signal, undefined, origin);
  }

  async function forwardPeerSignal(
    clientId: string,
    signal: Exclude<RemoteWebrtcClientSignal, { type: 'ready' }>,
    origin: RemoteWebrtcOrigin
  ): Promise<void> {
    if (signal.source.kind === 'screen') await requireScreen(clientId, origin);
    if (
      signal.type === 'media-ready' &&
      signal.source.kind === 'browser' &&
      deps.awaitingFit(clientId, signal.source.sessionId)
    ) {
      return;
    }
    await deps.forward(clientId, signal, undefined, origin);
  }

  async function forwardReady(
    clientId: string,
    signal: Extract<RemoteWebrtcClientSignal, { type: 'ready' }>,
    origin: RemoteWebrtcOrigin
  ): Promise<void> {
    const sourceKey = remoteWebrtcSourceKey(signal.source);
    const k = key(clientId, sourceKey);
    // The attempt is registered before anything is awaited, so the order
    // `ready`s were decoded in decides which one is current.
    const attempt = { viewerAttempt: signal.viewerAttempt, origin };
    if (
      signal.viewerAttempt !== undefined &&
      !screenReplay(clientId, origin).allowsReady(sourceKey, signal.viewerAttempt)
    ) {
      return;
    }
    const pending = attempts.get(k);
    if (pending && pending.origin === origin && (pending.viewerAttempt ?? 0) > (signal.viewerAttempt ?? 0)) return;
    attempts.set(k, attempt);
    // The viewer may leave (a forwarded `ready` would recreate it) or a
    // newer `ready` take over at every await: this one is then dropped.
    const current = (): boolean => attempts.get(k) === attempt;
    const sessionId = sessionOf(signal);
    const authorized = async (): Promise<boolean> =>
      sessionId === null ? deps.screenAuthorized(clientId, origin) : deps.subscribed(clientId, sessionId);
    const refuse = (): never => {
      attempts.delete(k);
      throw new TypeError(sessionId === null ? SCREEN_NOT_ALLOWED : NOT_STREAMED);
    };
    if (sessionId === null) {
      const allowed = await authorized();
      if (!current()) return;
      if (!allowed) refuse();
    }
    // Fresh per connection attempt (the credential cache decides reuse).
    const iceServers = toIceServers(await deps.resolveIceServers());
    if (!current()) return;
    const allowed = await authorized();
    if (!current()) return;
    if (!allowed) refuse();
    attempts.delete(k);
    await deps.forward(clientId, signal, iceServers, origin);
  }

  return {
    /** Decode-time step of a phone's signal (throws on an invalid or unauthorized one). */
    accept(clientId: string, raw: unknown): RemoteWebrtcClientSignal {
      const signal = parseRemoteWebrtcClientSignal(raw);
      const sessionId = sessionOf(signal);
      // A screen source is authorized in `forward`, for the connection that
      // delivered it; it has no relay input or JPEG view to gate here.
      if (sessionId === null) return signal;
      if (!deps.subscribed(clientId, sessionId)) throw new TypeError(NOT_STREAMED);
      settleAck(deps, ownership, key(clientId, remoteWebrtcSourceKey(signal.source)), signal, clientId, sessionId);
      return signal;
    },

    /** Execution step: hand the signal to the window, a `ready` with the ICE
     *  servers. A screen signal is authorized and forwarded for `origin` only;
     *  a screen resync error needs a fresh authenticated connection. */
    async forward(clientId: string, signal: RemoteWebrtcClientSignal, origin: RemoteWebrtcOrigin): Promise<void> {
      if (signal.type === 'ready') return forwardReady(clientId, signal, origin);
      if (signal.type === 'close' && 'viewerAttempt' in signal) return forwardAttemptClose(clientId, signal, origin);
      return forwardPeerSignal(clientId, signal, origin);
    },

    /** A window signal to its phone. */
    async send(clientId: string, raw: unknown): Promise<void> {
      const signal = parseRemoteWebrtcDesktopSignal(raw);
      const sessionId = sessionOf(signal);
      const sourceKey = remoteWebrtcSourceKey(signal.source);
      const k = key(clientId, sourceKey);
      if (signal.type === 'offer') {
        release(clientId, sourceKey, sessionId);
        ownership.set(k, { connectionId: signal.connectionId, promoteEpoch: null, owner: 'relay', demoteEpoch: 0 });
      } else if (signal.type === 'promote') {
        promoteOwnership(ownership.get(k), signal);
      } else if (signal.type === 'demote') {
        demoteOwnership(deps, ownership.get(k), signal, clientId, sessionId);
      } else if (signal.type === 'close') {
        if (ownership.get(k)?.connectionId === signal.connectionId) release(clientId, sourceKey, sessionId);
      }
      await deps.send(clientId, { event: REMOTE_WEBRTC_SIGNAL_EVENT, payload: signal });
    },

    /** The displays a client may choose, once its connection's screen access is checked. */
    async screenDisplays(clientId: string, origin: RemoteWebrtcOrigin): Promise<unknown> {
      await requireScreen(clientId, origin);
      return deps.screenDisplays();
    },

    /** Whether this client's relay page input for the session may run now. */
    relayInputAllowed(clientId: string, sessionId: string): boolean {
      const owner = ownership.get(key(clientId, remoteWebrtcSourceKey({ kind: 'browser', sessionId })))?.owner;
      return owner !== 'channel' && owner !== 'none';
    },

    /** The client's connection left the relay registry: its screen `ready`s
     *  still resolving are cancelled (dropped, never forwarded). */
    connectionRemoved(clientId: string): void {
      const prefix = key(clientId, 'screen:');
      for (const k of [...attempts.keys()]) if (k.startsWith(prefix)) attempts.delete(k);
      screenReplays.delete(clientId);
    },

    /** The client stopped streaming the session (or left the relay). */
    viewerLeft(clientId: string, sessionId: string): void {
      const sourceKey = remoteWebrtcSourceKey({ kind: 'browser', sessionId });
      release(clientId, sourceKey, sessionId);
      attempts.delete(key(clientId, sourceKey));
      void deps.viewerLeft(clientId, sourceKey).catch(() => undefined);
    },
  };
}
