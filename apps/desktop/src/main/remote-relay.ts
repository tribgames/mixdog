// Relay client for the installable web app: the desktop dials OUT to
// apps/relay/server.mjs and answers browser RPC frames, so a phone anywhere
// on the internet reaches this machine without port forwarding.
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, statSync, type ReadStream } from 'node:fs';
import { join } from 'node:path';

import WebSocket from 'ws';

import { mediaResponsePlan } from '../../../relay/lib/media-http.mjs';
import type {
  DesktopAgentPoolRow,
  DesktopRemoteClientInfo,
  DesktopSessionStateUpdate,
  DesktopSessionSummary,
} from '../shared/contract';
import { loadOrCreatePairingToken } from './remote-pairing-token';
import {
  acceptRelayE2EEClientHello,
  createRelayE2EEChallenge,
  isRelayClaimPublicKey,
  isRelayE2EEHello,
  relayE2EECompressionSupported,
  relayE2EEPairingMaterial,
  sealRelayE2EEPairingMaterial,
  type RelayE2EEChannel,
  type RelayE2EEChallenge,
  type RelayE2EEPairingMaterial,
} from '../shared/remote-e2ee';
import {
  createRemoteByteMeter,
  createRemotePaintProbeTracker,
  formatRemoteByteReport,
} from '../shared/remote-performance';
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
import { createKeyedListDeltaEncoder } from '../shared/list-delta';
import { resolveMediaFileTarget } from './media-source';
import {
  createRemoteMethods,
  executeRemoteFrame,
  type RemoteMethodDependencies,
} from './remote-methods';
import { loadOrCreateRelayE2EEIdentity } from './remote-e2ee';
import { readSecretFile, writeSecretFile } from './secret-file';
import { createSnapshotDeltaEncoder, isNoDelta, isStateResyncFrame } from './state-delta';
import { TerminalDataBufferer } from './terminal-data-buffer';
import {
  createLatestStateMailbox,
  type LatestStateMailbox,
} from './desktop-service-protocol';
// @ts-expect-error Relay framing is shared with the plain-ESM VPS server.
import { decodeRelayBinaryFrame, encodeRelayBinaryFrame } from '../../../relay/lib/relay-binary-frame.mjs';

// Transport cap for ONE message on this leg. It sits above the relay's 64 MiB
// policy ceiling on purpose: a policy-sized phone frame arrives here wrapped in
// the relay's fixed 42-byte routing header, and a transport that stopped at the
// policy number would kill the socket (1009) over the wrapper alone. The text
// flag keeps that wrapper fixed — JSON escaping is no longer in this path — so
// a small, constant headroom is all it takes.
const MAX_WS_PAYLOAD_BYTES = 68 * 1024 * 1024;
const REVOKE_TIMEOUT_MS = 5_000;
const E2EE_HANDSHAKE_TIMEOUT_MS = 10_000;
export const MAX_ACTIVE_REMOTE_CLIENTS = 32;
export const MAX_PENDING_REMOTE_FRAMES = 256;
export const MAX_PENDING_REMOTE_FRAME_BYTES = MAX_WS_PAYLOAD_BYTES;
export const MAX_PENDING_REMOTE_TOTAL_FRAMES = 512;
export const MAX_PENDING_REMOTE_TOTAL_BYTES = MAX_WS_PAYLOAD_BYTES * 2;
// Media chunk size and the socket backlog that pauses the read. Bigger frames
// waste memory on the relay, smaller ones waste round trips; 256 KB keeps a
// clip flowing while a phone that stalls stops the pump within a few frames.
const MEDIA_CHUNK_BYTES = 256 * 1024;
const MEDIA_SOCKET_BACKLOG_BYTES = 4 * 1024 * 1024;

/** Packaged default: every install dials this relay so phone pairing works
 *  out of the box, with no VPS/env setup on the user side.
 *  MIXDOG_RELAY_URL=<wss url> overrides; 0/false/off disables. */
const DEFAULT_RELAY_URL = 'wss://192-255-139-161.sslip.io';

function validatedRelayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError('MIXDOG_RELAY_URL is invalid.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new TypeError('MIXDOG_RELAY_URL must use wss://; ws:// is allowed only for loopback development.');
  }
  if (url.username || url.password) {
    throw new TypeError('MIXDOG_RELAY_URL must not contain credentials.');
  }
  return url.toString();
}

export function resolveRelayUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.MIXDOG_RELAY_URL || '').trim();
  const flag = raw.toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return null;
  return validatedRelayUrl(raw || DEFAULT_RELAY_URL);
}

export interface RemoteRelayOptions extends RemoteMethodDependencies {
  /** ws(s)://relay-host[:port] */
  relayUrl: string;
  userDataPath: string;
  subscribeTerminalData?: (listener: (event: { id: string; data: string }) => void) => () => void;
  onClientCountChanged?: () => void;
  /** The relay refused an oversize frame this desktop sent and could not say
   *  which client it belonged to. Reported so the user sees it; it names no
   *  call and reaches no phone, because either would blame the wrong one. */
  onRelayPayloadRefused?: (detail: { bytes: number | null; limit: number | null }) => void;
  /** Ask the user to approve one credential-less container. Resolving false
   *  (or throwing) denies it; the relay never decides this. */
  onClientClaim?: (claim: RemoteClientClaim) => Promise<boolean>;
}

/** One browser container asking this desktop for access. It holds no
 *  credential: the answer here is the credential. */
export interface RemoteClientClaim {
  claimId: string;
  clientId: string;
  name: string;
  platform: string;
  browser: string;
  expiresAt: number;
}

export interface RemoteRelayHandle {
  /** URL a phone opens: the relay origin plus this desktop's device route. */
  clientUrl: string;
  token: string;
  pairing: RelayE2EEPairingMaterial;
  readonly clientCount: number;
  listClients(): Promise<DesktopRemoteClientInfo[]>;
  revokeClient(clientId: string): Promise<void>;
  /** System resume: the socket is likely half-dead after sleep — drop it and
   *  redial immediately instead of waiting for the ping cycle to notice. */
  resume(): void;
  /** Delete this install's authenticated registration from the relay. */
  revoke(): Promise<void>;
  close(): Promise<void>;
}

export interface DeviceIdentity {
  deviceId: string;
  deviceSecret: string;
}

export function remoteFrameBudgetAvailable(
  pendingFrames: number,
  pendingBytes: number,
  nextBytes: number,
  totalPendingFrames = pendingFrames,
  totalPendingBytes = pendingBytes,
): boolean {
  return pendingFrames < MAX_PENDING_REMOTE_FRAMES
    && pendingBytes + nextBytes <= MAX_PENDING_REMOTE_FRAME_BYTES
    && totalPendingFrames < MAX_PENDING_REMOTE_TOTAL_FRAMES
    && totalPendingBytes + nextBytes <= MAX_PENDING_REMOTE_TOTAL_BYTES;
}

/** A push lane reaches a browser that registered it, or one that predates the
 *  lane protocol and therefore still expects everything. An empty set is a
 *  deliberate "nothing right now", not a missing registration. */
export function clientReadsLane(lanes: ReadonlySet<string> | null, lane: string): boolean {
  return lanes === null || lanes.has(lane);
}

// Provider replay material, not display data: `thinkingBlocks` are Anthropic's
// thinking/redacted_thinking blocks, kept so a later request can hand the model
// its own prior reasoning back verbatim. No renderer reads them, and in a long
// session they are a THIRD of the stored transcript — bytes a phone pays for on
// every join and can never show.
const REMOTE_TRANSCRIPT_DROP_FIELDS = ['thinkingBlocks', 'providerReplay'] as const;
// Item identity is what makes the delta encoder cheap: it compares elements by
// reference, so an unchanged item MUST project to the same object every time.
const projectedTranscriptItems = new WeakMap<object, object>();

