// Relay client for the installable web app: the desktop dials OUT to
// apps/relay/server.mjs and answers browser RPC frames, so a phone anywhere
// on the internet reaches this machine without port forwarding.
import { hostname } from 'node:os';

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
import {
  createRemoteCallStats,
  createRemoteSocketDiagnostics,
  reportRemoteByteWindow,
} from './remote-performance-diagnostics';
import {
  RELAY_FRAME_TOO_LARGE,
  readRelayPayloadRejection,
  relayPayloadRejectedFrame,
} from '../shared/remote-payload-limit';
import {
  createRemoteMethods,
  createSelectedFileGrants,
  type RemoteMethodDependencies,
  type SelectedFileGrants,
} from './remote-methods';
import { createFileDownloadService } from './file-downloads';
export { remoteTranscriptSnapshot } from './remote-transcript';
import { createNativePushStore, type NativePushSubscription } from './native-push-store';
import type { NativePushMessage } from './push-notifier';
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
import { createPairCodeManager, type PairCodeState, type PairCodeUnsupported } from './remote-pair-code';
import { createRelayEnvelopeDispatcher } from './remote-relay-envelope';
import { createRelayWebPush } from './remote-relay-web-push';
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
import { requestPhoneTranscriptPage } from './remote-transcript-window';
import { viewIsStale } from './remote-view-staleness';
import { createRelaySessionWiring, type RelayNotificationDeps } from './remote-relay-session-wiring';
import type { NotificationTestResult } from './notification-center';
// @ts-expect-error Relay framing is shared with the plain-ESM VPS server.
import { decodeRelayBinaryFrame } from '../../../relay/lib/relay-binary-frame.mjs';
import { DESKTOP_HANDSHAKE_STALLED_CLOSE } from '../../../relay/lib/relay-close-codes.mjs';

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
  /** This PC's name for handshakes, pair codes and the relay report; read each
   *  time so a rename applies without a restart. Defaults to the OS hostname. */
  hostName?: () => string;
  /** Local nickname for a paired device (credential id); wins over the relay's name. */
  deviceAlias?: (credentialId: string) => string;
  /** Each paired device's notification preferences (issue #221). */
  notifications?: RelayNotificationDeps;
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
const RELAY_HEARTBEAT_MS = 10_000;
/** A dial younger than this is not replaced by a resume or network change. */
const RELAY_DIAL_GRACE_MS = 5_000;
/** Reconnect backoff: the first delay after a drop, doubling up to the cap. */
const RELAY_RETRY_MIN_MS = 1_000;
const RELAY_RETRY_MAX_MS = 30_000;
/** How many DESKTOP_HANDSHAKE_STALLED_CLOSE closes in a row redial at once before the backoff applies. */
const RELAY_STALLED_IMMEDIATE_REDIALS = 2;
/** A leg that stays up this long is a recovery: the stall record and the
 *  backoff start over. */
const RELAY_STABLE_LEG_MS = 30_000;

