/**
 * Service (daemon) end of the WebRTC signaling: validates a phone's signal,
 * checks the client streams the source it names, forwards it to the window
 * process, and carries the window's signals to that one phone.
 *
 * It also mirrors the input-ownership barrier at the point where relay frames
 * are decoded in order: from a decoded `promote-ack` until the matching
 * `demote-ack`, the client's relay page input for that source is refused, and
 * its JPEG images are withheld while the channel owns the view.
 */
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

export interface RemoteWebrtcRelayDeps {
  /** The client holds a live stream subscription of this browser session. */
  subscribed(clientId: string, sessionId: string): boolean;
  /** The client's subscription is a take-over still waiting for its first
   *  picture of the fitted layout (remote-browser-streams). */
  awaitingFit(clientId: string, sessionId: string): boolean;
  /** The whole-PC screen source is allowed for this client: the switch is on
   *  and the paired client holds a grant (remote-screen/screen-permission.ts). */
  screenAuthorized(clientId: string): Promise<boolean>;
  /** Withhold (false) or resume (true) that client's JPEG images of the session. */
  setImages(clientId: string, sessionId: string, enabled: boolean): void;
  resolveIceServers(): Promise<RTCIceServer[]>;
  /** To the window process: a phone signal, or the viewer's departure. */
  forward(clientId: string, signal: RemoteWebrtcClientSignal, iceServers?: RemoteWebrtcIceServer[]): Promise<unknown>;
  viewerLeft(clientId: string, sourceKey: string): Promise<unknown>;
  /** The window's display list (RemoteScreenDisplaySummary[]). */
  screenDisplays(): Promise<unknown>;
  /** One encrypted, non-droppable push to that client. */
  send(clientId: string, payload: { event: string; payload: RemoteWebrtcDesktopSignal }): Promise<void>;
}

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

export function createRemoteWebrtcRelay(deps: RemoteWebrtcRelayDeps) {
  const ownership = new Map<string, Ownership>();
  /** The `ready` per client × source still resolving its ICE servers; a newer
   *  `ready` or the viewer's departure makes an older one stale. */
  const attempts = new Map<string, number>();
  let attemptSerial = 0;
  const key = (clientId: string, sourceKey: string) => `${clientId}\u0000${sourceKey}`;
  const sessionOf = (signal: { source: RemoteWebrtcClientSignal['source'] }): string | null =>
    signal.source.kind === 'browser' ? signal.source.sessionId : null;

  function release(clientId: string, sourceKey: string, sessionId: string | null): void {
    const k = key(clientId, sourceKey);
    const entry = ownership.get(k);
    ownership.delete(k);
    if (entry?.owner === 'channel' && sessionId) deps.setImages(clientId, sessionId, true);
  }

  return {
    /** Decode-time step of a phone's signal (throws on an invalid or unauthorized one). */
    accept(clientId: string, raw: unknown): RemoteWebrtcClientSignal {
      const signal = parseRemoteWebrtcClientSignal(raw);
      const sessionId = sessionOf(signal);
      // A screen source is authorized where it executes (the grant is read
      // from disk); it has no relay input or JPEG view to gate here.
      if (sessionId === null) return signal;
      if (!deps.subscribed(clientId, sessionId)) {
        throw new TypeError('remote webrtc source is not streamed by this client.');
      }
      const entry = ownership.get(key(clientId, remoteWebrtcSourceKey(signal.source)));
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
        ownership.delete(key(clientId, remoteWebrtcSourceKey(signal.source)));
      }
      return signal;
    },

    /** Execution step: hand the signal to the window, a `ready` with the ICE servers. */
    async forward(clientId: string, signal: RemoteWebrtcClientSignal): Promise<void> {
      if (signal.type !== 'ready') {
        if (signal.source.kind === 'screen' && !(await deps.screenAuthorized(clientId))) {
          throw new TypeError('Remote screen is not allowed for this device.');
        }
        // A take-over is promoted only after its first picture of the fitted
        // layout went out: by then the source's current geometry is the fitted
        // generation, and the window promotes only on a media-ready for the
        // current one. Earlier ones are dropped; the phone re-sends.
        if (
          signal.type === 'media-ready' &&
          signal.source.kind === 'browser' &&
          deps.awaitingFit(clientId, signal.source.sessionId)
        ) {
          return;
        }
        await deps.forward(clientId, signal);
        return;
      }
      // The attempt is registered before anything is awaited, so the order
      // `ready`s were decoded in decides which one is current.
      const k = key(clientId, remoteWebrtcSourceKey(signal.source));
      attemptSerial += 1;
      const attempt = attemptSerial;
      attempts.set(k, attempt);
      // The viewer may leave (a forwarded `ready` would recreate it) or a
      // newer `ready` take over at every await: this one is then dropped.
      const current = (): boolean => attempts.get(k) === attempt;
      const sessionId = sessionOf(signal);
      const authorized = async (): Promise<boolean> =>
        sessionId === null ? deps.screenAuthorized(clientId) : deps.subscribed(clientId, sessionId);
      const refuse = (): never => {
        attempts.delete(k);
        throw new TypeError(
          sessionId === null
            ? 'Remote screen is not allowed for this device.'
            : 'remote webrtc source is not streamed by this client.'
        );
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
      await deps.forward(clientId, signal, iceServers);
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
        const entry = ownership.get(k);
        if (entry?.connectionId === signal.connectionId && entry.owner === 'relay') {
          entry.promoteEpoch = signal.inputEpoch;
        }
      } else if (signal.type === 'demote') {
        const entry = ownership.get(k);
        if (entry?.connectionId === signal.connectionId) {
          // JPEG comes back at once; no page input until the phone's ack.
          if (entry.owner === 'channel' && sessionId) deps.setImages(clientId, sessionId, true);
          entry.owner = 'none';
          entry.promoteEpoch = null;
          entry.demoteEpoch = signal.inputEpoch;
        }
      } else if (signal.type === 'close') {
        if (ownership.get(k)?.connectionId === signal.connectionId) release(clientId, sourceKey, sessionId);
      }
      await deps.send(clientId, { event: REMOTE_WEBRTC_SIGNAL_EVENT, payload: signal });
    },

    /** The displays a client may choose, once its screen access is checked. */
    async screenDisplays(clientId: string): Promise<unknown> {
      if (!(await deps.screenAuthorized(clientId))) throw new TypeError('Remote screen is not allowed for this device.');
      return deps.screenDisplays();
    },

    /** Whether this client's relay page input for the session may run now. */
    relayInputAllowed(clientId: string, sessionId: string): boolean {
      const owner = ownership.get(key(clientId, remoteWebrtcSourceKey({ kind: 'browser', sessionId })))?.owner;
      return owner !== 'channel' && owner !== 'none';
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

export type RemoteWebrtcRelay = ReturnType<typeof createRemoteWebrtcRelay>;
