// Relay client for the installable web app: the desktop dials OUT to
// apps/relay/server.mjs and answers browser RPC frames, so a phone anywhere
// on the internet reaches this machine without port forwarding.
import WebSocket from 'ws';

import type {
  DesktopBrowserImportProgress,
  DesktopRemoteBrowserStreamFrame,
  DesktopRemoteBrowserTab,
  DesktopRemoteClientInfo,
} from '../shared/contract';
import { REMOTE_BROWSER_IMPORT_PROGRESS_EVENT } from '../shared/remote-browser';
import { createBrowserRemoteStreams } from './remote-browser-streams';
import { createBrowserRemoteTabSubscribers } from './remote-browser-tabs';
import { loadOrCreatePairingToken } from './remote-pairing-token';
import { relayE2EEPairingMaterial, type RelayE2EEPairingMaterial } from '../shared/remote-e2ee';
import { createRemoteByteMeter } from '../shared/remote-performance';
import { createRemoteCallStats, reportRemoteByteWindow } from './remote-performance-diagnostics';
import {
  RELAY_FRAME_TOO_LARGE,
  RELAY_ROUTING_CAPS_EVENT,
  readRelayPayloadRejection,
  readRelayUplinkCeilings,
  relayFrameByteLength,
  relayFrameCallId,
  relayFrameRefusal,
  relayPayloadRejectedFrame,
  relayUplinkCeilingFields,
  relayUplinkContract,
  resolveRelayFrameLimit,
  type RelayUplinkCeilings,
} from '../shared/remote-payload-limit';
import { createRemoteMethods, type RemoteMethodDependencies } from './remote-methods';
export { remoteTranscriptSnapshot } from './remote-transcript';
import { createNativePushStore, type NativePushSubscription } from './native-push-store';
import type { NativePushMessage } from './push-notifier';
import { createPushSubscriptionStore } from './push-subscription-store';
import { loadOrCreateRelayE2EEIdentity } from './remote-e2ee';
import type { RemoteClaimDecision, RemoteClientClaim } from './remote-relay-claim';
import { createRelayClientLifecycle } from './remote-relay-client-lifecycle';
import { createRelayCatalogs } from './remote-relay-catalog';
import { createRelayClientCallDispatch } from './remote-relay-client-calls';
import { createRelayClientRegistry, type RelayClientState } from './remote-relay-clients';
import { createRelayControlRequests } from './remote-relay-control';
import { createRelayEnvelopeDispatcher } from './remote-relay-envelope';
import {
  createRevocationDrain,
  loadOrCreateDevice,
  relayClientUrl,
  relayDeviceSocketOptions,
  revokeDeviceOverSocket,
  validatedRelayUrl,
} from './remote-relay-device';
import { createRelayMediaLane } from './remote-relay-media';
import { createRelaySessionStateFanout } from './remote-relay-session-state';
import { viewIsStale } from './remote-view-staleness';
import { createRelaySessionWiring } from './remote-relay-session-wiring';
// @ts-expect-error Relay framing is shared with the plain-ESM VPS server.
import { decodeRelayBinaryFrame, encodeRelayBinaryFrame } from '../../../relay/lib/relay-binary-frame.mjs';

export { resolveRelayUrl, rotateRemoteDevice } from './remote-relay-device';
export type { RemoteClaimDecision, RemoteClientClaim } from './remote-relay-claim';
export { clientReadsLane } from './remote-relay-clients';
export { encodeRelayClientSessionState } from './remote-relay-session-state';

// Transport cap for ONE message on this leg. It sits above the relay's 64 MiB
// policy ceiling on purpose: a policy-sized phone frame arrives here wrapped in
// the relay's fixed 42-byte routing header, and a transport that stopped at the
// policy number would kill the socket (1009) over the wrapper alone. The text
// flag keeps that wrapper fixed — JSON escaping is no longer in this path — so
// a small, constant headroom is all it takes.
const MAX_WS_PAYLOAD_BYTES = 68 * 1024 * 1024;

interface RemoteRelayOptions extends RemoteMethodDependencies {
  /** ws(s)://relay-host[:port] */
  relayUrl: string;
  userDataPath: string;
  /** This build's version, reported when the device leg connects so the relay
   *  serves paired browsers the matching web renderer release. Omitted by
   *  callers that cannot name it; the relay then treats this desktop as legacy. */
  appVersion?: string;
  /** Renderer release id (shell version hash) when this build knows it. */
  rendererRelease?: string;
  subscribeTerminalData?: (listener: (event: { id: string; data: string }) => void) => () => void;
  onClientCountChanged?: () => void;
  /** The relay refused an oversize frame this desktop sent and could not say
   *  which client it belonged to. Reported so the user sees it; it names no
   *  call and reaches no phone, because either would blame the wrong one. */
  onRelayPayloadRefused?: (detail: { bytes: number | null; limit: number | null }) => void;
  /** Ask the user to approve one credential-less container. Resolving false
   *  (or throwing) denies it; the relay never decides this. */
  onClientClaim?: (claim: RemoteClientClaim) => Promise<RemoteClaimDecision>;
}