export function startRelayHeartbeat(
  ws: WebSocket,
  intervalMs = RELAY_HEARTBEAT_MS
): { markAlive(): void; stop(): void } {
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
  }, intervalMs);
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
  // One method table per relay leg: the device name and stale-view state are
  // those of the credential the relay authenticated for it.
  const clientMethods = new WeakMap<RelayClientState, ReturnType<typeof createRemoteMethods>>();
  // Paired-device names come from the relay's own client list, keyed by the
  // credential it authenticated for the leg — the request never names itself.
  const deviceNames = new Map<string, string>();
  const deviceNameFor = async (credentialId: string): Promise<string> => {
    const alias = options.deviceAlias?.(credentialId);
    if (alias) return alias;
    const cached = deviceNames.get(credentialId);
    if (cached) return cached;
    let name = '';
    try {
      const paired = await control.request<DesktopRemoteClientInfo[]>('list-clients');
      name = Array.isArray(paired)
        ? String(paired.find((entry) => entry.id === credentialId)?.name || '')
            .trim()
            .slice(0, 80)
        : '';
    } catch {
      name = '';
    }
    if (name) deviceNames.set(credentialId, name);
    return name;
  };
  // Download grants and leases outlive one relay leg (a phone reconnects mid
  // transfer) and are bound to the paired device, so one service serves every
  // connection; unpair, session deletion and close end what it holds.
  // Leases also stream on the encrypted media lane (remote-relay-media.ts).
  const fileDownloads = createFileDownloadService({ host: options.host, mediaLane: true });
  // One-file link grants are bound to the paired device the same way: a
  // reconnect keeps the tokens the client already holds for linked files.
  const deviceFileGrants = new Map<string, SelectedFileGrants>();
  const fileGrantsFor = (credentialId: string): SelectedFileGrants | undefined => {
    if (!credentialId) return undefined;
    let grants = deviceFileGrants.get(credentialId);
    if (!grants) {
      grants = createSelectedFileGrants((sessionId) => fileDownloads.sessionRemoved(sessionId));
      deviceFileGrants.set(credentialId, grants);
    }
    return grants;
  };
  const methodsFor = (clientId: string, state: RelayClientState): ReturnType<typeof createRemoteMethods> => {
    let table = clientMethods.get(state);
    if (!table) {
      const selectedFileGrants = fileGrantsFor(state.credentialId);
      table = createRemoteMethods(
        {
          ...options,
          fileDownloads,
          ...(selectedFileGrants ? { selectedFileGrants } : {}),
          push: pushStore,
          nativePush: {
            platforms: () => caps.relayNativePlatforms(),
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
              for (const row of rows)
                sendEnvelope({ type: 'native-push-unbind', token: row.token, clientId: row.clientId });
              return removed;
            },
          },
        },
        {
          credentialId: () => state.credentialId,
          connectionId: () => clientId,
          deviceName: () => deviceNameFor(state.credentialId),
          staleView: (sessionId, device) => {
            const held = (
              state.sessionStateEncoders.get(sessionId)?.resumePoint()?.held as { items?: unknown[] } | null
            )?.items;
            const stale = viewIsStale(held, sessionStates.latestItems(sessionId), device);
            if (stale) sessionStates.refresh(sessionId);
            return stale;
          },
          viewedSessionIds: () => [...state.visibleSessionIds],
          heldTranscript: (sessionId) => state.sessionStateEncoders.get(sessionId)?.resumePoint()?.held ?? null,
          requestRead: (sessionId) => {
            state.requestedReads ??= new Set();
            state.requestedReads.add(sessionId);
          },
          requestTranscriptPage: (sessionId, limit) =>
            requestPhoneTranscriptPage(state.sessionStateEncoders.get(sessionId), limit),
          releaseRead: (sessionId) => state.requestedReads?.delete(sessionId),
        }
      );
      clientMethods.set(state, table);
    }
    return table;
  };
  let socket: WebSocket | null = null;
  let closed = false;
  let retryMs = RELAY_RETRY_MIN_MS;
  // Consecutive legs the relay closed as unresponsive, and the timer that
  // clears that record once a leg holds.
  let stalledStreak = 0;
  let stableTimer: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let connectStartedAt = 0;
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
  const pcName = (): string => (options.hostName?.() || hostname()).slice(0, 80);
  const pairCode = createPairCodeManager({
    sendEnvelope: (payload) => sendEnvelope(payload),
    hostName: () => pcName(),
  });
  const sendEnvelope = (payload: unknown): boolean => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(payload));
        return true;
      } catch {
        /* relay vanished */
      }
    }
    return false;
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
    if (!caps.relayNativePlatforms().includes(row.platform)) return;
    sendEnvelope({ type: 'native-push-bind', clientId: row.clientId, platform: row.platform, token: row.token });
  };
  const sendNativePush = (message: NativePushMessage): boolean => {
    if (!caps.relayNativePlatforms().includes(message.platform)) return false;
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
  const socketDiagnostics = createRemoteSocketDiagnostics({
    sample: () => ({
      clients: clients.size,
      sockets: [{ name: 'relay', bufferedAmount: socket?.bufferedAmount ?? 0 }],
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
    onEmpty: () => {
      socketDiagnostics.sync();
      // The last phone left: log the partial window rather than dropping it.
      const meterReport = relayByteMeter.clear();
      if (meterReport) reportRemoteByteWindow(meterReport);
      remoteCallStats.clear();
    },
  });
  const live = (clientId: string, state: RelayClientState): boolean => !closed && clients.attached(clientId, state);
  // Everything the relay declared for the CURRENT connection; reset on every
  // open. The broadcast it republishes through is resolved when it fires.
  const caps = createRelayConnectionCaps({
    clientCount: () => clients.size,
    broadcastEncrypted: (payload, droppable) => broadcastEncrypted(payload, droppable),
    rebindNativePush: () => {
      void nativeStore
        .list()
        .then((rows) => rows.forEach(bindNativePush))
        .catch(() => undefined);
    },
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
  const { sendEncryptedFrame, broadcastEncrypted } = createRelayEncryptedDelivery({
    clients,
    relayBinaryFrames: caps.relayBinaryFrames,
    relayFrameLimit: caps.relayFrameLimit,
    sendRawAndWait,
    byteMeter: relayByteMeter,
  });
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
    hostId: deviceId,
    nativePush: { store: nativeStore, send: sendNativePush },
    relayWebPush,
    ...(options.notifications ? { notifications: options.notifications } : {}),
    live,
    closed: () => closed,
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
    closed: () => closed,
  });
  const mediaLane = (options.createMediaLane ?? createRelayMediaLane)({
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
    hostName: pcName,
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
    onNativePushResult: handleNativePushResult,
    onWebPushSubscriptions: relayWebPush.update,
    onWebPushResult: relayWebPush.onResult,
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
      caps.learnRefusedFrameLimit(rejection);
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
    // One live connection attempt at a time: a pending redial is replaced by
    // this call, and an existing socket is never shadowed by a second one.
    if (closed || socket) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connectStartedAt = Date.now();
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
      // An open after ordinary drops restarts the backoff, as it always has.
      // After stalled-handshake closes it does not: the leg must HOLD first.
      if (stalledStreak === 0) retryMs = RELAY_RETRY_MIN_MS;
      clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        stalledStreak = 0;
        retryMs = RELAY_RETRY_MIN_MS;
      }, RELAY_STABLE_LEG_MS);
      stableTimer.unref?.();
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
    ws.on('close', (code) => {
      heartbeat.stop();
      // A superseded socket owns none of the shared state and schedules nothing.
      if (socket !== ws) return;
      socket = null;
      // Every phone leg ended with this one; resumable lanes are parked for
      // the replayed client-open on the next leg (see the open handler).
      clients.parkAll();
      resetTransportDeltas();
      mediaLane.destroyAll();
      if (closed) return;
      control.rejectAll('Relay disconnected.');
      clearTimeout(stableTimer);
      // The relay judged this leg dead while a joining phone waited on it.
      // That phone is still inside its own handshake budget, so the first
      // few replacements dial at once. A leg that keeps getting closed this
      // way is not recovering, though: past the limit it waits out the
      // ordinary backoff, which only a leg that holds resets.
      const stalled = code === DESKTOP_HANDSHAKE_STALLED_CLOSE;
      if (stalled) stalledStreak += 1;
      const immediate = stalled && stalledStreak <= RELAY_STALLED_IMMEDIATE_REDIALS;
      reconnectTimer = setTimeout(
        () => {
          reconnectTimer = null;
          connect();
        },
        immediate ? 0 : retryMs
      );
      reconnectTimer.unref?.();
      if (!immediate) retryMs = Math.min(RELAY_RETRY_MAX_MS, retryMs * 2);
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
    publishBrowserTabs: (tabs) => browserTabs.publish(tabs),
    publishBrowserImportProgress: (progress) =>
      broadcastEncrypted({ event: REMOTE_BROWSER_IMPORT_PROGRESS_EVENT, payload: progress }, false),
    viewsSessionLane: (sessionId, lane) =>
      [...clients.clients.values()].some((state) => clientViewsSessionLane(state, sessionId, lane)),
    revokeClient: async (clientId: string): Promise<void> => {
      browserStreams.dropClient(clientId);
      browserTabs.dropClient(clientId);
      deviceNames.delete(clientId);
      if (!/^[0-9a-f-]{8,64}$/u.test(clientId)) throw new TypeError('Invalid remote client id.');
      // Unpaired: its download and link grants and transfers end now.
      fileDownloads.revokeDevice(clientId);
      deviceFileGrants.delete(clientId);
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
      retryMs = RELAY_RETRY_MIN_MS;
      if (reconnectTimer) {
        connect();
        return;
      }
      if (socket) {
        // An attempt that is still dialing is the fresh connection already.
        if (socket.readyState === WebSocket.CONNECTING && Date.now() - connectStartedAt < RELAY_DIAL_GRACE_MS) return;
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
      fileDownloads.revokeAll();
      deviceFileGrants.clear();
      return revokeDeviceOverSocket({ currentSocket: () => socket, closed: () => closed });
    },
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      socketDiagnostics.stop();
      fileDownloads.revokeAll();
      deviceFileGrants.clear();
      resetTransportDeltas();
      // The socket close handler skips cleanup once `socket` is cleared below.
      mediaLane.destroyAll();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearTimeout(stableTimer);
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
