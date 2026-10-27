// Relay client for the installable web app: the desktop dials OUT to
// apps/relay/server.mjs and answers browser RPC frames, so a phone anywhere
// on the internet reaches this machine without port forwarding.
import { hostname } from 'node:os';

import type WebSocket from 'ws';

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
import {
  createRemoteCallStats,
  createRemoteSocketDiagnostics,
  reportRemoteByteWindow,
} from './remote-performance-diagnostics';
import type { RemoteMethodDependencies } from './remote-methods';
import { createFileDownloadService } from './file-downloads';
export { remoteTranscriptSnapshot } from './remote-transcript';
import { createNativePushStore } from './native-push-store';
import { createPushSubscriptionStore } from './push-subscription-store';
import { loadOrCreateRelayE2EEIdentity } from './remote-e2ee';
import type { RemoteClaimDecision, RemoteClientClaim } from './remote-relay-claim';
import { createRelayConnectionCaps } from './remote-relay-capabilities';
import { createRelayClientLifecycle } from './remote-relay-client-lifecycle';
import { createRelayCatalogs } from './remote-relay-catalog';
import { createRelayClientCallDispatch } from './remote-relay-client-calls';
import { clientViewsSessionLane, createRelayClientRegistry, type RelayClientState } from './remote-relay-clients';
import { createRelayControlRequests } from './remote-relay-control';
import { createRelayEncryptedDelivery } from './remote-relay-delivery';
import type { RemoteTransportPeerHost } from './remote-transport/coordinator';
import { createPairCodeManager, type PairCodeState, type PairCodeUnsupported } from './remote-pair-code';
import { createRelayEnvelopeDispatcher } from './remote-relay-envelope';
import { createRelayWebPush } from './remote-relay-web-push';
import { bindRemoteIceServers, createRemoteIceServers, resolveRemoteIceServers } from './remote-ice-servers';
import { createScreenAccessPublisher } from './remote-screen/screen-access-publisher';
import { createRemoteRelayInputOrder } from './remote-webrtc/input-order';
import { createRemoteWebrtcRelay } from './remote-webrtc/relay';
import {
  createRevocationDrain,
  loadOrCreateDevice,
  relayClientUrl,
  revokeDeviceOverSocket,
  validatedRelayUrl,
} from './remote-relay-device';
import { createRelayDeviceConnection } from './remote-relay-connection';
import { createRelayDeviceMethods } from './remote-relay-device-methods';
import { createRelayInboundDispatch, routeRelayMediaEnvelope } from './remote-relay-inbound';
import { createRelayMediaLane } from './remote-relay-media';
import { createRelayNativePush } from './remote-relay-native-push';
import { createRelaySessionStateFanout } from './remote-relay-session-state';
import { createRelaySessionWiring, type RelayNotificationDeps } from './remote-relay-session-wiring';
import type { NotificationTestResult } from './notification-center';

export { startRelayHeartbeat } from './remote-relay-connection';
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
  /** Every time the relay leg opens, including each reconnect. */
  onConnected?: () => void;
  /** Test seam: replaces the media lane implementation. */
  createMediaLane?: typeof createRelayMediaLane;
  /** The relay refused an oversize frame this desktop sent and could not say
   *  which client it belonged to. Reported so the user sees it; it names no
   *  call and reaches no phone, because either would blame the wrong one. */
  onRelayPayloadRefused?: (detail: { bytes: number | null; limit: number | null }) => void;
  /** Ask the user to approve one credential-less container. Resolving false
   *  (or throwing) denies it; the relay never decides this. */
  onClientClaim?: (claim: RemoteClientClaim) => Promise<RemoteClaimDecision>;
  onClaimConflict?: (claimId: string) => void;
  /** The approval for a claim is about to be sent: that `clientId` (its
   *  credential) is paired again. */
  onClaimApproved?: (clientId: string) => void;
  /** An unpair of this credential is recorded and in force (the relay has
   *  not confirmed it, and the device was not paired again since): its
   *  connections get no screen access, including ones admitted meanwhile. */
  unpairPending?: (credentialId: string) => boolean;
  /** This PC's name for handshakes, pair codes and the relay report; read each
   *  time so a rename applies without a restart. Defaults to the OS hostname. */
  hostName?: () => string;
  /** Local nickname for a paired device (credential id); wins over the relay's name. */
  deviceAlias?: (credentialId: string) => string;
  /** Each paired device's notification preferences (issue #221). */
  notifications?: RelayNotificationDeps;
  /** The direct transport's peer host: `createRemoteTransportPeerService`
   *  (remote-transport/peer-link.ts), whose stand-in bridge reaches the
   *  desktop app's hidden peer window. Absent: transport sessions stay
   *  relay-only. */
  transportPeerHost?: RemoteTransportPeerHost | null;
  /** Receives every diagnostics line of a transport session (offer, path,
   *  traffic, end) besides the console. */
  transportLog?: (line: string) => void;
}