function remoteTranscriptItem(item: unknown): unknown {
  if (!item || typeof item !== 'object') return item;
  const cached = projectedTranscriptItems.get(item as object);
  if (cached) return cached;
  let projected: Record<string, unknown> | null = null;
  for (const field of REMOTE_TRANSCRIPT_DROP_FIELDS) {
    if (!Object.hasOwn(item, field)) continue;
    projected ??= { ...(item as Record<string, unknown>) };
    delete projected[field];
  }
  const result = projected ?? item;
  projectedTranscriptItems.set(item as object, result as object);
  return result;
}

/** The transcript as a REMOTE client sees it. Returns the original snapshot
 *  untouched when nothing was dropped, so the encoder keeps its fast path. */
export function remoteTranscriptSnapshot(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const record = snapshot as Record<string, unknown>;
  if (!Array.isArray(record.items)) return snapshot;
  let dropped = false;
  const items = record.items.map((item) => {
    const projected = remoteTranscriptItem(item);
    if (projected !== item) dropped = true;
    return projected;
  });
  return dropped ? { ...record, items } : snapshot;
}

// What a phone opens a session to: the end of it. The list is virtualized, so
// rows above the viewport are never drawn — but the whole array is still
// decompressed, parsed and allocated before the first of them can paint, and a
// long session measured 1.5MB of JSON for a screen that shows a handful of
// turns. The window is what the phone receives; the desktop keeps everything.
export const REMOTE_TRANSCRIPT_WINDOW_ITEMS = 60;
const REMOTE_TRANSCRIPT_WINDOW_START = 'transcriptWindowStart';

/** The window START is fixed the first time a client sees a session and then
 *  only ever grows with appends. Sliding it would rewrite index 0 on every new
 *  turn, and the delta encoder compares from index 0 — one appended item would
 *  cost a full window resend. It moves only when the transcript itself became
 *  shorter than the floor (compaction, rollback, a different session). */
function windowedTranscript(
  snapshot: unknown,
  sessionId: string,
  floors: Map<string, number>,
): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const record = snapshot as Record<string, unknown>;
  const items = record.items;
  if (!Array.isArray(items)) return snapshot;
  let floor = floors.get(sessionId);
  if (floor === undefined || floor > items.length) {
    floor = Math.max(0, items.length - REMOTE_TRANSCRIPT_WINDOW_ITEMS);
    floors.set(sessionId, floor);
  }
  if (floor === 0) return snapshot;
  return {
    ...record,
    items: items.slice(floor),
    // Named on the wire so a receiver can tell "this session starts here" from
    // "this session is short", which is what any later backfill needs to ask.
    [REMOTE_TRANSCRIPT_WINDOW_START]: floor,
  };
}

/** Encode one transcript lane against exactly one relay client's baseline. */
export function encodeRelayClientSessionState(
  encoders: Map<string, ReturnType<typeof createSnapshotDeltaEncoder>>,
  sessionId: string,
  snapshot: unknown,
  compact = false,
  windowFloors?: Map<string, number>,
): unknown {
  let encoder = encoders.get(sessionId);
  if (!encoder) {
    encoder = createSnapshotDeltaEncoder({ compact });
    encoders.set(sessionId, encoder);
  }
  const projected = remoteTranscriptSnapshot(snapshot);
  return encoder.encode(windowFloors
    ? windowedTranscript(projected, sessionId, windowFloors)
    : projected);
}

export function buildRelayMediaResponsePlan(input: {
  size: number;
  mime: string;
  assetId: string;
  variant: string;
  rangeHeader: string;
  ifNoneMatch: string;
}) {
  return mediaResponsePlan({
    ...input,
    // The browser may retain bytes, but every reuse must revalidate through
    // the relay token gate so Unpair revokes access immediately. ETags keep
    // unchanged content at 304 without re-downloading it.
    cacheControl: 'private, no-cache',
  });
}

const DEVICE_IDENTITY_FILE = 'relay-device.json';
const DEVICE_REVOCATIONS_FILE = 'relay-device-revocations.json';
let deviceFileMutation: Promise<void> = Promise.resolve();

function validDeviceIdentity(value: unknown): value is DeviceIdentity {
  const identity = value as Partial<DeviceIdentity> | null;
  return typeof identity?.deviceId === 'string' && /^[0-9a-f-]{8,64}$/.test(identity.deviceId)
    && typeof identity.deviceSecret === 'string' && identity.deviceSecret.length >= 16;
}

async function writeDeviceIdentity(path: string): Promise<DeviceIdentity> {
  const identity = { deviceId: randomUUID(), deviceSecret: randomBytes(24).toString('hex') };
  await writeSecretFile(path, JSON.stringify(identity, null, 2));
  return identity;
}

async function loadQueuedRevocations(userDataPath: string): Promise<DeviceIdentity[]> {
  try {
    const parsed = JSON.parse(
      await readSecretFile(join(userDataPath, DEVICE_REVOCATIONS_FILE)) ?? '[]',
    ) as unknown;
    return Array.isArray(parsed) ? parsed.filter(validDeviceIdentity) : [];
  } catch {
    return [];
  }
}

async function writeQueuedRevocations(
  userDataPath: string,
  identities: DeviceIdentity[],
): Promise<void> {
  await writeSecretFile(
    join(userDataPath, DEVICE_REVOCATIONS_FILE),
    JSON.stringify(identities, null, 2),
  );
}

function mutateDeviceFiles<T>(operation: () => Promise<T>): Promise<T> {
  const result = deviceFileMutation.then(operation, operation);
  deviceFileMutation = result.then(() => undefined, () => undefined);
  return result;
}

// Stable per-install identity for the relay's trust-on-first-use device
// registration; the secret never leaves this machine except toward the relay.
// It authenticates this desktop's leg, so it lives in an owner-only file.
async function loadOrCreateDevice(userDataPath: string): Promise<DeviceIdentity> {
  const path = join(userDataPath, DEVICE_IDENTITY_FILE);
  try {
    const parsed = JSON.parse(await readSecretFile(path) ?? 'null') as unknown;
    if (validDeviceIdentity(parsed)) {
      return { deviceId: parsed.deviceId, deviceSecret: parsed.deviceSecret };
    }
  } catch { /* first run */ }
  return writeDeviceIdentity(path);
}

/** Queue the current identity for authenticated server-side deletion, then
 * replace it immediately so Unpair can refresh QRs even while the VPS is down. */
export async function rotateRemoteDevice(userDataPath: string): Promise<DeviceIdentity> {
  return mutateDeviceFiles(async () => {
    const previous = await loadOrCreateDevice(userDataPath);
    const queued = await loadQueuedRevocations(userDataPath);
    if (!queued.some((identity) => identity.deviceId === previous.deviceId)) {
      await writeQueuedRevocations(userDataPath, [...queued, previous]);
    }
    return writeDeviceIdentity(join(userDataPath, DEVICE_IDENTITY_FILE));
  });
}

async function removeQueuedRevocation(userDataPath: string, deviceId: string): Promise<void> {
  await mutateDeviceFiles(async () => {
    const queued = await loadQueuedRevocations(userDataPath);
    await writeQueuedRevocations(
      userDataPath,
      queued.filter((identity) => identity.deviceId !== deviceId),
    );
  });
}