export interface RemoteRelayHandle {
  /** URL a phone opens: the relay origin plus this desktop's device route. */
  clientUrl: string;
  token: string;
  pairing: RelayE2EEPairingMaterial;
  readonly clientCount: number;
  /** A live Browser Use frame from the desktop, paced to each subscribed client. */
  publishBrowserFrame(frame: DesktopRemoteBrowserStreamFrame): void;
  /** The main-workspace browser tab list, pushed to every watching client. */
  publishBrowserTabs(tabs: DesktopRemoteBrowserTab[]): void;
  publishBrowserImportProgress(progress: DesktopBrowserImportProgress): void;
  listClients(): Promise<DesktopRemoteClientInfo[]>;
  revokeClient(clientId: string): Promise<void>;
  /** System resume: the socket is likely half-dead after sleep — drop it and
   *  redial immediately instead of waiting for the ping cycle to notice. */
  resume(): void;
  /** Delete this install's authenticated registration from the relay. */
  revoke(): Promise<void>;
  close(): Promise<void>;
}

/** Idle NAT paths silently kill this leg; protocol pings keep it warm and
 *  detect a half-dead socket so the reconnect loop restores it long before a
 *  phone RPC would hang on it. Any traffic counts as proof of life, so a busy
 *  leg is never terminated for missing a pong. */
function startRelayHeartbeat(ws: WebSocket): { markAlive(): void; stop(): void } {
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      try {
        ws.terminate();
      } catch {
        /* close handler reconnects */
      }
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      /* close handler reconnects */
    }
  }, 25_000);
  heartbeat.unref?.();
  return {
    markAlive(): void {
      alive = true;
    },
    stop(): void {
      clearInterval(heartbeat);
    },
  };
}

/** One relay message as an envelope. A binary frame is unwrapped into the same
 *  shape the JSON form carries, so everything downstream reads one shape; a
 *  message that decodes into neither is dropped. */