export interface RemoteRelayHandle {
  /** One notification to a paired device through its real channel. */
  sendTestNotification(clientId: string): Promise<NotificationTestResult>;
  /** Paired client ids holding a native or web push registration. */
  pushRegistrations(): Promise<Set<string>>;
  /** Reports the current PC name to the relay again after a rename. */
  pushName(): void;
  /** URL a phone opens: the relay origin plus this desktop's device route. */
  clientUrl: string;
  token: string;
  pairing: RelayE2EEPairingMaterial;
  readonly clientCount: number;
  /** A live Browser Use frame from the desktop, paced to each subscribed client. */
  publishBrowserFrame(frame: DesktopRemoteBrowserStreamFrame): void;
  /** The window's WebRTC signal to one client (shared/remote-webrtc.ts). */
  sendBrowserWebrtcSignal(clientId: string, signal: unknown): Promise<void>;
  /** The main-workspace browser tab list, pushed to every watching client. */
  publishBrowserTabs(tabs: DesktopRemoteBrowserTab[]): void;
  publishBrowserImportProgress(progress: DesktopBrowserImportProgress): void;
  /** Whether a connected device registered `lane` and is showing `sessionId`. */
  viewsSessionLane(sessionId: string, lane: string): boolean;
  listClients(): Promise<DesktopRemoteClientInfo[]>;
  /** The 6-digit pairing code of an open Settings → Connection screen:
   *  'ensure' returns the live one (minting if needed), 'renew' replaces it,
   *  'release' withdraws it. */
  pairCode(action: 'ensure' | 'renew' | 'release'): PairCodeState | PairCodeUnsupported | null;
  /** Unpairs one credential at the relay. Record the unpair first
   *  (`unpairPending` true) so it holds until the relay confirms it. */
  revokeClient(clientId: string): Promise<void>;
  /** System resume: the socket is likely half-dead after sleep — drop it and
   *  redial immediately instead of waiting for the ping cycle to notice. */
  resume(): void;
  /** System suspend (also run on resume): the TURN credential cache and any
   *  issuance still in flight are dropped, because no age counted across a
   *  sleep can be trusted (remote-ice-servers.ts). */
  suspend(): void;
  /** Delete this install's authenticated registration from the relay. */
  revoke(): Promise<void>;
  close(): Promise<void>;
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
  // Download grants and leases outlive one relay leg (a phone reconnects mid
  // transfer) and are bound to the paired device, so one service serves every
  // connection; unpair, session deletion and close end what it holds.
  // Leases also stream on the encrypted media lane (remote-relay-media.ts).
  const fileDownloads = createFileDownloadService({ host: options.host, mediaLane: true });
  const revocationSockets = new Set<WebSocket>();
  const connection = createRelayDeviceConnection({
    relayUrl,
    identity: { deviceId, deviceSecret },
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    onOpen: () => {
      // Nothing the previous leg declared survives into this one.
      caps.resetRelayConnectionCaps();
      relayWebPush.reset();
      resetTransportDeltas();
      // Phone legs survive a desktop redial: the relay replays client-open for
      // each, and a phone resuming with its token adopts the lanes the close
      // handler parked, so it receives deltas instead of a full baseline.
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
      // `pairV2`: this desktop publishes 6-digit codes and serves browsers that
      // connect directly. An older relay ignores the field.
      sendEnvelope({
        type: 'desktop-lanes',
        media: true,
        e2ee: 1,
        maxPayloadBytes: MAX_WS_PAYLOAD_BYTES,
        textFrames: 1,
        pairV2: 1,
      });
      sendEnvelope({ type: 'desktop-name', name: pcName() });
      // A fresh leg holds no code of ours: ask for a new one if the screen is open.
      pairCode.onConnected();
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
      options.onConnected?.();
    },
    onEnvelope: (envelope) => dispatchRelayEnvelope(envelope),
    onLegEnded: () => {
      // Every phone leg ended with this one; resumable lanes are parked for
      // the replayed client-open on the next leg (see onOpen).
      clients.parkAll();
      resetTransportDeltas();
      mediaLane.destroyAll();
    },
    onLegLost: () => control.rejectAll('Relay disconnected.'),
  });
  const { sendEnvelope } = connection;
  // Bandwidth attribution for this leg, in the relay's own billing unit. On by
  // default: this daemon outlives every window and defers its own shutdown
  // while a phone is attached, so a flag set when launching the app would
  // almost never reach the process that actually relays. Two integer adds per
  // frame and one log line a minute is not a cost worth gating behind that.
  // MIXDOG_REMOTE_METER=0 opts out.
  const relayByteMeter = createRemoteByteMeter({
    enabled: process.env.MIXDOG_REMOTE_METER !== '0',
  });
  const pcName = (): string => (options.hostName?.() || hostname()).slice(0, 80);
  const pairCode = createPairCodeManager({
    sendEnvelope: (payload) => sendEnvelope(payload),
    hostName: () => pcName(),
  });
  const nativePush = createRelayNativePush({
    store: nativeStore,
    platforms: () => caps.relayNativePlatforms(),
    sendEnvelope,
    connected: connection.connected,
  });
  const control = createRelayControlRequests({
    sendEnvelope,
    connected: connection.connected,
  });
  // STUN/TURN for phone ↔ PC WebRTC: issued by this relay, read through
  // resolveRemoteIceServers() (remote-ice-servers.ts) while this client runs.
  const iceServers = createRemoteIceServers({
    request: () =>
      caps.relayIce() ? control.request<Record<string, unknown>>('ice-servers-request') : Promise.resolve(null),
  });
  const unbindIceServers = bindRemoteIceServers(iceServers);
  // With zero phones the relay would drop every broadcast on the floor anyway,
  // so the desktop goes quiet instead of streaming state upstream 24/7 — the
  // relay lane then costs keepalive bytes only. Each join restarts the delta
  // lane with a full snapshot, so nothing is lost.
  const socketDiagnostics = createRemoteSocketDiagnostics({
    sample: () => ({
      clients: clients.size,
      sockets: [{ name: 'relay', bufferedAmount: connection.bufferedAmount() }],
    }),
  });
  const clients = createRelayClientRegistry({
    host: options.host,
    sendEnvelope,
    frameBudgetBytes: MAX_WS_PAYLOAD_BYTES,
    onClientCountChanged: () => {
      socketDiagnostics.sync();
      options.onClientCountChanged?.();
    },
    // A connection that leaves, by any path, loses its screen access now, and
    // its screen `ready`s still resolving are cancelled.
    onRemoved: (clientId) => {
      browserWebrtc.connectionRemoved(clientId);
      screenAccessPublisher.removed(clientId);
    },
    // Admitted while its credential has an unpair in force: no screen access
    // for this connection's lifetime.
    onAdded: (state) => screenAccessPublisher.admitted(state),
    onEmpty: () => {
      socketDiagnostics.sync();
      // The last phone left: log the partial window rather than dropping it.
      const meterReport = relayByteMeter.clear();
      if (meterReport) reportRemoteByteWindow(meterReport);
      remoteCallStats.clear();
    },
  });
  const live = (clientId: string, state: RelayClientState): boolean =>
    !connection.closed() && clients.attached(clientId, state);
  // Everything the relay declared for the CURRENT connection; reset on every
  // open. The broadcast it republishes through is resolved when it fires.
  const caps = createRelayConnectionCaps({
    clientCount: () => clients.size,
    broadcastEncrypted: (payload, droppable) => broadcastEncrypted(payload, droppable),
    rebindNativePush: nativePush.rebindAll,
  });
  // Browser push through the relay's own sender identity, when it has one.
  const relayWebPush = createRelayWebPush({
    identity: e2eeIdentity,
    available: caps.relayWebPush,
    sendEnvelope,
    onDiagnostic: (event, details) =>
      console.info(
        `[mixdog-remote-push] ${event}` +
          Object.entries(details)
            .map(([key, value]) => ` ${key}=${String(value)}`)
            .join('')
      ),
  });
  const transportLog = (line: string): void => {
    console.info(line);
    options.transportLog?.(line);
  };
  const { sendEncryptedFrame, broadcastEncrypted, openTransport } = createRelayEncryptedDelivery({
    clients,
    relayBinaryFrames: caps.relayBinaryFrames,
    relayFrameLimit: caps.relayFrameLimit,
    sendRawAndWait: connection.sendRawAndWait,
    byteMeter: relayByteMeter,
    // Direct transport sessions: the media adapter reads the same gallery and
    // download leases as the relay media lane. Without `transportPeerHost`
    // sessions stay relay-only.
    transport: {
      peerHost: options.transportPeerHost ?? null,
      media: { host: options.host, downloads: fileDownloads },
      options: { log: transportLog },
    },
  });
  const browserStreams = createBrowserRemoteStreams({
    isLive: (clientId) => Boolean(clients.get(clientId)?.channel),
    send: (clientId, payload) => sendEncryptedFrame(clientId, payload, true),
    request: (sessionId, streamOptions) => {
      if (!options.browserRemote) return Promise.reject(new TypeError('Remote Browser Use is unavailable.'));
      return options.browserRemote('stream', [sessionId, streamOptions]);
    },
    onDrop: (clientId, sessionId) => browserWebrtc.viewerLeft(clientId, sessionId),
  });
  // WebRTC live view: signaling to and from the window process's sender, and
  // the decode-order input gate. A viewer is a client streaming the session.
  const browserWebrtc = createRemoteWebrtcRelay({
    subscribed: (clientId, sessionId) => browserStreams.subscribed(clientId, sessionId),
    awaitingFit: (clientId, sessionId) => browserStreams.awaitingFit(clientId, sessionId),
    // Whole-PC screen: pairing is the approval, so the connection that
    // delivered the signal may view and control while the id still names it,
    // its E2EE channel is established and it was not unpaired.
    screenAuthorized: async (clientId, origin) => screenAccessPublisher.allowed(clientId, origin),
    screenDisplays: () =>
      options.browserRemote
        ? options.browserRemote('screenDisplays', [])
        : Promise.reject(new TypeError('Remote screen is unavailable.')),
    setImages: (clientId, sessionId, enabled) => browserStreams.setImages(clientId, sessionId, enabled),
    resolveIceServers: resolveRemoteIceServers,
    forward: async (clientId, signal, servers, origin) => {
      if (!options.browserRemote) throw new TypeError('Remote Browser Use is unavailable.');
      // The window opens a screen session on its `ready` with the access of
      // the connection that delivered it, published here first; another
      // connection under the id, an unpair, or a deny that followed while it
      // was delivered refuses the `ready`. Nothing is awaited between that
      // check and the request below, so the window (which handles both in
      // order) binds the session to this connection's access.
      if (signal.source.kind === 'screen') {
        const allowed =
          signal.type === 'ready'
            ? await screenAccessPublisher.publish(clientId, origin)
            : screenAccessPublisher.allowed(clientId, origin);
        if (!allowed) throw new TypeError('Remote screen is not allowed for this device.');
      }
      return options.browserRemote('webrtcSignal', [clientId, signal, servers ?? null]);
    },
    viewerLeft: (clientId, sourceKey) =>
      options.browserRemote ? options.browserRemote('webrtcViewerLeft', [clientId, sourceKey]) : Promise.resolve(),
    send: (clientId, payload) => sendEncryptedFrame(clientId, payload, false),
  });
  // The window process enforces a screen session's access itself, read live
  // (remote-screen/screen-webrtc-sources.ts). The publisher binds every push
  // to this service's epoch, a monotonic revision and the relay connection;
  // a connection leaving the registry (onRemoved) and an unpair deny at once.
  const screenAccessPublisher = createScreenAccessPublisher({
    client: (clientId) => clients.get(clientId),
    clients: () => clients.clients.entries(),
    unpaired: (credentialId) => options.unpairPending?.(credentialId) === true,
    label: (credentialId) => (credentialId && options.deviceAlias?.(credentialId)) || 'Paired phone',
    send: (clientId, access) =>
      options.browserRemote
        ? options.browserRemote('screenAccess', [clientId, access])
        : Promise.reject(new TypeError('Remote screen is unavailable.')),
  });
  // Pipelined relay page input (`browserRemoteControl` with an order).
  const relayInputOrder = createRemoteRelayInputOrder();
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
    hostId: deviceId,
    nativePush: { store: nativeStore, send: nativePush.send },
    relayWebPush,
    ...(options.notifications ? { notifications: options.notifications } : {}),
    live,
    closed: connection.closed,
    sendEncryptedFrame,
    broadcastEncrypted,
    subscribeTerminalData: options.subscribeTerminalData,
    onSessions: (sessions) => fileDownloads.retainSessions(sessions.map((session) => session.id)),
  });
  const drainQueuedRevocations = createRevocationDrain({
    relayUrl,
    userDataPath: options.userDataPath,
    deviceId,
    sockets: revocationSockets,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    closed: connection.closed,
  });
  const deviceMethods = createRelayDeviceMethods({
    base: options,
    deviceAlias: (credentialId) => options.deviceAlias?.(credentialId),
    listClients: () => control.request<DesktopRemoteClientInfo[]>('list-clients'),
    fileDownloads,
    push: pushStore,
    // The push lane decides what a notification's Allow may answer; a
    // call needs a connection, so the subscriptions below exist by then.
    approvalNotifications: {
      approvalAllowDecision: (sessionId, approvalId) =>
        sessionSubscriptions.approvalAllowDecision(sessionId, approvalId),
      approvalPointerOnly: (sessionId, approvalId) => sessionSubscriptions.approvalPointerOnly(sessionId, approvalId),
    },
    nativePush: {
      platforms: () => caps.relayNativePlatforms(),
      register: nativePush.register,
      remove: nativePush.remove,
    },
    sessionStates,
  });
  const mediaLane = (options.createMediaLane ?? createRelayMediaLane)({
    host: options.host,
    sendEnvelope,
    socketBacklog: connection.bufferedAmount,
    // The session is named by its handshake challenge, which the relay
    // forwards; only an authenticated client has a media key to find.
    mediaKey: (sid) => {
      for (const client of clients.clients.values()) {
        if (client.challenge.challenge === sid) return client.channel?.mediaKey ?? null;
      }
      return null;
    },
    // Download leases are bound to the paired device, named exactly as the
    // RPC lane names it (remote-methods.ts downloadRequester): the relay
    // credential, else this connection.
    mediaDevice: (sid) => {
      for (const [clientId, client] of clients.clients) {
        if (client.challenge.challenge !== sid) continue;
        return client.channel ? client.credentialId || `connection:${clientId}` : null;
      }
      return null;
    },
    downloads: fileDownloads,
  });
  const dispatchClientCall = createRelayClientCallDispatch({
    host: options.host,
    methods: deviceMethods.methodsFor,
    attached: clients.attached,
    live,
    sendEncryptedFrame,
    browserStreams,
    browserTabs,
    webrtc: browserWebrtc,
    relayInputOrder,
    acknowledgePaintProbe: sessionStates.acknowledgeFrame,
    resyncClient: sessionWiring.resyncClient,
    recordCall: remoteCallStats.record,
    takeParkedViews: clients.takeParkedViews,
  });
  const clientLifecycle = createRelayClientLifecycle({
    clients,
    e2eeIdentity,
    pairing,
    relayBinaryFrames: caps.relayBinaryFrames,
    viewSyncSupported: () => Boolean(options.host.replaySessionStates),
    nativePushSupported: () => caps.relayNativePlatforms().length > 0,
    relayRoutingCapsPayload: () => caps.relayRoutingCapsPayload(caps.relayUplinkLimits()),
    sendEnvelope,
    sendEncryptedFrame,
    dispatchClientCall,
    resyncClient: sessionWiring.resyncClient,
    // A handshake needs a phone's hello, so the subscriptions below exist by then.
    joinFrames: () => sessionSubscriptions.joinFrames(),
    onClientClaim: options.onClientClaim,
    onClaimConflict: options.onClaimConflict,
    onClaimApproved: options.onClaimApproved,
    hostName: pcName,
    openTransport,
    // Offered whenever a peer host exists (the desktop service always has one).
    transportOffer: () => Boolean(options.transportPeerHost),
    transportLog,
  });
  const routeRelayEnvelope = createRelayEnvelopeDispatcher({
    control,
    onCapabilities: caps.handleRelayCapabilities,
    onClientClaim: clientLifecycle.answerClaim,
    onPairCode: (envelope) => {
      if (envelope.type === 'pair-code-used') pairCode.onUsed(envelope);
      else if (envelope.type === 'pair-code-issued') pairCode.onIssued(envelope);
    },
    onClientOpen: clientLifecycle.open,
    onNativePushResult: nativePush.handleResult,
    onWebPushSubscriptions: relayWebPush.update,
    onWebPushResult: relayWebPush.onResult,
    onClientClose: (clientId) => {
      // The phone's leg dropped, not its pairing: its lanes wait briefly.
      relayInputOrder.dropClient(clientId);
      if (clients.remove(clientId, true)) options.onClientCountChanged?.();
    },
    onMedia: (envelope) => routeRelayMediaEnvelope(mediaLane, envelope),
  });
  const dispatchRelayEnvelope = createRelayInboundDispatch({
    learnRefusedFrameLimit: caps.learnRefusedFrameLimit,
    sendEncryptedFrame,
    onRelayPayloadRefused: (detail) => options.onRelayPayloadRefused?.(detail),
    client: clients.get,
    receive: clientLifecycle.receive,
    route: routeRelayEnvelope,
  });
  connection.connect();
  const sessionSubscriptions = sessionWiring.start();

  return {
    get clientUrl() {
      return clientUrl;
    },
    get token() {
      return token;
    },
    pairing,
    sendTestNotification: (clientId) => sessionSubscriptions.sendTestNotification(clientId),
    pushRegistrations: async () => {
      const [native, web, relayWeb] = await Promise.all([
        nativeStore.list(),
        pushStore.list(),
        relayWebPush.available() ? relayWebPush.list() : [],
      ]);
      return new Set([...native, ...web, ...relayWeb].map((row) => row.clientId).filter(Boolean));
    },
    pushName: (): void => {
      sendEnvelope({ type: 'desktop-name', name: pcName() });
    },
    get clientCount() {
      return clients.size;
    },
    pairCode: (action) => {
      if (action === 'release') {
        pairCode.release();
        return null;
      }
      return pairCode.ensure(action === 'renew');
    },
    listClients: () =>
      control
        .request<DesktopRemoteClientInfo[]>('list-clients')
        .then((remoteClients) => (Array.isArray(remoteClients) ? remoteClients : [])),
    publishBrowserFrame: (frame) => browserStreams.publish(frame),
    sendBrowserWebrtcSignal: (clientId, signal) => browserWebrtc.send(clientId, signal),
    publishBrowserTabs: (tabs) => browserTabs.publish(tabs),
    publishBrowserImportProgress: (progress) =>
      broadcastEncrypted({ event: REMOTE_BROWSER_IMPORT_PROGRESS_EVENT, payload: progress }, false),
    viewsSessionLane: (sessionId, lane) =>
      [...clients.clients.values()].some((state) => clientViewsSessionLane(state, sessionId, lane)),
    revokeClient: async (clientId: string): Promise<void> => {
      // Unpaired (`clientId` is the credential): every live connection of it
      // loses screen access for good now, before anything is awaited. The
      // caller records the unpair first (`unpairPending`), which refuses its
      // connections, including new ones, until the relay confirms it.
      screenAccessPublisher.revokeCredential(clientId);
      browserStreams.dropClient(clientId);
      browserTabs.dropClient(clientId);
      deviceMethods.forgetDeviceName(clientId);
      if (!/^[0-9a-f-]{8,64}$/u.test(clientId)) throw new TypeError('Invalid remote client id.');
      // Unpaired: its download and link grants and transfers end now.
      fileDownloads.revokeDevice(clientId);
      deviceMethods.dropFileGrants(clientId);
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
    resume: () => {
      iceServers.invalidate();
      connection.resume();
    },
    suspend: () => iceServers.invalidate(),
    revoke: (): Promise<void> => {
      clients.dropParkedViews();
      fileDownloads.revokeAll();
      deviceMethods.clearFileGrants();
      return revokeDeviceOverSocket({ currentSocket: connection.currentSocket, closed: connection.closed });
    },
    close: async (): Promise<void> => {
      if (connection.closed()) return;
      connection.beginClose();
      unbindIceServers();
      socketDiagnostics.stop();
      fileDownloads.revokeAll();
      deviceMethods.clearFileGrants();
      resetTransportDeltas();
      // The socket close handler skips cleanup once the leg is terminated below.
      mediaLane.destroyAll();
      connection.cancelTimers();
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
      connection.terminate();
      clients.clear();
      control.rejectAll('Relay client is closed.');
    },
  };
}