export function relayDeviceSocketOptions(
  relayUrl: string,
  identity: DeviceIdentity,
): { url: string; headers: Record<string, string> } {
  const target = new URL(validatedRelayUrl(relayUrl));
  target.pathname = '/desktop';
  target.search = '';
  target.hash = '';
  return {
    url: target.toString(),
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${identity.deviceId}:${identity.deviceSecret}`,
        'utf8',
      ).toString('base64')}`,
    },
  };
}

function revokeIdentity(
  relayUrl: string,
  identity: DeviceIdentity,
  sockets: Set<WebSocket>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = relayDeviceSocketOptions(relayUrl, identity);
    const ws = new WebSocket(connection.url, {
      headers: connection.headers,
      maxPayload: MAX_WS_PAYLOAD_BYTES,
      // Frames on this leg are E2EE ciphertext (incompressible) or small
      // control envelopes; payload compression happens inside the encrypted
      // envelope instead. Transport deflate only cost CPU on both ends.
      perMessageDeflate: false,
    });
    sockets.add(ws);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      sockets.delete(ws);
      try { ws.terminate(); } catch { /* already gone */ }
      resolve(ok);
    };
    const timeout = setTimeout(() => finish(false), REVOKE_TIMEOUT_MS);
    timeout.unref?.();
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'revoke-device' }), (error) => {
        if (error) finish(false);
      });
    });
    ws.on('message', (raw) => {
      let message: { type?: unknown; ok?: unknown };
      try {
        message = JSON.parse(String(raw)) as { type?: unknown; ok?: unknown };
      } catch {
        return;
      }
      if (message.type === 'device-revoked') finish(message.ok !== false);
    });
    ws.once('error', () => finish(false));
    ws.once('close', () => finish(false));
  });
}

/** The entry URL carries a ROUTE, not a credential: it only says which desktop
 *  to ask. An install captures this URL through the manifest's start_url, which
 *  is what lets a freshly installed web app — a storage container that can
 *  inherit nothing — request approval from the right machine. */