function readRelayEnvelope(raw: WebSocket.RawData, isBinary: boolean): Record<string, unknown> | null {
  if (isBinary) {
    const frame = decodeRelayBinaryFrame(raw);
    if (!frame) return null;
    return {
      type: 'frame',
      clientId: frame.clientId,
      // A text-flagged frame carries UTF-8 that must be handed on as a
      // STRING, exactly like a JSON envelope's `data` — the handshake and
      // the E2EE box readers below distinguish the two by type. An old
      // frame has no flag and stays bytes.
      data: frame.text ? Buffer.from(frame.data).toString('utf8') : frame.data,
    };
  }
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function startRemoteRelay(options: RemoteRelayOptions): Promise<RemoteRelayHandle> {
  // The byte meter reports one `rpc` total per window, which cannot say whether
  // that was one heavy answer or eighty cheap ones. Name those calls without
  // sending routine performance telemetry through the error channel.
  const remoteCallStats = createRemoteCallStats();
  const relayUrl = validatedRelayUrl(options.relayUrl);
  const token = await loadOrCreatePairingToken(options.userDataPath);
  const { deviceId, deviceSecret } = await loadOrCreateDevice(options.userDataPath);
  const clientUrl = relayClientUrl(relayUrl, deviceId);
  const e2eeIdentity = await loadOrCreateRelayE2EEIdentity(options.userDataPath);
  const pairing = relayE2EEPairingMaterial(e2eeIdentity);
  // Web Push belongs to the relay leg: this is the only surface where a client
  // can be absent from the socket and still want to hear that a turn finished.
  const pushStore = createPushSubscriptionStore(options.userDataPath);
  const nativeStore = createNativePushStore(options.userDataPath);
  // Platforms the relay announced it can deliver to (APNs/FCM credentials are
  // its to hold). Empty — and `nativePush` unadvertised — on an older relay or
  // one without credentials. Per connection, like every learned relay cap.
  let relayNativePlatforms: readonly string[] = [];
  // One method table per relay leg: the device name and stale-view state are
  // those of the credential the relay authenticated for it.
  const clientMethods = new WeakMap<RelayClientState, ReturnType<typeof createRemoteMethods>>();
  // Paired-device names come from the relay's own client list, keyed by the
  // credential it authenticated for the leg — the request never names itself.
  const deviceNames = new Map<string, string>();
  const deviceNameFor = async (credentialId: string): Promise<string> => {
    const cached = deviceNames.get(credentialId);
    if (cached) return cached;
    let name = '';
    try {
      const paired = await control.request<DesktopRemoteClientInfo[]>('list-clients');
      name = Array.isArray(paired)
        ? String(paired.find((entry) => entry.id === credentialId)?.name || '').trim().slice(0, 80)
        : '';
    } catch {
      name = '';
    }
    if (name) deviceNames.set(credentialId, name);
    return name;
  };
  const methodsFor = (_clientId: string, state: RelayClientState): ReturnType<typeof createRemoteMethods> => {
    let table = clientMethods.get(state);
    if (!table) {
      table = createRemoteMethods(
        {
          ...options,
          push: pushStore,
          nativePush: {
            platforms: () => relayNativePlatforms,
            register: async (input) => {
              const entry = await nativeStore.register(input);
              bindNativePush(entry);
              return entry;
            },
            remove: async (clientId, tokenFilter) => {
              const rows = (await nativeStore.list()).filter(
                (row) => row.clientId === clientId && (!tokenFilter || row.token === tokenFilter)
              );
              const removed = await nativeStore.remove(clientId, tokenFilter);
              for (const row of rows) sendEnvelope({ type: 'native-push-unbind', token: row.token });
              return removed;
            },
          },
        },
        {
          credentialId: () => state.credentialId,
          deviceName: () => deviceNameFor(state.credentialId),
          staleView: (sessionId, device) => {
            const held = (state.sessionStateEncoders.get(sessionId)?.resumePoint()?.held as { items?: unknown[] } | null)
              ?.items;
            const stale = viewIsStale(held, sessionStates.latestItems(sessionId), device);
            if (stale) sessionStates.refresh(sessionId);
            return stale;
          },
        }
      );
      clientMethods.set(state, table);
    }
    return table;
  };
  let socket: WebSocket | null = null;
  let closed = false;
  let relayBinaryFrames = false;
  // Echoed by the relay when it accepts this leg's `textFrames` request. Reset
  // per connection with the capabilities frame that sets it.
  let relayTextFrames = false;
  let retryMs = 1_000;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const revocationSockets = new Set<WebSocket>();
  // Bandwidth attribution for this leg, in the relay's own billing unit. On by
  // default: this daemon outlives every window and defers its own shutdown
  // while a phone is attached, so a flag set when launching the app would
  // almost never reach the process that actually relays. Two integer adds per
  // frame and one log line a minute is not a cost worth gating behind that.
  // MIXDOG_REMOTE_METER=0 opts out.
  const relayByteMeter = createRemoteByteMeter({
    enabled: process.env.MIXDOG_REMOTE_METER !== '0',
  });
  const sendEnvelope = (payload: unknown): void => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        /* relay vanished */
      }
    }
  };
  /** Sends an ALREADY serialized frame, so callers that must know the exact
   *  wire size the relay will measure can compute it once instead of
   *  re-serializing a multi-megabyte payload to find out. */
  const sendRawAndWait = (frame: string | Uint8Array): Promise<void> =>
    new Promise((resolve, reject) => {
      const target = socket;
      if (!target || target.readyState !== WebSocket.OPEN) {
        reject(new Error('Relay is not connected.'));
        return;
      }
      try {
        target.send(frame, (error: Error | undefined) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  // The relay only sends to tokens this desktop bound to a paired client, so a
  // bind precedes the first send on every connection.
  const bindNativePush = (row: NativePushSubscription): void => {
    if (!relayNativePlatforms.includes(row.platform)) return;
    sendEnvelope({ type: 'native-push-bind', clientId: row.clientId, platform: row.platform, token: row.token });
  };
  const sendNativePush = (message: NativePushMessage): boolean => {
    if (!relayNativePlatforms.includes(message.platform)) return false;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    sendEnvelope({ type: 'native-push', ...message });
    return true;
  };
  const handleNativePushResult = (envelope: Record<string, unknown>): void => {
    // The platform said the token is dead (APNs 410 / FCM UNREGISTERED).
    if (envelope.invalid === true && typeof envelope.token === 'string') {
      void nativeStore.removeToken(envelope.token).catch(() => false);
    }
  };
  const control = createRelayControlRequests({
    sendEnvelope,
    connected: () => socket !== null && socket.readyState === WebSocket.OPEN,
  });
  // With zero phones the relay would drop every broadcast on the floor anyway,
  // so the desktop goes quiet instead of streaming state upstream 24/7 — the
  // relay lane then costs keepalive bytes only. Each join restarts the delta
  // lane with a full snapshot, so nothing is lost.
  const clients = createRelayClientRegistry({
    host: options.host,
    sendEnvelope,
    frameBudgetBytes: MAX_WS_PAYLOAD_BYTES,
    onClientCountChanged: () => options.onClientCountChanged?.(),
    onEmpty: () => {
      // The last phone left: log the partial window rather than dropping it.
      const meterReport = relayByteMeter.clear();
      if (meterReport) reportRemoteByteWindow(meterReport);
      remoteCallStats.clear();
    },
  });
  const live = (clientId: string, state: RelayClientState): boolean => !closed && clients.attached(clientId, state);
  // The relay's per-frame ceiling as this desktop knows it. `relay-capabilities`
  // declares it at handshake; a `frame-too-large` notice proves a smaller one.
  // The effective limit is the smallest known value, so this leg's own check is
  // never more permissive than the relay's.
  let declaredFrameLimit: number | null = null;
  let noticedFrameLimit: number | null = null;
  const relayFrameLimit = (): number => resolveRelayFrameLimit(declaredFrameLimit, noticedFrameLimit);
  /** The ceilings the relay PUBLISHED for this connection: the effective
   *  capacity of this leg and the largest frame each wire form may carry to it
   *  (server.mjs `relayCapabilities`). They are the relay's to know — it clamps
   *  what this leg declared, discounts a receiver it has seen refuse, and wraps
   *  a phone frame in a route id only it can see — so they are consumed, never
   *  recomputed. null while no capabilities frame has carried them, and null
   *  again on a relay that publishes none: per connection, like every other
   *  learned cap. */
  let relayPublishedCeilings: RelayUplinkCeilings | null = null;
  /** Every cap here describes ONE connection. A relay leg that omits its
   *  capabilities frame — or sends it after a phone has already been announced
   *  — must find this leg holding NOTHING, not the previous connection's
   *  ceilings: a stale 4400-byte capacity applied to a new 64 MiB relay
   *  strands traffic, and a stale 64 MiB one applied to a new 4400-byte relay
   *  promises a browser room that does not exist. Called on every open, so the
   *  only thing that can populate these is a `relay-capabilities` frame on the
   *  connection they belong to. */
  const resetRelayConnectionCaps = (): void => {
    relayBinaryFrames = false;
    relayTextFrames = false;
    relayPublishedCeilings = null;
    declaredFrameLimit = null;
    noticedFrameLimit = null;
    advertisedRoutingCaps = '';
    relayNativePlatforms = [];
  };
  /** What a phone may put on the wire for this connection, as advertised to
   *  the browser: the relay's published ceilings, bounded by any smaller
   *  policy ceiling a refusal notice has proved since. */
  const relayUplinkLimits = (): RelayUplinkCeilings =>
    relayUplinkContract(relayPublishedCeilings, { policy: relayFrameLimit(), textFrames: relayTextFrames });
  /** Everything a browser needs to admit exactly what this relay admits, in
   *  ONE shape — handed over in the handshake, and re-issued unchanged
   *  whenever the relay republishes different numbers, so both frames can
   *  never drift apart:
   *    maxFrameBytes  — the relay's policy ceiling, applied to the phone's OWN
   *                     frame exactly as it is sent;
   *    maxRoutedBytes — the relay's capacity for this leg. Legacy field, for a
   *                     browser that predates the published ceilings and
   *                     derives its own; never this desktop's transport
   *                     constant, which belongs to no relay and is larger than
   *                     every ceiling on this path;
   *    uplink*        — the ceilings the relay published, forwarded verbatim;
   *    textFrames     — only when the relay ECHOED the text envelope for this
   *                     connection, so a text frame rides the fixed-size
   *                     wrapper instead of being JSON-escaped. Without the
   *                     echo the browser keeps JSON pricing. */
  const relayRoutingCapsPayload = (uplink: RelayUplinkCeilings): Record<string, unknown> => ({
    maxFrameBytes: relayFrameLimit(),
    maxRoutedBytes: uplink.capacity,
    ...relayUplinkCeilingFields(uplink),
    ...(relayTextFrames ? { textFrames: 1 as const } : {}),
  });
  /** The last caps every attached phone has been told, so a republication that
   *  changes nothing costs no frames. Connection-scoped like the caps
   *  themselves. */
  let advertisedRoutingCaps = '';
  /** The relay republishes `relay-capabilities` whenever this leg's numbers
   *  change. A phone that is ALREADY attached was told its ceilings once, in
   *  its handshake: without this it goes on sending at the old ones, and the
   *  first frame past the new ceiling is refused AT THE RELAY, where nothing
   *  can say which call it belonged to — that call waits out its deadline and
   *  closes the socket, and a fire-and-forget publish disappears with no error
   *  at all. Re-issued to every established channel, and only when the numbers
   *  really changed. */
  const republishRoutingCaps = (): void => {
    const payload = relayRoutingCapsPayload(relayUplinkLimits());
    const signature = JSON.stringify(payload);
    if (signature === advertisedRoutingCaps) return;
    advertisedRoutingCaps = signature;
    if (clients.size === 0) return;
    // Never droppable: losing this frame IS the failure it exists to prevent.
    broadcastEncrypted({ event: RELAY_ROUTING_CAPS_EVENT, payload }, false);
  };
  /** Refusing an oversize frame BEFORE it is sent is what makes attribution
   *  structural: the frame in hand is the frame that fails, so the call it
   *  answers is known exactly — no size matching, no log, nothing to evict or
   *  confuse. The browser is told through the encrypted channel, carrying that
   *  id (a push carries none and blames no call). */
  const deliverEncryptedFrame = async (
    clientId: string,
    payload: unknown,
    droppable: boolean,
    guardOversize: boolean,
    onSent?: (bytes: number) => void,
    requireDelivery = false
  ): Promise<void> => {
    const state = clients.get(clientId);
    if (!state?.channel) {
      if (requireDelivery) throw new Error('Remote client disconnected.');
      return;
    }
    try {
      const binary = relayBinaryFrames && state.binaryFrames;
      let wire: string | Uint8Array;
      if (binary) {
        wire = encodeRelayBinaryFrame({ clientId, data: await state.channel.encryptBinary(payload), droppable });
      } else {
        wire = JSON.stringify({
          type: 'frame',
          clientId,
          data: await state.channel.encryptJson(payload),
          ...(droppable ? { droppable: true } : {}),
        });
      }
      // Measured exactly as the relay charges it: the declared payload length
      // of the whole outgoing message (apps/relay/server.mjs frameBytes).
      const bytes = relayFrameByteLength(wire);
      const refusal = guardOversize ? relayFrameRefusal(bytes, relayFrameLimit(), relayFrameCallId(payload)) : null;
      if (refusal) {
        // Never sent: the relay would refuse it, and nothing downstream could
        // say whose frame it was. Answer the waiting call instead.
        await deliverEncryptedFrame(clientId, relayPayloadRejectedFrame(refusal), false, false, onSent);
        if (requireDelivery) throw new Error('View synchronization payload exceeds the relay frame limit.');
        return;
      }
      // Count only a completed socket write, not a refused or failed send.
      await sendRawAndWait(wire);
      const meterReport = relayByteMeter.record(payload, bytes);
      if (meterReport) reportRemoteByteWindow(meterReport);
      onSent?.(bytes);
    } catch (error) {
      if (requireDelivery) throw error;
      clients.close(clientId, 'relay encryption failed');
    }
  };
  const sendEncryptedFrame = (
    clientId: string,
    payload: unknown,
    droppable = false,
    onSent?: (bytes: number) => void,
    requireDelivery = false
  ): Promise<void> => deliverEncryptedFrame(clientId, payload, droppable, true, onSent, requireDelivery);
  const broadcastEncryptedAsync = (
    payload: unknown,
    droppable: boolean,
    include: (state: RelayClientState) => boolean = () => true
  ): Promise<void> =>
    Promise.all(
      [...clients.clients].map(([clientId, state]) =>
        state.channel && include(state) ? sendEncryptedFrame(clientId, payload, droppable) : Promise.resolve()
      )
    ).then(() => undefined);
  const broadcastEncrypted = (
    payload: unknown,
    droppable: boolean,
    include?: (state: RelayClientState) => boolean
  ): void => {
    void broadcastEncryptedAsync(payload, droppable, include);
  };
  const browserStreams = createBrowserRemoteStreams({
    isLive: (clientId) => Boolean(clients.get(clientId)?.channel),
    send: (clientId, payload) => sendEncryptedFrame(clientId, payload, true),
    request: (sessionId, streamOptions) => {
      if (!options.browserRemote) return Promise.reject(new TypeError('Remote Browser Use is unavailable.'));
      return options.browserRemote('stream', [sessionId, streamOptions]);
    },
  });
  const browserTabs = createBrowserRemoteTabSubscribers({
    isLive: (clientId) => Boolean(clients.get(clientId)?.channel),
    send: (clientId, payload) => sendEncryptedFrame(clientId, payload, false),
    request: (on) => {
      if (!options.browserRemote) return Promise.reject(new TypeError('Remote Browser Use is unavailable.'));
      return options.browserRemote('tabsWatch', [on]);
    },
  });
  const sessionStates = createRelaySessionStateFanout({ clients: clients.clients, sendEncryptedFrame });
  const resetTransportDeltas = (): void => {
    sessionStates.clear();
    clients.resetDeltas();
  };
  const catalogs = createRelayCatalogs({ host: options.host, clients: clients.clients, live, sendEncryptedFrame });
  const sessionWiring = createRelaySessionWiring({
    host: options.host,
    clients,
    catalogs,
    sessionStates,
    pushStore,
    nativePush: { store: nativeStore, send: sendNativePush },
    live,
    closed: () => closed,
    sendEncryptedFrame,
    broadcastEncrypted,
    subscribeTerminalData: options.subscribeTerminalData,
  });
  const drainQueuedRevocations = createRevocationDrain({
    relayUrl,
    userDataPath: options.userDataPath,
    deviceId,
    sockets: revocationSockets,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    closed: () => closed,
  });
  const mediaLane = createRelayMediaLane({
    host: options.host,
    sendEnvelope,
    socketBacklog: () => socket?.bufferedAmount ?? 0,
    // The session is named by its handshake challenge, which the relay
    // forwards; only an authenticated client has a media key to find.
    mediaKey: (sid) => {
      for (const client of clients.clients.values()) {
        if (client.challenge.challenge === sid) return client.channel?.mediaKey ?? null;
      }
      return null;
    },
  });
  const dispatchClientCall = createRelayClientCallDispatch({
    host: options.host,
    methods: methodsFor,
    attached: clients.attached,
    live,
    sendEncryptedFrame,
    browserStreams,
    browserTabs,
    acknowledgePaintProbe: sessionStates.acknowledgeFrame,
    resyncClient: sessionWiring.resyncClient,
    recordCall: remoteCallStats.record,
    takeParkedViews: clients.takeParkedViews,
  });
  const clientLifecycle = createRelayClientLifecycle({
    clients,
    e2eeIdentity,
    pairing,
    relayBinaryFrames: () => relayBinaryFrames,
    viewSyncSupported: () => Boolean(options.host.replaySessionStates),
    nativePushSupported: () => relayNativePlatforms.length > 0,
    relayRoutingCapsPayload: () => relayRoutingCapsPayload(relayUplinkLimits()),
    sendEnvelope,
    sendEncryptedFrame,
    dispatchClientCall,
    resyncClient: sessionWiring.resyncClient,
    onClientClaim: options.onClientClaim,
  });
  const handleRelayCapabilities = (envelope: Record<string, unknown>): void => {
    relayBinaryFrames = envelope.binaryFrames === 1;
    // ACKNOWLEDGEMENT, not inference: `desktop-lanes.textFrames` is only
    // a request, and a binary-capable relay that predates the flag still
    // JSON-wraps text. Pricing text as fixed without this echo promises a
    // browser room the relay does not have.
    relayTextFrames = envelope.textFrames === 1;
    // The relay declares its per-frame ceiling here (server.mjs
    // runDesktopLeg). Learning it is what lets this leg refuse an
    // oversize frame itself instead of discovering it after the fact.
    if (typeof envelope.maxFrameBytes === 'number') {
      declaredFrameLimit = resolveRelayFrameLimit(envelope.maxFrameBytes);
    }
    // …and the authoritative ceilings that go with it, for THIS
    // connection: the relay clamped its own capacity for this leg and
    // priced the routing envelope with the id it actually wraps a phone
    // frame in. Consuming them is what makes the browser refuse exactly
    // what the relay refuses; a relay that publishes none reads as null
    // and the conservative fallback stands in.
    relayPublishedCeilings = readRelayUplinkCeilings(envelope);
    // The relay can deliver native push only when it holds credentials.
    relayNativePlatforms =
      envelope.nativePush === 1 && Array.isArray(envelope.nativePushPlatforms)
        ? envelope.nativePushPlatforms.filter((name): name is 'apns' | 'fcm' => name === 'apns' || name === 'fcm')
        : [];
    if (relayNativePlatforms.length > 0) {
      void nativeStore
        .list()
        .then((rows) => rows.forEach(bindNativePush))
        .catch(() => undefined);
    }
    // The relay republishes on change; a phone already attached is held
    // to whatever it was told in its handshake until this reaches it.
    republishRoutingCaps();
  };
  const routeRelayEnvelope = createRelayEnvelopeDispatcher({
    control,
    onCapabilities: handleRelayCapabilities,
    onClientClaim: clientLifecycle.answerClaim,
    onClientOpen: clientLifecycle.open,
    onNativePushResult: handleNativePushResult,
    onClientClose: (clientId) => {
      // The phone's leg dropped, not its pairing: its lanes wait briefly.
      if (clients.remove(clientId, true)) options.onClientCountChanged?.();
    },
    onMedia: (envelope) => {
      const id = String(envelope.id ?? '');
      if (!id) return;
      if (envelope.type === 'media-request') {
        void mediaLane.serve({
          id,
          assetId: String(envelope.assetId ?? ''),
          variant: String(envelope.variant ?? 'original'),
          method: String(envelope.method ?? 'GET'),
          range: String(envelope.range ?? ''),
          sid: String(envelope.sid ?? ''),
          enc: String(envelope.enc ?? ''),
        });
      } else if (envelope.type === 'media-abort') {
        mediaLane.abort(id);
      } else if (envelope.type === 'media-pause' || envelope.type === 'media-resume') {
        mediaLane.setPaused(id, envelope.type === 'media-pause');
      }
    },
  });
  const dispatchRelayEnvelope = (envelope: Record<string, unknown>): void => {
    // The relay REFUSED an oversize frame instead of dropping the leg, so
    // the browser that sent it is waiting on a call that will never be
    // answered. Forward the refusal to it (encrypted, like every other
    // event) and let it fail that call with a real reason.
    //
    // The relay derives this clientId from the binary frame header or a
    // bounded JSON scan — never from parsing the payload — so it is used
    // here as a LOOKUP KEY only: an unknown id finds no client and an
    // absent one means the refusal could not be attributed, which every
    // active client has to consider. A malformed envelope yields no
    // rejection and returns quietly; nothing here can throw or close.
    if (envelope.type === RELAY_FRAME_TOO_LARGE) {
      const rejection = readRelayPayloadRejection(envelope);
      if (!rejection) return;
      // A frame slipped past the pre-send check, so the ceiling this leg
      // believed in was too generous: tighten it permanently. The notice
      // itself names no call and NEVER selects one — the relay cannot know
      // which frame it refused, and guessing by size blames innocents.
      if (rejection.limit !== null) {
        noticedFrameLimit = resolveRelayFrameLimit(rejection.limit, noticedFrameLimit);
      }
      const clientId = typeof envelope.clientId === 'string' ? envelope.clientId : '';
      if (!clientId) {
        // Unattributed. It concerns exactly ONE client and nothing can say
        // which, so no client is told: a sibling would learn another
        // client's refused size and see an error for traffic it never
        // sent. The learned ceiling above is the repair that matters; the
        // event itself is recorded on the leg it happened on.
        console.error(
          '[mixdog-remote] relay refused an oversize frame' +
            ` bytes=${rejection.bytes ?? 'unknown'} limit=${rejection.limit ?? 'unknown'}` +
            ' (no client attributed)'
        );
        options.onRelayPayloadRefused?.({
          bytes: rejection.bytes,
          limit: rejection.limit,
        });
        return;
      }
      // Named: only that leg hears about it, and never as a victim.
      void sendEncryptedFrame(clientId, relayPayloadRejectedFrame({ ...rejection, callId: null, scope: 'unknown' }));
      return;
    }
    if (envelope.type !== 'frame' || typeof envelope.clientId !== 'string') {
      routeRelayEnvelope(envelope);
      return;
    }
    const client = clients.get(envelope.clientId);
    if (!client) return;
    const frame = envelope.data;
    if (typeof frame !== 'string' && !ArrayBuffer.isView(frame)) return;
    clientLifecycle.receive(envelope.clientId, client, frame);
  };

  const connect = (): void => {
    if (closed) return;
    const connection = relayDeviceSocketOptions(relayUrl, { deviceId, deviceSecret });
    const ws = new WebSocket(connection.url, {
      headers: connection.headers,
      maxPayload: MAX_WS_PAYLOAD_BYTES,
      // Frames on this leg are E2EE ciphertext (incompressible) or small
      // control envelopes; payload compression happens inside the encrypted
      // envelope instead. Transport deflate only cost CPU on both ends.
      perMessageDeflate: false,
    });
    socket = ws;
    const heartbeat = startRelayHeartbeat(ws);
    ws.on('open', () => {
      retryMs = 1_000;
      // Nothing the previous leg declared survives into this one.
      resetRelayConnectionCaps();
      resetTransportDeltas();
      // A fresh desktop leg supersedes the old one and the relay closed its
      // phone legs; phones re-open and re-announce themselves.
      clients.clear();
      // Announce the lanes this build serves BEFORE the pairing token, so the
      // relay can answer a phone's media request the moment a client leg
      // binds. An older relay ignores the frame; a newer one stops proxying
      // media to desktops that would never answer.
      // HTTP media is served as end-to-end encrypted frames (remote-relay-media.ts):
      // the relay forwards ciphertext. Browsers learn per client, through the
      // handshake's `mediaE2ee`, whether to use it; older ones keep RPC payloads.
      // `maxPayloadBytes` is the declaration that ends the version-skew outage:
      // the relay clamps its uplink capacity for this leg to what this leg says
      // it can receive (server.mjs `uplinkCapacityFor`, learned per connection
      // and reset on attach and redial) instead of assuming a constant. Sent
      // from the open handler, so a redial re-declares it before any frame.
      // `textFrames` opts into the envelope that cannot inflate what it carries.
      sendEnvelope({
        type: 'desktop-lanes',
        media: true,
        e2ee: 1,
        maxPayloadBytes: MAX_WS_PAYLOAD_BYTES,
        textFrames: 1,
      });
      // Which build this desktop is, so the relay can serve its browsers the
      // matching renderer release. A separate frame (not a desktop-lanes field)
      // and ignored by relays that predate it.
      if (options.appVersion) {
        sendEnvelope({
          type: 'desktop-version',
          appVersion: options.appVersion,
          ...(options.rendererRelease ? { rendererRelease: options.rendererRelease } : {}),
        });
      }
      // Register the phone pairing token before any client leg can bind.
      sendEnvelope({ type: 'set-client-token', token });
      // Unpair is local-first so it also works offline. Once any new relay leg
      // opens, dispose the owner-authenticated registrations queued while down.
      void drainQueuedRevocations();
    });
    ws.on('message', (raw, isBinary) => {
      heartbeat.markAlive();
      try {
        const envelope = readRelayEnvelope(raw, isBinary);
        if (!envelope) return;
        dispatchRelayEnvelope(envelope);
      } catch {
        // A frame this leg cannot process ends the leg; the close handler
        // redials with a clean state.
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
      }
    });
    ws.on('error', () => {
      /* connection errors surface as close */
    });
    ws.on('close', () => {
      heartbeat.stop();
      clients.clear();
      resetTransportDeltas();
      mediaLane.destroyAll();
      if (socket === ws) socket = null;
      if (closed) return;
      control.rejectAll('Relay disconnected.');
      reconnectTimer = setTimeout(connect, retryMs);
      reconnectTimer.unref?.();
      retryMs = Math.min(30_000, retryMs * 2);
    });
  };
  connect();
  const sessionSubscriptions = sessionWiring.start();

  return {
    get clientUrl() {
      return clientUrl;
    },
    get token() {
      return token;
    },
    pairing,
    get clientCount() {
      return clients.size;
    },
    listClients: () =>
      control
        .request<DesktopRemoteClientInfo[]>('list-clients')
        .then((remoteClients) => (Array.isArray(remoteClients) ? remoteClients : [])),
    publishBrowserFrame: (frame) => browserStreams.publish(frame),
    publishBrowserTabs: (tabs) => browserTabs.publish(tabs),
    publishBrowserImportProgress: (progress) =>
      broadcastEncrypted({ event: REMOTE_BROWSER_IMPORT_PROGRESS_EVENT, payload: progress }, false),
    revokeClient: async (clientId: string): Promise<void> => {
      browserStreams.dropClient(clientId);
      browserTabs.dropClient(clientId);
      deviceNames.delete(clientId);
      if (!/^[0-9a-f-]{8,64}$/u.test(clientId)) throw new TypeError('Invalid remote client id.');
      // Per-browser credentials are isolated: revoking one deletes only that
      // browser's token on the relay. The QR bootstrap token never rotates
      // here, so every other paired browser keeps working untouched.
      clients.dropParkedViews();
      await control.request<boolean>('revoke-client', { clientId });
      // The credential is gone; its notifications must go with it. Parked
      // lanes cannot be attributed to a browser, so none survive a revocation.
      sessionSubscriptions.forgetClient(clientId);
      clients.dropParkedViews();
    },
    resume: (): void => {
      if (closed) return;
      retryMs = 1_000;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        connect();
        return;
      }
      if (socket) {
        // The close handler reconnects with the freshly reset backoff.
        try {
          socket.terminate();
        } catch {
          /* already gone */
        }
        return;
      }
      connect();
    },
    revoke: (): Promise<void> => {
      clients.dropParkedViews();
      return revokeDeviceOverSocket({ currentSocket: () => socket, closed: () => closed });
    },
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      resetTransportDeltas();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      browserStreams.dispose();
      browserTabs.dispose();
      sessionSubscriptions.dispose();
      for (const pending of revocationSockets) {
        try {
          pending.terminate();
        } catch {
          /* already gone */
        }
      }
      revocationSockets.clear();
      if (socket) {
        try {
          socket.terminate();
        } catch {
          /* already gone */
        }
        socket = null;
      }
      clients.clear();
      control.rejectAll('Relay client is closed.');
    },
  };
}