function relayClientUrl(relayUrl: string, deviceId: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = `/d/${deviceId}/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

// A phone gives up on an unanswered call at 20s (renderer remote-shim), closes
// the socket and reconnects into a full resync. Anything approaching that is
// already a broken session, so the threshold is low enough to catch the call
// that got there while staying silent for ordinary work.
const SLOW_REMOTE_CALL_MS = 2_000;
// The byte meter reports one `rpc` total per window, which cannot say whether
// that was one heavy answer or eighty cheap ones. A phone's first minute spends
// hundreds of KB across dozens of calls; naming them is what makes that
// reducible instead of merely visible.
const REMOTE_CALL_REPORT_MS = 60_000;
const remoteCallStats = new Map<string, { calls: number; ms: number }>();
let remoteCallStatsSince = Date.now();

function noteRemoteCall(method: string, elapsedMs: number): void {
  const row = remoteCallStats.get(method) ?? { calls: 0, ms: 0 };
  row.calls += 1;
  row.ms += elapsedMs;
  remoteCallStats.set(method, row);
  const window = Date.now() - remoteCallStatsSince;
  if (window < REMOTE_CALL_REPORT_MS) return;
  const busiest = [...remoteCallStats.entries()]
    .sort((left, right) => right[1].calls - left[1].calls)
    .slice(0, 8)
    .map(([name, stats]) => `${name}=${stats.calls}x/${Math.round(stats.ms)}ms`);
  const calls = [...remoteCallStats.values()].reduce((total, stats) => total + stats.calls, 0);
  console.error(`[mixdog-remote-calls] ${Math.round(window / 1000)}s calls=${calls}`
    + ` | ${busiest.join(' ')}`);
  remoteCallStats.clear();
  remoteCallStatsSince = Date.now();
}

export async function startRemoteRelay(options: RemoteRelayOptions): Promise<RemoteRelayHandle> {
  const relayUrl = validatedRelayUrl(options.relayUrl);
  const token = await loadOrCreatePairingToken(options.userDataPath);
  const { deviceId, deviceSecret } = await loadOrCreateDevice(options.userDataPath);
  const clientUrl = relayClientUrl(relayUrl, deviceId);
  const e2eeIdentity = await loadOrCreateRelayE2EEIdentity(options.userDataPath);
  const pairing = relayE2EEPairingMaterial(e2eeIdentity);
  const methods = createRemoteMethods(options);
  let socket: WebSocket | null = null;
  let closed = false;
  let relayBinaryFrames = false;
  // Echoed by the relay when it accepts this leg's `textFrames` request. Reset
  // per connection with the capabilities frame that sets it.
  let relayTextFrames = false;
  let retryMs = 1_000;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let drainingRevocations = false;
  const revocationSockets = new Set<WebSocket>();
  // The relay fans one broadcast lane out to every phone, so ONE shared
  // encoder tracks the delta stream; any client join or resync request
  // resets it, which downgrades the next push to a full snapshot for all.
  const deltaEncoder = createSnapshotDeltaEncoder();
  // Compact clients keep their own baseline. Two encoders cover any number of
  // phones, so the fan-out cost does not grow with the audience.
  const compactDeltaEncoder = createSnapshotDeltaEncoder({ compact: true });
  // Phones currently attached through the relay (client-open/-close
  // envelopes). With zero phones the relay would drop every broadcast on
  // the floor anyway, so the desktop goes quiet instead of streaming state
  // upstream 24/7 — the relay lane then costs keepalive bytes only. Each
  // join restarts the delta lane with a full snapshot, so nothing is lost.
  interface RelayClientState {
    challenge: RelayE2EEChallenge;
    channel: RelayE2EEChannel | null;
    handshakeTimer: NodeJS.Timeout;
    frameQueue: Promise<void>;
    pendingFrames: number;
    pendingBytes: number;
    visibleSessionIds: Set<string>;
    /** Transcript delta baselines are receiver-specific. A shared encoder
     *  advances even for clients filtered out of a session, so their first
     *  later frame would otherwise be an undecodable patch. */
    sessionStateEncoders: Map<string, ReturnType<typeof createSnapshotDeltaEncoder>>;
    binaryFrames: boolean;
    listDelta: boolean;
    /** Compact transcript frames: unchanged patch sections are dropped and the
     *  envelope addresses a session by handle. */
    compactWire: boolean;
    /** Push lanes this browser actually reads ('terminal', 'editor',
     *  'files'). Terminal output, diagnostics and folder events are produced
     *  by DESKTOP activity — a build, a save — and used to reach every paired
     *  phone whether or not it had those surfaces open, so a phone left
     *  connected paid for a whole build log it never displayed. null means a
     *  client that predates this and still receives everything. */
    lanes: Set<string> | null;
    /** Per-client session handles: a live frame repeats the session id ~26
     *  bytes at a time, which is most of an envelope that carries ~30 bytes of
     *  new text. The name travels once, with the handle that replaces it. */
    sessionHandles: Map<string, number>;
    sessionsEncoder: ReturnType<typeof createKeyedListDeltaEncoder<DesktopSessionSummary>>;
    agentPoolEncoder: ReturnType<typeof createKeyedListDeltaEncoder<DesktopAgentPoolRow>>;
    /** What a returning phone actually waits for: the shell paints in ~250ms
     *  and then shows nothing until the FIRST transcript frame for the session
     *  it restored. Everything in between — E2EE handshake, layout restore,
     *  the visible-session registration, the host's own read — happens here,
     *  and no counter in this process could tell that gap from a slow link. */
    openedAt: number;
    firstTranscriptReported: boolean;
    /** Per-session transcript window start, fixed on first sight. */
    sessionWindowFloors: Map<string, number>;
  }
  const activeClients = new Map<string, RelayClientState>();
  let totalPendingFrames = 0;
  let totalPendingBytes = 0;
  const controlRequests = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  const notifyClientCount = (): void => options.onClientCountChanged?.();
  // Media streams currently pumping to the relay, keyed by request id: an
  // aborted phone request (scrolled away, closed tab) must stop the read.
  // Two independent stalls can pause a pump — this socket's backlog, and the
  // relay's flow control for a phone that stopped draining (the local
  // backlog never sees that one, because the relay reads eagerly) — so the
  // read only resumes once BOTH are clear.
  interface MediaPump { stream: ReadStream; relayPaused: boolean; socketFull: boolean }
  const mediaStreams = new Map<string, MediaPump>();
  const resumeMedia = (id: string): void => {
    const pump = mediaStreams.get(id);
    if (!pump || pump.relayPaused || pump.socketFull) return;
    pump.stream.resume();
  };

  const sendEnvelope = (payload: unknown): void => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify(payload)); } catch { /* relay vanished */ }
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
  const controlRequest = <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Relay is not connected.'));
        return;
      }
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        controlRequests.delete(requestId);
        reject(new Error('Relay device request timed out.'));
      }, REVOKE_TIMEOUT_MS);
      timer.unref?.();
      controlRequests.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      sendEnvelope({ type, requestId, ...payload });
    });
  const removeClient = (clientId: string): boolean => {
    const state = activeClients.get(clientId);
    if (!state) return false;
    clearTimeout(state.handshakeTimer);
    activeClients.delete(clientId);
    const scopedHost = options.host as typeof options.host & {
      setVisibleSessionsForSource?(sourceId: string, ids: string[]): Promise<boolean>;
    };
    void scopedHost.setVisibleSessionsForSource?.(`remote:${clientId}`, []).catch(() => {});
    return true;
  };
  const clearClients = (): void => {
    if (activeClients.size === 0) return;
    for (const clientId of [...activeClients.keys()]) removeClient(clientId);
    notifyClientCount();
  };
  const closeClient = (clientId: string, reason: string): void => {
    if (removeClient(clientId)) notifyClientCount();
    sendEnvelope({ type: 'close-client', clientId, reason });
  };
  // The relay's per-frame ceiling as this desktop knows it. `relay-capabilities`
  // declares it at handshake; a `frame-too-large` notice proves a smaller one.
  // The effective limit is the smallest known value, so this leg's own check is
  // never more permissive than the relay's.
  let declaredFrameLimit: number | null = null;
  let noticedFrameLimit: number | null = null;
  const relayFrameLimit = (): number =>
    resolveRelayFrameLimit(declaredFrameLimit, noticedFrameLimit);
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
  };
  /** What a phone may put on the wire for this connection, as advertised to
   *  the browser: the relay's published ceilings, bounded by any smaller
   *  policy ceiling a refusal notice has proved since. */
  const relayUplinkLimits = (): RelayUplinkCeilings => relayUplinkContract(
    relayPublishedCeilings,
    { policy: relayFrameLimit(), textFrames: relayTextFrames },
  );
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
  const relayRoutingCapsPayload = (
    uplink: RelayUplinkCeilings,
  ): Record<string, unknown> => ({
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
    if (activeClients.size === 0) return;
    // Never droppable: losing this frame IS the failure it exists to prevent.
    broadcastEncrypted({ event: RELAY_ROUTING_CAPS_EVENT, payload }, false);
  };
  // Bandwidth attribution for this leg, in the relay's own billing unit. On by
  // default: this daemon outlives every window and defers its own shutdown
  // while a phone is attached, so a flag set when launching the app would
  // almost never reach the process that actually relays. Two integer adds per
  // frame and one log line a minute is not a cost worth gating behind that.
  // MIXDOG_REMOTE_METER=0 opts out.
  const relayByteMeter = createRemoteByteMeter({
    enabled: process.env.MIXDOG_REMOTE_METER !== '0',
  });
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
  ): Promise<void> => {
    const state = activeClients.get(clientId);
    if (!state?.channel) return;
    try {
      const binary = relayBinaryFrames && state.binaryFrames;
      const wire: string | Uint8Array = binary
        ? encodeRelayBinaryFrame({
          clientId,
          data: await state.channel.encryptBinary(payload),
          droppable,
        })
        : JSON.stringify({
          type: 'frame',
          clientId,
          data: await state.channel.encryptJson(payload),
          ...(droppable ? { droppable: true } : {}),
        });
      // Measured exactly as the relay charges it: the declared payload length
      // of the whole outgoing message (apps/relay/server.mjs frameBytes).
      const bytes = relayFrameByteLength(wire);
      const refusal = guardOversize
        ? relayFrameRefusal(bytes, relayFrameLimit(), relayFrameCallId(payload))
        : null;
      if (refusal) {
        // Never sent: the relay would refuse it, and nothing downstream could
        // say whose frame it was. Answer the waiting call instead.
        await deliverEncryptedFrame(
          clientId,
          relayPayloadRejectedFrame(refusal),
          false,
          false,
        );
        return;
      }
      // Metered where the frame is committed, so a refused one never counts as
      // traffic that was never sent.
      const meterReport = relayByteMeter.record(payload, bytes);
      if (meterReport) console.error(formatRemoteByteReport(meterReport));
      await sendRawAndWait(wire);
    } catch {
      closeClient(clientId, 'relay encryption failed');
    }
  };
  const sendEncryptedFrame = (
    clientId: string,
    payload: unknown,
    droppable = false,
  ): Promise<void> => deliverEncryptedFrame(clientId, payload, droppable, true);
  const broadcastEncryptedAsync = (
    payload: unknown,
    droppable: boolean,
    include: (state: RelayClientState) => boolean = () => true,
  ): Promise<void> => Promise.all(
    [...activeClients].map(([clientId, state]) =>
      state.channel && include(state)
        ? sendEncryptedFrame(clientId, payload, droppable)
        : Promise.resolve()),
  ).then(() => undefined);
  const broadcastEncrypted = (
    payload: unknown,
    droppable: boolean,
    include?: (state: RelayClientState) => boolean,
  ): void => {
    void broadcastEncryptedAsync(payload, droppable, include);
  };
  const readsLane = (lane: string) => (state: RelayClientState): boolean =>
    clientReadsLane(state.lanes, lane);
  type StatePublication = { snapshot: unknown; critical: boolean };
  let stateMailbox!: LatestStateMailbox<StatePublication>;
  stateMailbox = createLatestStateMailbox<StatePublication>((sequence, publication) => {
    // Each shape is encoded at most once per publication, and only when a
    // client that reads it is actually attached.
    let legacyFrame: unknown;
    let compactFrame: unknown;
    let legacyWire: unknown;
    let compactWire: unknown;
    void Promise.all([...activeClients].map(([clientId, state]) => {
      if (!state.channel) return Promise.resolve();
      if (state.compactWire) {
        compactWire ??= compactDeltaEncoder.encode(publication.snapshot);
        // A publication that moved nothing this client holds is not a frame.
        if (isNoDelta(compactWire)) return Promise.resolve();
        compactFrame ??= { e: 'S', w: compactWire };
        return sendEncryptedFrame(clientId, compactFrame, !publication.critical);
      }
      legacyWire ??= deltaEncoder.encode(publication.snapshot);
      if (isNoDelta(legacyWire)) return Promise.resolve();
      legacyFrame ??= { event: 'state', payload: legacyWire };
      return sendEncryptedFrame(clientId, legacyFrame, !publication.critical);
    })).finally(() => stateMailbox.acknowledge(sequence));
  });
  const sessionStateMailboxes = new Map<string, LatestStateMailbox<DesktopSessionStateUpdate>>();
  const remotePaintProbes = createRemotePaintProbeTracker({
    enabled: process.env.MIXDOG_DESKTOP_PERF === '1',
  });
  const sessionStateMailbox = (
    sessionId: string,
  ): LatestStateMailbox<DesktopSessionStateUpdate> => {
    const retained = sessionStateMailboxes.get(sessionId);
    if (retained) return retained;
    let mailbox!: LatestStateMailbox<DesktopSessionStateUpdate>;
    mailbox = createLatestStateMailbox<DesktopSessionStateUpdate>((sequence, update) => {
      const perfProbe = remotePaintProbes.issue(sessionId);
      void Promise.all([...activeClients].map(([clientId, state]) => {
        if (!state.channel || !state.visibleSessionIds.has(sessionId)) {
          return Promise.resolve();
        }
        const wire = encodeRelayClientSessionState(
          state.sessionStateEncoders,
          sessionId,
          update.snapshot,
          state.compactWire,
          state.sessionWindowFloors,
        );
        // This client's baseline already matches the snapshot: the frame would
        // carry a revision number and nothing else.
        if (isNoDelta(wire)) return Promise.resolve();
        if (!state.firstTranscriptReported) {
          state.firstTranscriptReported = true;
          // Sized once, on the frame that ends the wait — never on the stream
          // behind it.
          const bytes = JSON.stringify(wire)?.length ?? 0;
          console.error('[mixdog-remote-first-transcript]'
            + ` ms=${Date.now() - state.openedAt} bytes=${Math.round(bytes / 1024)}KB`);
        }
        if (!state.compactWire) {
          return sendEncryptedFrame(clientId, {
            event: 'sessionState',
            payload: {
              sessionId,
              wire,
              frameSource: update.frameSource,
              ...(update.laneEnd ? { laneEnd: update.laneEnd } : {}),
              ...(perfProbe ? { perfProbe } : {}),
              ...(typeof update.contentRevision === 'number'
                ? { contentRevision: update.contentRevision }
                : {}),
            },
          }, true);
        }
        // Compact envelope. The nested event/payload/sessionId trio costs
        // ~110 bytes on a frame whose new content is often ~30, so the keys
        // shrink to single letters and the session travels as a handle whose
        // name is sent once (`n`).
        let handle = state.sessionHandles.get(sessionId);
        const firstUse = handle === undefined;
        if (handle === undefined) {
          handle = state.sessionHandles.size + 1;
          state.sessionHandles.set(sessionId, handle);
        }
        return sendEncryptedFrame(clientId, {
          e: 'T',
          s: handle,
          ...(firstUse ? { n: sessionId } : {}),
          w: wire,
          // 'live' is the overwhelming default; only a replay announces itself.
          ...(update.frameSource && update.frameSource !== 'live'
            ? { f: update.frameSource }
            : {}),
          // Only a null frame carries it, so the key never rides a streaming one.
          ...(update.laneEnd ? { le: update.laneEnd } : {}),
          ...(perfProbe ? { pp: perfProbe } : {}),
          ...(typeof update.contentRevision === 'number' ? { cr: update.contentRevision } : {}),
        }, true);
      })).finally(() => mailbox.acknowledge(sequence));
    });
    sessionStateMailboxes.set(sessionId, mailbox);
    return mailbox;
  };
  const resetTransportDeltas = (): void => {
    deltaEncoder.reset();
    compactDeltaEncoder.reset();
    stateMailbox.clear();
    for (const mailbox of sessionStateMailboxes.values()) mailbox.clear();
    sessionStateMailboxes.clear();
    for (const state of activeClients.values()) {
      state.sessionStateEncoders.clear();
      state.sessionsEncoder.reset();
      state.agentPoolEncoder.reset();
    }
    remotePaintProbes.clear();
  };
  // Rosters are pushed only when the store changes, so a lost or undecodable
  // patch would strand a phone on stale rows (status dots, unread marks) until
  // the NEXT change — a resync answered with state alone never repaired it.
  // The last roster is retained and re-sent IN FULL on join and on resync.
  let lastSessions: DesktopSessionSummary[] = [];
  let lastAgentPool: DesktopAgentPoolRow[] = [];
  const sendClientLists = (clientId: string, state: RelayClientState): void => {
    state.sessionsEncoder.reset();
    state.agentPoolEncoder.reset();
    void sendEncryptedFrame(clientId, {
      event: 'sessions',
      payload: state.listDelta ? state.sessionsEncoder.encode(lastSessions) : lastSessions,
    }, false);
    void sendEncryptedFrame(clientId, {
      event: 'agentPool',
      payload: state.listDelta ? state.agentPoolEncoder.encode(lastAgentPool) : lastAgentPool,
    }, false);
  };
  const broadcastLists = (): void => {
    for (const [clientId, state] of activeClients) {
      if (!state.channel) continue;
      sendClientLists(clientId, state);
    }
  };
  // `critical` marks a FULL snapshot (join / resync answer). The relay drops
  // ordinary pushes for a congested phone; dropping the recovery frame itself
  // would leave that phone stranded on a transcript missing the answer.
  const broadcastState = (snapshot: unknown, critical = false): void => {
    if (activeClients.size === 0) return;
    if (critical) {
      deltaEncoder.reset();
      compactDeltaEncoder.reset();
      stateMailbox.reset({ snapshot, critical: true });
      return;
    }
    stateMailbox.publish({ snapshot, critical: false });
  };
  const drainQueuedRevocations = async (): Promise<void> => {
    if (closed || drainingRevocations) return;
    drainingRevocations = true;
    try {
      const queued = await loadQueuedRevocations(options.userDataPath);
      for (const identity of queued) {
        if (closed) break;
        // A failed identity-file rotation may leave the current identity in the
        // queue. Never let cleanup revoke the live registration in that case.
        if (identity.deviceId === deviceId) continue;
        const removed = await revokeIdentity(relayUrl, identity, revocationSockets);
        if (removed) await removeQueuedRevocation(options.userDataPath, identity.deviceId);
      }
    } finally {
      drainingRevocations = false;
    }
  };

  // Media byte lane: the relay proxies a phone's HTTP request here and this
  // leg answers with a plan (status + headers) followed by raw chunks. Media
  // never becomes an RPC payload again, so a clip cannot stall the UI socket
  // and the phone keeps browser caching and Range seeking.
  const serveRelayMedia = async (media: {
    id: string;
    assetId: string;
    variant: string;
    method: string;
    range: string;
    ifNoneMatch: string;
  }): Promise<void> => {
    const { id } = media;
    const fail = (status: number): void => {
      sendEnvelope({ type: 'media-head', id, status, headers: {} });
      sendEnvelope({ type: 'media-end', id });
    };
    let target: { path: string; mime: string } | null;
    try {
      target = await resolveMediaFileTarget(options.host, media.assetId, media.variant);
    } catch {
      fail(500);
      return;
    }
    if (!target) {
      fail(404);
      return;
    }
    let size: number;
    try {
      size = statSync(target.path).size;
    } catch {
      fail(404);
      return;
    }
    const plan = buildRelayMediaResponsePlan({
      size,
      mime: target.mime,
      assetId: media.assetId,
      variant: media.variant,
      rangeHeader: media.range,
      ifNoneMatch: media.ifNoneMatch,
    });
    sendEnvelope({ type: 'media-head', id, status: plan.status, headers: plan.headers });
    if (plan.status >= 300 || media.method === 'HEAD') {
      sendEnvelope({ type: 'media-end', id });
      return;
    }
    const stream = createReadStream(target.path, {
      start: plan.start,
      end: plan.end,
      highWaterMark: MEDIA_CHUNK_BYTES,
    });
    const pump: MediaPump = { stream, relayPaused: false, socketFull: false };
    mediaStreams.set(id, pump);
    stream.on('data', (chunk) => {
      sendEnvelope({ type: 'media-chunk', id, data: (chunk as Buffer).toString('base64') });
      // Backpressure: without it a phone on a slow link buffers the whole clip
      // in this process and again in the relay.
      if ((socket?.bufferedAmount ?? 0) <= MEDIA_SOCKET_BACKLOG_BYTES) return;
      pump.socketFull = true;
      stream.pause();
      const resume = setInterval(() => {
        if (!mediaStreams.has(id)) {
          clearInterval(resume);
          return;
        }
        if ((socket?.bufferedAmount ?? 0) > MEDIA_SOCKET_BACKLOG_BYTES) return;
        clearInterval(resume);
        pump.socketFull = false;
        resumeMedia(id);
      }, 50);
      resume.unref?.();
    });
    stream.on('error', () => {
      mediaStreams.delete(id);
      sendEnvelope({ type: 'media-error', id });
    });
    stream.on('end', () => {
      mediaStreams.delete(id);
      sendEnvelope({ type: 'media-end', id });
    });
  };
  // Retained for a future encrypted byte lane. The active relay protocol
  // rejects media requests before this plaintext implementation can run.
  void serveRelayMedia;

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
    // Idle NAT paths silently kill this leg; protocol pings keep it warm and
    // detect a half-dead socket so the reconnect loop restores it long
    // before a phone RPC would hang on it.
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        try { ws.terminate(); } catch { /* close handler reconnects */ }
        return;
      }
      alive = false;
      try { ws.ping(); } catch { /* close handler reconnects */ }
    }, 25_000);
    heartbeat.unref?.();
    ws.on('open', () => {
      retryMs = 1_000;
      // Nothing the previous leg declared survives into this one.
      resetRelayConnectionCaps();
      resetTransportDeltas();
      // A fresh desktop leg supersedes the old one and the relay closed its
      // phone legs; phones re-open and re-announce themselves.
      if (activeClients.size > 0) {
        clearClients();
      }
      // Announce the lanes this build serves BEFORE the pairing token, so the
      // relay can answer a phone's media request the moment a client leg
      // binds. An older relay ignores the frame; a newer one stops proxying
      // media to desktops that would never answer.
      // HTTP media is disabled until its byte protocol is encrypted. Remote
      // galleries fall back to the encrypted RPC payload.
      // `maxPayloadBytes` is the declaration that ends the version-skew outage:
      // the relay clamps its uplink capacity for this leg to what this leg says
      // it can receive (server.mjs `uplinkCapacityFor`, learned per connection
      // and reset on attach and redial) instead of assuming a constant. Sent
      // from the open handler, so a redial re-declares it before any frame.
      // `textFrames` opts into the envelope that cannot inflate what it carries.
      sendEnvelope({
        type: 'desktop-lanes',
        media: false,
        e2ee: 1,
        maxPayloadBytes: MAX_WS_PAYLOAD_BYTES,
        textFrames: 1,
      });
      // Register the phone pairing token before any client leg can bind.
      sendEnvelope({ type: 'set-client-token', token });
      // Unpair is local-first so it also works offline. Once any new relay leg
      // opens, dispose the owner-authenticated registrations queued while down.
      void drainQueuedRevocations();
    });
    ws.on('message', (raw, isBinary) => {
      alive = true;
      void (async () => {
        let envelope: Record<string, unknown>;
        if (isBinary) {
          const frame = decodeRelayBinaryFrame(raw);
          if (!frame) return;
          envelope = {
            type: 'frame',
            clientId: frame.clientId,
            // A text-flagged frame carries UTF-8 that must be handed on as a
            // STRING, exactly like a JSON envelope's `data` — the handshake and
            // the E2EE box readers below distinguish the two by type. An old
            // frame has no flag and stays bytes.
            data: frame.text ? Buffer.from(frame.data).toString('utf8') : frame.data,
          };
        } else {
          try {
            envelope = JSON.parse(String(raw)) as Record<string, unknown>;
          } catch {
            return;
          }
        }
        if (envelope.type === 'relay-capabilities') {
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
          // The relay republishes on change; a phone already attached is held
          // to whatever it was told in its handshake until this reaches it.
          republishRoutingCaps();
          return;
        }
        if (envelope.type === 'clients-list' || envelope.type === 'client-revoked') {
          const requestId = String(envelope.requestId || '');
          const pending = controlRequests.get(requestId);
          if (!pending) return;
          controlRequests.delete(requestId);
          clearTimeout(pending.timer);
          if (envelope.ok === false) {
            pending.reject(new Error(String(envelope.error || 'Relay device request failed.')));
          } else {
            pending.resolve(envelope.type === 'clients-list' ? envelope.clients : envelope.ok);
          }
          return;
        }
        // Approval handoff. An installed web app starts with an empty storage
        // container, so it cannot present a pairing — it asks instead, and the
        // user answers HERE. The pairing material is sealed to that
        // container's throwaway public key, so the relay forwards a box it
        // has no key for.
        if (envelope.type === 'client-claim') {
          const claimId = String(envelope.claimId || '');
          const publicKey = envelope.publicKey;
          if (!claimId || !isRelayClaimPublicKey(publicKey)) return;
          const clientId = String(envelope.clientId || claimId).slice(0, 80);
          const rawExpiresAt = Number(envelope.expiresAt);
          const expiresAt = Number.isFinite(rawExpiresAt) && rawExpiresAt > Date.now()
            ? rawExpiresAt
            : Date.now() + 300_000;
          void (async () => {
            let sealed: unknown = null;
            try {
              const approved = await options.onClientClaim?.({
                claimId,
                clientId,
                name: String(envelope.name || 'Web app').slice(0, 80),
                platform: String(envelope.platform || '').slice(0, 80),
                browser: String(envelope.browser || '').slice(0, 80),
                expiresAt,
              });
              if (approved) sealed = await sealRelayE2EEPairingMaterial(pairing, publicKey);
            } catch {
              sealed = null;
            }
            sendEnvelope(sealed
              ? { type: 'claim-approve', claimId, sealed }
              : { type: 'claim-deny', claimId });
          })();
          return;
        }
        if (envelope.type === 'client-open') {
          if (typeof envelope.clientId === 'string') {
            if (!activeClients.has(envelope.clientId)
              && activeClients.size >= MAX_ACTIVE_REMOTE_CLIENTS) {
              sendEnvelope({
                type: 'close-client',
                clientId: envelope.clientId,
                reason: 'remote client limit reached',
              });
              return;
            }
            removeClient(envelope.clientId);
            const challenge = {
              ...createRelayE2EEChallenge(),
              ...(relayBinaryFrames ? { binaryFrames: 1 as const } : {}),
              listDelta: 1 as const,
              ...(relayE2EECompressionSupported() ? { deflate: 1 as const } : {}),
              compactWire: 1 as const,
            };
            const handshakeTimer = setTimeout(() => {
              closeClient(envelope.clientId as string, 'relay encryption handshake timed out');
            }, E2EE_HANDSHAKE_TIMEOUT_MS);
            handshakeTimer.unref?.();
            activeClients.set(envelope.clientId, {
              challenge,
              channel: null,
              handshakeTimer,
              frameQueue: Promise.resolve(),
              pendingFrames: 0,
              pendingBytes: 0,
              visibleSessionIds: new Set(),
              sessionStateEncoders: new Map(),
              binaryFrames: false,
              listDelta: false,
              compactWire: false,
              lanes: null,
              sessionHandles: new Map(),
              sessionsEncoder: createKeyedListDeltaEncoder<DesktopSessionSummary>(
                (session, index) => String(session.id || `session:${index}`),
              ),
              agentPoolEncoder: createKeyedListDeltaEncoder<DesktopAgentPoolRow>(
                (agent, index) => String(agent.sessionId || agent.tag || `agent:${index}`),
              ),
              openedAt: Date.now(),
              firstTranscriptReported: false,
              sessionWindowFloors: new Map(),
            });
            notifyClientCount();
            sendEnvelope({
              type: 'frame',
              clientId: envelope.clientId,
              data: JSON.stringify(challenge),
            });
          }
          return;
        }
        if (envelope.type === 'client-close') {
          if (typeof envelope.clientId === 'string' && removeClient(envelope.clientId)) {
            notifyClientCount();
          }
          return;
        }
        // Relay flow control for the phone leg: its HTTP response filled up,
        // so stop reading until it drains. An older relay never sends these.
        if (typeof envelope.type === 'string' && envelope.type.startsWith('media-')) {
          const id = String((envelope as Record<string, unknown>).id ?? '');
          if (id) sendEnvelope({ type: 'media-error', id });
          return;
        }
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
              '[mixdog-remote] relay refused an oversize frame'
              + ` bytes=${rejection.bytes ?? 'unknown'} limit=${rejection.limit ?? 'unknown'}`
              + ' (no client attributed)',
            );
            options.onRelayPayloadRefused?.({
              bytes: rejection.bytes,
              limit: rejection.limit,
            });
            return;
          }
          // Named: only that leg hears about it, and never as a victim.
          void sendEncryptedFrame(
            clientId,
            relayPayloadRejectedFrame({ ...rejection, callId: null, scope: 'unknown' }),
          );
          return;
        }
        if (envelope.type !== 'frame' || typeof envelope.clientId !== 'string') return;
        const client = activeClients.get(envelope.clientId);
        if (!client) return;
        const frame = envelope.data;
        if (typeof frame !== 'string' && !ArrayBuffer.isView(frame)) return;
        const frameBytes = typeof frame === 'string' ? Buffer.byteLength(frame) : frame.byteLength;
        if (!remoteFrameBudgetAvailable(
          client.pendingFrames,
          client.pendingBytes,
          frameBytes,
          totalPendingFrames,
          totalPendingBytes,
        )) {
          closeClient(envelope.clientId, 'remote client backlog exceeded');
          return;
        }
        client.pendingFrames += 1;
        client.pendingBytes += frameBytes;
        totalPendingFrames += 1;
        totalPendingBytes += frameBytes;
        const processFrame = async (): Promise<void> => {
          if (activeClients.get(envelope.clientId as string) !== client) return;
          if (!client.channel) {
            if (typeof frame !== 'string') {
              closeClient(envelope.clientId as string, 'relay encryption handshake required');
              return;
            }
            let hello: unknown;
            try { hello = JSON.parse(frame); } catch {
              closeClient(envelope.clientId as string, 'relay encryption handshake required');
              return;
            }
            if (!isRelayE2EEHello(hello)) {
              closeClient(envelope.clientId as string, 'relay encryption handshake required');
              return;
            }
            try {
              client.channel = await acceptRelayE2EEClientHello(
                e2eeIdentity,
                client.challenge,
                hello,
              );
              client.binaryFrames = hello.binaryFrames === 1;
              client.listDelta = hello.listDelta === 1;
              client.compactWire = hello.compactWire === 1;
              clearTimeout(client.handshakeTimer);
              const uplink = relayUplinkLimits();
              await sendEncryptedFrame(
                envelope.clientId as string,
                // The browser cannot see `relay-capabilities` (that frame is on
                // the desktop leg), so it is handed the very numbers the relay
                // published for this connection:
                //   maxFrameBytes — the relay's policy ceiling, applied to the
                //                   phone's OWN frame exactly as it is sent;
                //   uplink*       — this connection's effective capacity and
                //                   the largest frame each wire form may carry
                //                   once the relay has wrapped it for this leg.
                // Forwarded, not recomputed: the relay's admission decision IS
                // the browser's, so an oversize frame fails in the browser at
                // the same byte the relay would have refused it at.
                {
                  type: 'e2ee-ready',
                  version: 1,
                  ...relayRoutingCapsPayload(uplink),
                },
              );
              resetTransportDeltas();
              broadcastState(options.host.getSnapshot(), true);
              sendClientLists(envelope.clientId as string, client);
            } catch {
              closeClient(envelope.clientId as string, 'relay encryption authentication failed');
            }
            return;
          }
          let clearPayload: unknown;
          try {
            clearPayload = await client.channel.decryptJson(frame);
          } catch {
            closeClient(envelope.clientId as string, 'invalid encrypted relay frame');
            return;
          }
          const paint = remotePaintProbes.acknowledgeFrame(clearPayload);
          if (paint) {
            console.error(
              `[mixdog-remote-perf] session=${paint.sessionId}`
              + ` publish-to-paint-rtt=${paint.roundTripMs.toFixed(0)}ms`
              + ` receive-to-paint=${paint.receiveToPaintMs.toFixed(1)}ms`,
            );
            return;
          }
          const call = clearPayload as { id?: unknown; method?: unknown; params?: unknown } | null;
          // Transport-scoped, like setVisibleSessions: it registers what THIS
          // browser reads rather than asking the host for anything.
          if (call?.method === 'setRemoteLanes' && Array.isArray(call.params)) {
            const requested = Array.isArray(call.params[0]) ? call.params[0] : [];
            client.lanes = new Set(
              requested
                .map((value: unknown) => String(value || ''))
                .filter((value: string) => /^[a-z]{1,16}$/u.test(value)),
            );
            if (typeof call.id === 'number') {
              await sendEncryptedFrame(envelope.clientId as string, {
                id: call.id,
                ok: true,
                value: true,
              });
            }
            return;
          }
          if (call?.method === 'setVisibleSessions' && Array.isArray(call.params)) {
            const requested = Array.isArray(call.params[0])
              ? [...new Set(call.params[0]
                .map((value) => String(value || ''))
                .filter((value) => /^[A-Za-z0-9_-]+$/u.test(value)))]
              : [];
            const nextVisible = new Set(requested);
            for (const sessionId of client.sessionStateEncoders.keys()) {
              if (!nextVisible.has(sessionId)) client.sessionStateEncoders.delete(sessionId);
            }
            client.visibleSessionIds = nextVisible;
            const scopedHost = options.host as typeof options.host & {
              setVisibleSessionsForSource?(sourceId: string, ids: string[]): Promise<boolean>;
            };
            const value = await scopedHost.setVisibleSessionsForSource?.(
              `remote:${envelope.clientId}`,
              requested,
            ) ?? await options.host.setVisibleSessions?.(requested) ?? false;
            if (typeof call.id === 'number') {
              await sendEncryptedFrame(envelope.clientId as string, {
                id: call.id,
                ok: true,
                value,
              });
            }
            return;
          }
          const clearFrame = JSON.stringify(clearPayload);
          if (isStateResyncFrame(clearFrame)) {
            resetTransportDeltas();
            broadcastState(options.host.getSnapshot(), true);
            broadcastLists();
            return;
          }
          // This phone's frames run STRICTLY in order on client.frameQueue, so
          // one slow call holds up every frame behind it and the deadline fires
          // on a request the desktop never reached. Byte and frame counters
          // cannot show that; service time names the call that did it.
          const callStartedAt = Date.now();
          const response = await executeRemoteFrame(methods, clearFrame);
          const callMs = Date.now() - callStartedAt;
          noteRemoteCall(String(call?.method ?? 'unknown'), callMs);
          if (callMs >= SLOW_REMOTE_CALL_MS) {
            console.error(`[mixdog-remote-slow-call] method=${String(call?.method ?? 'unknown')}`
              + ` ms=${callMs} queuedBehind=${client.pendingFrames}`);
          }
          if (response !== undefined) {
            await sendEncryptedFrame(envelope.clientId as string, response);
          }
        };
        client.frameQueue = client.frameQueue
          .then(processFrame, processFrame)
          .catch(() => closeClient(envelope.clientId as string, 'remote frame processing failed'))
          .finally(() => {
            client.pendingFrames = Math.max(0, client.pendingFrames - 1);
            client.pendingBytes = Math.max(0, client.pendingBytes - frameBytes);
            totalPendingFrames = Math.max(0, totalPendingFrames - 1);
            totalPendingBytes = Math.max(0, totalPendingBytes - frameBytes);
          });
      })();
    });
    ws.on('error', () => { /* connection errors surface as close */ });
    ws.on('close', () => {
      clearInterval(heartbeat);
      if (activeClients.size > 0) {
        clearClients();
      }
      // The relay dropped every waiting response with this leg; stop pumping.
      for (const pump of mediaStreams.values()) {
        try { pump.stream.destroy(); } catch { /* already gone */ }
      }
      mediaStreams.clear();
      if (socket === ws) socket = null;
      if (closed) return;
      for (const [requestId, pending] of controlRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Relay disconnected.'));
        controlRequests.delete(requestId);
      }
      reconnectTimer = setTimeout(connect, retryMs);
      reconnectTimer.unref?.();
      retryMs = Math.min(30_000, retryMs * 2);
    });
  };
  connect();

  // Engine pushes stay droppable: the subscriber must not forward its own
  // extra arguments as the `critical` flag.
  const unsubscribeState = options.host.subscribe((snapshot) => broadcastState(snapshot));
  const unsubscribeSessions = options.host.subscribeSessions((sessions) => {
    lastSessions = sessions;
    if (activeClients.size === 0) return;
    for (const [clientId, state] of activeClients) {
      if (!state.channel) continue;
      const payload = state.listDelta ? state.sessionsEncoder.encode(sessions) : sessions;
      // Roster frames carry delta patches: dropping one under congestion
      // breaks the chain for every later push, so they are never droppable.
      void sendEncryptedFrame(clientId, { event: 'sessions', payload }, false);
    }
  });
  const unsubscribeAgentPool = options.host.subscribeAgentPool((agents) => {
    lastAgentPool = agents;
    if (activeClients.size === 0) return;
    for (const [clientId, state] of activeClients) {
      if (!state.channel) continue;
      const payload = state.listDelta ? state.agentPoolEncoder.encode(agents) : agents;
      void sendEncryptedFrame(clientId, { event: 'agentPool', payload }, false);
    }
  });
  const unsubscribeSessionStates = options.host.subscribeSessionStates((update) => {
    if (activeClients.size === 0) return;
    sessionStateMailbox(update.sessionId).publish(update);
  });
  let terminalBuffer!: TerminalDataBufferer;
  terminalBuffer = new TerminalDataBufferer((event) => {
    if (activeClients.size > 0) {
      broadcastEncrypted({ event: 'termData', payload: event }, true, readsLane('terminal'));
    }
    terminalBuffer.acknowledge(event.id, event.data.length);
  }, 16);
  const terminalReaderAttached = (): boolean => {
    for (const state of activeClients.values()) {
      if (state.channel && readsLane('terminal')(state)) return true;
    }
    return false;
  };
  const unsubscribeTerminals = options.subscribeTerminalData?.((event) => {
    // A build running on the desktop must not even enter the buffer when no
    // phone is showing a terminal.
    if (terminalReaderAttached()) terminalBuffer.push(event);
  }) ?? (() => {});
  const unsubscribeDesktopEvents = options.host.subscribeDesktopEvents?.(({ name, value }) => {
    if (activeClients.size === 0) return;
    // Explorer live refresh and language-server pushes are the same lanes the
    // Electron window receives; a paired browser stays as fresh as the desktop.
    // None of them is droppable: a dropped frame leaves a stale listing or a
    // stale squiggle behind with no later push to correct it.
    if (name === 'folder-changed') {
      broadcastEncrypted({ event: 'folderChanged', payload: value }, false, readsLane('files'));
    } else if (name === 'lsp-diagnostics') {
      broadcastEncrypted({ event: 'lspDiagnostics', payload: value }, false, readsLane('editor'));
    } else if (name === 'lsp-status') {
      broadcastEncrypted({ event: 'lspStatus', payload: value }, false, readsLane('editor'));
    }
  }) ?? (() => {});

  return {
    get clientUrl() { return clientUrl; },
    get token() { return token; },
    pairing,
    get clientCount() { return activeClients.size; },
    listClients: () => controlRequest<DesktopRemoteClientInfo[]>('list-clients')
      .then((clients) => Array.isArray(clients) ? clients : []),
    revokeClient: async (clientId: string): Promise<void> => {
      if (!/^[0-9a-f-]{8,64}$/u.test(clientId)) throw new TypeError('Invalid remote client id.');
      // Per-browser credentials are isolated: revoking one deletes only that
      // browser's token on the relay. The QR bootstrap token never rotates
      // here, so every other paired browser keeps working untouched.
      await controlRequest<boolean>('revoke-client', { clientId });
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
        try { socket.terminate(); } catch { /* already gone */ }
        return;
      }
      connect();
    },
    revoke: (): Promise<void> => new Promise((resolve, reject) => {
      let retryTimer: NodeJS.Timeout | null = null;
      let target: WebSocket | null = null;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        if (retryTimer) clearTimeout(retryTimer);
        target?.off('message', onMessage);
        target?.off('close', onClose);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onMessage = (raw: WebSocket.RawData) => {
        let message: { type?: unknown; ok?: unknown };
        try {
          message = JSON.parse(String(raw)) as { type?: unknown; ok?: unknown };
        } catch {
          return;
        }
        if (message.type !== 'device-revoked') return;
        if (message.ok === false) {
          fail(new Error('Relay registration was not found.'));
          return;
        }
        succeed();
      };
      const onClose = () => fail(new Error('Relay disconnected before confirming revocation.'));
      const send = () => {
        if (closed) {
          fail(new Error('Relay client is closed.'));
          return;
        }
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          retryTimer = setTimeout(send, 50);
          retryTimer.unref?.();
          return;
        }
        target = socket;
        target.on('message', onMessage);
        target.once('close', onClose);
        target.send(JSON.stringify({ type: 'revoke-device' }), (error) => {
          if (error) fail(error);
        });
      };
      const timeout = setTimeout(() => {
        fail(new Error('Timed out waiting for relay revocation.'));
      }, REVOKE_TIMEOUT_MS);
      timeout.unref?.();
      send();
    }),
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      unsubscribeState();
      unsubscribeSessions();
      unsubscribeAgentPool();
      unsubscribeSessionStates();
      unsubscribeTerminals();
      terminalBuffer.dispose();
      unsubscribeDesktopEvents();
      for (const pending of revocationSockets) {
        try { pending.terminate(); } catch { /* already gone */ }
      }
      revocationSockets.clear();
      if (socket) {
        try { socket.terminate(); } catch { /* already gone */ }
        socket = null;
      }
      if (activeClients.size > 0) {
        clearClients();
      }
      for (const [requestId, pending] of controlRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Relay client is closed.'));
        controlRequests.delete(requestId);
      }
    },
  };
}
