/**
 * The direct-transport peer host: a hidden, trusted window of this app (its
 * own page and narrow preload, no remote content) that owns every transport
 * RTCPeerConnection of this PC (docs/remote-transport.md §3, §5, §9 1B). It is
 * created on first use and recreated on the next `create` after a crash. Main
 * stays the authority: it validates every signal and every event the page
 * reports, checks the DTLS certificate against the signaled fingerprints, and
 * keeps the backpressure accounting; the page only runs the peer connections.
 *
 * ## Bridge API (`RemoteTransportPeerBridge`, for the coordinator)
 *
 * One bridge per window process; connections are keyed by the `connectionId`
 * the desktop minted (`RemoteTransportSignalRef.connectionId`). The PC always
 * offers: there is no `answer` from this side, ever.
 *
 *   create({ connectionId, session, iceServers }) → boolean
 *       A new peer connection with both channels, `mixdog-transport`
 *       (reliable, ordered: kinds 1 and 2) and `mixdog-transport-control`
 *       (reliable, ordered, own SCTP stream: kind 3), created before any
 *       offer. Control messages arrive as `message` events one by one in
 *       arrival order, for the `direct:<connectionId>` control lane. `iceServers`
 *       come from the caller: `await resolveRemoteIceServers()`
 *       (main/remote-ice-servers.ts), whose cache hands every session the same
 *       credential set until it nears expiry; the same list goes into the
 *       offer signal. `session` is a diagnostics label only (TURN allocations
 *       are logged per session). Starts the negotiation timeout
 *       (REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS, create → `open`). False when
 *       disposed, the id is in use or malformed, or the servers are invalid.
 *   offer(connectionId, { iceRestart }) → boolean
 *       Asks for the offer (the first, or an ICE restart on the same
 *       connection). Answered by an `offer` event.
 *   answer(connectionId, { sdp, fingerprints }) → boolean
 *       Applies the phone's answer to the outstanding offer. The SDP is held
 *       to the control plaintext budget, then `parseRemoteWebrtcSdp`, and must
 *       name exactly `fingerprints` (`assertRemoteWebrtcSdpFingerprints`);
 *       anything else fails the connection (`protocol-error` /
 *       `fingerprint-mismatch`) and returns false.
 *   candidate(connectionId, candidate) → boolean
 *       A phone candidate (`parseRemoteWebrtcCandidate`; null = end of
 *       candidates). Refused (false) before the first answer, or when invalid.
 *   send(connectionId, channel, data) → boolean
 *       One carrier message (1 … REMOTE_TRANSPORT_MAX_MESSAGE_BYTES bytes) on
 *       `app` or `control`, only after `open`. Both channels share ONE bound
 *       (docs/remote-transport.md §3 Backpressure), as the phone does: the
 *       connection's load `queued(connectionId)` (both channels' IPC-hop bytes
 *       and `bufferedAmount`) may never exceed REMOTE_TRANSPORT_BUFFER_HIGH_BYTES.
 *       App records stop REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES short of it
 *       (refused when `load + size > HIGH − reserve`), so a control box (ack,
 *       ping, pong) still goes out while bulk holds the rest; a control box
 *       is counted (reserved) at its full size when admitted and refused only
 *       when `load + size > HIGH`. A refusal queues nothing; resume on
 *       `drain`. The bytes are copied into the IPC hop as binary (structured
 *       clone, no base64), batched per microtask.
 *   queued(connectionId, channel?) → number
 *       The backpressure figure: bytes on the main → page IPC hop not yet
 *       handed to the channel, plus its last reported `bufferedAmount`. With
 *       `channel`, that channel's share; without, the connection's load over
 *       both channels, the figure `send` admits against. It errs high (the
 *       amount only drains between reports), never low. 0 for an unknown
 *       connection. Feed the load to `canAdmit({ bufferedAmount })`,
 *       `probeThrough`, and `RemoteTransportPathMonitor.buffered`.
 *   sample(connectionId) → void
 *       Asks the page for both channels' `bufferedAmount` now (answered by
 *       `drain` when it went down), e.g. once per ping tick, so a draining
 *       queue shows as progress between drain-to-low signals.
 *   close(connectionId) → void
 *       Closes the peer connection. No event follows.
 *   onEvent(listener) → void
 *       The single listener (a later call replaces it), with the events below.
 *   dispose() → void
 *       Destroys the window; live connections fail `peer-host-unavailable`.
 *
 * Events (`RemoteTransportPeerBridgeEvent`), in order per connection:
 *   offer      { sdp, fingerprints } — the local description and its
 *              `a=fingerprint` set, already within the control budget; the
 *              caller builds the signal (ref, `iceServers`) and checks it with
 *              `assertRemoteTransportControlFits` before sealing.
 *   candidate  { candidate } — a local candidate, validated.
 *   open       { maxMessageSize, fits, path } — the certificate matched the
 *              answer's fingerprints AND both channels are open.
 *              `maxMessageSize` is `pc.sctp.maxMessageSize` (+∞ when
 *              unlimited), `fits` is `remoteTransportCarrierFits` of it (a
 *              carrier that does not fit must not be promoted), `path` the
 *              selected pair's (`direct` | `turn`). Promotion (§5) also needs
 *              a ping/pong on this carrier; that is the coordinator's.
 *   message    { channel, data } — one carrier message (binary), only after
 *              `open`. The coordinator decodes it (`decodeRemoteTransportMessage`).
 *   drain      { channel, queued } — the connection's load went down, `queued`
 *              being the new load (`queued(connectionId)`), `channel` the one
 *              that drained; notably when it drained to
 *              REMOTE_TRANSPORT_BUFFER_LOW_BYTES (`bufferedamountlow`). Resume
 *              writing on either channel.
 *   failed     { reason, detail? } — the connection is gone (already closed):
 *              `ice-failed`, `dtls-failed`, `channel-failed`,
 *              `fingerprint-mismatch`, `negotiation-timeout`, `protocol-error`,
 *              or `peer-host-unavailable` (the page crashed, reloaded or
 *              navigated, failed to load, or was disposed). A `close` signal to
 *              the phone is the caller's.
 *
 * Host lifecycle: a page that is lost takes every connection with it. A crash
 * (`render-process-gone`), a main-frame navigation after the page reported
 * ready (`did-start-navigation`: a reload), or a second `ready` from the same
 * page (a reload that slipped past) all fail every live connection
 * `peer-host-unavailable`, free their ids, drop the waiting commands, the
 * unsent batch and all IPC-hop accounting, and destroy the window; its late
 * events are ignored. The next `create` opens a fresh page.
 */
import { BrowserWindow, type IpcMainEvent, type WebContents } from 'electron';

import type {
  RemoteTransportPeerChannel,
  RemoteTransportPeerCommand,
  RemoteTransportPeerEvent,
  RemoteTransportPeerFailure,
  RemoteTransportPeerSendItem,
} from '../../renderer/remote-transport-peer-host/main';
import {
  REMOTE_TRANSPORT_BUFFER_HIGH_BYTES,
  REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES,
  REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES,
  REMOTE_TRANSPORT_MAX_MESSAGE_BYTES,
  REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS,
  remoteTransportCarrierFits,
} from '../../shared/remote-transport';
import {
  assertRemoteWebrtcSdpFingerprints,
  parseRemoteWebrtcCandidate,
  parseRemoteWebrtcIceServers,
  parseRemoteWebrtcSdp,
  remoteWebrtcCertificateMatches,
  remoteWebrtcSdpFingerprints,
  type RemoteWebrtcCandidate,
  type RemoteWebrtcFingerprint,
  type RemoteWebrtcIceServer,
} from '../../shared/remote-webrtc';
import { builtPreloadPath } from '../browser/preload-path';

export type { RemoteTransportPeerChannel };

/** Main ↔ peer host IPC (the preload names the same two channels). */
export const REMOTE_TRANSPORT_PEER_IPC = {
  /** main → page: RemoteTransportPeerCommand. */
  command: 'remote-transport-peer:command',
  /** page → main: RemoteTransportPeerEvent. */
  event: 'remote-transport-peer:event',
} as const;

export type RemoteTransportPeerBridgeFailure =
  | RemoteTransportPeerFailure
  | 'fingerprint-mismatch'
  | 'negotiation-timeout';

export type RemoteTransportPeerBridgeEvent =
  | { type: 'offer'; connectionId: string; sdp: string; fingerprints: RemoteWebrtcFingerprint[] }
  | { type: 'candidate'; connectionId: string; candidate: RemoteWebrtcCandidate | null }
  | {
      type: 'open';
      connectionId: string;
      maxMessageSize: number | null;
      fits: boolean;
      path: 'direct' | 'turn' | null;
    }
  | { type: 'message'; connectionId: string; channel: RemoteTransportPeerChannel; data: Uint8Array }
  | { type: 'drain'; connectionId: string; channel: RemoteTransportPeerChannel; queued: number }
  | { type: 'failed'; connectionId: string; reason: RemoteTransportPeerBridgeFailure; detail?: string };

export interface RemoteTransportPeerBridge {
  create(request: { connectionId: string; session: string; iceServers: readonly unknown[] }): boolean;
  offer(connectionId: string, options?: { iceRestart?: boolean }): boolean;
  answer(connectionId: string, answer: { sdp: string; fingerprints: readonly RemoteWebrtcFingerprint[] }): boolean;
  candidate(connectionId: string, candidate: unknown): boolean;
  send(connectionId: string, channel: RemoteTransportPeerChannel, data: Uint8Array): boolean;
  queued(connectionId: string, channel?: RemoteTransportPeerChannel): number;
  sample(connectionId: string): void;
  close(connectionId: string): void;
  onEvent(listener: (event: RemoteTransportPeerBridgeEvent) => void): void;
  dispose(): void;
}

/** Load target of the peer host page: the dev server's, or the built file. */
export interface RemoteTransportPeerPage {
  developmentUrl?: string;
  /** Absolute path of the built remote-transport-peer.html. */
  file: string;
}

export interface RemoteTransportPeerWindowOptions {
  page: RemoteTransportPeerPage;
  /** Diagnostics, never content (§7): failures, TURN allocations per session. */
  report?(event: string, data: Record<string, unknown>): void;
}

interface ChannelQueue {
  /** Bytes handed to the IPC hop and not yet reported `sent` by the page. */
  ipc: number;
  /** The channel's last reported `bufferedAmount`. */
  buffered: number;
}

interface PeerConnection {
  id: string;
  session: string;
  /** An `offer` command is outstanding. */
  offering: boolean;
  /** An offer was emitted and its answer not applied yet. */
  awaitingAnswer: boolean;
  /** The applied answer's fingerprints (null before the first answer). */
  fingerprints: RemoteWebrtcFingerprint[] | null;
  /** The remote certificate, once it matched. */
  certificate: unknown;
  open: boolean;
  queues: Record<RemoteTransportPeerChannel, ChannelQueue>;
  timer: ReturnType<typeof setTimeout> | null;
}

const CONNECTION_ID = /^[A-Za-z0-9_-]{8,64}$/u;
const CHANNELS: ReadonlySet<string> = new Set<RemoteTransportPeerChannel>(['app', 'control']);
const PAGE_FAILURES: ReadonlySet<string> = new Set<RemoteTransportPeerFailure>([
  'ice-failed',
  'dtls-failed',
  'channel-failed',
  'protocol-error',
  'peer-host-unavailable',
]);
const DETAIL_CHARS = 200;
const LIMITS: Record<RemoteTransportPeerChannel, number> = {
  app: REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES,
  control: REMOTE_TRANSPORT_BUFFER_HIGH_BYTES,
};

type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields => !!value && typeof value === 'object' && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.slice(0, DETAIL_CHARS) : undefined;

/** The SDP as the transport signals it: within one control box, then the live
 *  view's strict check (docs/remote-transport.md §3 Signaling). Throws. */
function transportSdp(value: unknown): string {
  if (typeof value === 'string' && value.length > REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES) {
    throw new TypeError('remote transport: invalid sdp size.');
  }
  return parseRemoteWebrtcSdp(value);
}

/** An event from the page, shape-checked; null when malformed. */
function readEvent(value: unknown): RemoteTransportPeerEvent | null {
  if (!isRecord(value)) return null;
  if (value.type === 'ready') return { type: 'ready' };
  const connectionId = value.connectionId;
  if (typeof connectionId !== 'string' || !CONNECTION_ID.test(connectionId)) return null;
  const channel = value.channel as RemoteTransportPeerChannel;
  switch (value.type) {
    case 'offer':
      return typeof value.sdp === 'string' ? { type: 'offer', connectionId, sdp: value.sdp } : null;
    case 'candidate':
      return {
        type: 'candidate',
        connectionId,
        candidate: value.candidate as RemoteWebrtcCandidate | null,
        ...(typeof value.relayProtocol === 'string' ? { relayProtocol: optionalText(value.relayProtocol) } : {}),
        ...(typeof value.url === 'string' ? { url: optionalText(value.url) } : {}),
      };
    case 'connected':
      return {
        type: 'connected',
        connectionId,
        remoteCertificate: isRecord(value.remoteCertificate)
          ? (value.remoteCertificate as { fingerprint?: string; fingerprintAlgorithm?: string })
          : null,
      };
    case 'open': {
      const size = value.maxMessageSize;
      const path = value.path;
      if (size !== null && (typeof size !== 'number' || Number.isNaN(size))) return null;
      if (path !== null && path !== 'direct' && path !== 'turn') return null;
      return { type: 'open', connectionId, maxMessageSize: size, path };
    }
    case 'message':
      return CHANNELS.has(channel) && value.data instanceof Uint8Array
        ? { type: 'message', connectionId, channel, data: value.data }
        : null;
    case 'sent':
      return CHANNELS.has(channel) && isCount(value.bytes) && isCount(value.bufferedAmount)
        ? { type: 'sent', connectionId, channel, bytes: value.bytes, bufferedAmount: value.bufferedAmount }
        : null;
    case 'buffered':
      return CHANNELS.has(channel) && isCount(value.bufferedAmount)
        ? { type: 'buffered', connectionId, channel, bufferedAmount: value.bufferedAmount }
        : null;
    case 'failed':
      return typeof value.reason === 'string' && PAGE_FAILURES.has(value.reason)
        ? {
            type: 'failed',
            connectionId,
            reason: value.reason as RemoteTransportPeerFailure,
            ...(optionalText(value.detail) ? { detail: optionalText(value.detail) } : {}),
          }
        : null;
    default:
      return null;
  }
}

export function createRemoteTransportPeerWindow(options: RemoteTransportPeerWindowOptions): RemoteTransportPeerBridge {
  const report = options.report ?? (() => undefined);
  let window: BrowserWindow | null = null;
  let ready = false;
  let disposed = false;
  /** Commands issued before the page is ready, in order. */
  let waiting: RemoteTransportPeerCommand[] = [];
  /** Carrier messages of this microtask, sent as one `send` command. */
  let batch: RemoteTransportPeerSendItem[] = [];
  let listener: (event: RemoteTransportPeerBridgeEvent) => void = () => undefined;
  const connections = new Map<string, PeerConnection>();
  /** TURN allocations (local relay candidates) per session label. */
  const turnAllocations = new Map<string, number>();

  const emit = (event: RemoteTransportPeerBridgeEvent): void => listener(event);

  function command(next: RemoteTransportPeerCommand): void {
    if (!window || window.isDestroyed()) return;
    if (ready) window.webContents.send(REMOTE_TRANSPORT_PEER_IPC.command, next);
    else waiting.push(next);
  }

  function flush(): void {
    const items = batch;
    batch = [];
    if (items.length && window && ready && !window.isDestroyed()) {
      window.webContents.send(REMOTE_TRANSPORT_PEER_IPC.command, { type: 'send', items });
    }
  }

  function forget(connection: PeerConnection): void {
    connections.delete(connection.id);
    if (connection.timer) clearTimeout(connection.timer);
    connection.timer = null;
    if (![...connections.values()].some((other) => other.session === connection.session)) {
      turnAllocations.delete(connection.session);
    }
  }

  function fail(connection: PeerConnection, reason: RemoteTransportPeerBridgeFailure, detail?: string): void {
    if (connections.get(connection.id) !== connection) return;
    forget(connection);
    command({ type: 'close', connectionId: connection.id });
    report('failed', { session: connection.session, connectionId: connection.id, reason });
    emit({ type: 'failed', connectionId: connection.id, reason, ...(detail ? { detail } : {}) });
  }

  /** The page is gone (crash, load failure, closed, disposed): every live
   *  connection with it. The next `create` opens a new page. */
  function gone(): void {
    window = null;
    ready = false;
    waiting = [];
    batch = [];
    const lost = [...connections.values()];
    for (const connection of lost) forget(connection);
    for (const connection of lost) {
      report('failed', { session: connection.session, connectionId: connection.id, reason: 'peer-host-unavailable' });
      emit({ type: 'failed', connectionId: connection.id, reason: 'peer-host-unavailable' });
    }
  }

  /** The page is lost under live connections (crash, reload, navigation):
   *  fail them all and destroy it; the next `create` opens a fresh page. */
  function lost(created: BrowserWindow, cause: string): void {
    if (window !== created) return;
    report('host-lost', { cause, connections: connections.size });
    gone();
    if (!created.isDestroyed()) created.destroy();
  }

  const total = (queue: ChannelQueue): number => queue.ipc + queue.buffered;
  /** Both channels against the one bound. */
  const load = (connection: PeerConnection): number => total(connection.queues.app) + total(connection.queues.control);

  function settle(connection: PeerConnection, channel: RemoteTransportPeerChannel, update: (queue: ChannelQueue) => void): void {
    const before = load(connection);
    update(connection.queues[channel]);
    const after = load(connection);
    if (after < before) emit({ type: 'drain', connectionId: connection.id, channel, queued: after });
  }

  function onPageEvent(contents: WebContents, event: RemoteTransportPeerEvent): void {
    if (event.type === 'ready') {
      ready = true;
      const queued = waiting;
      waiting = [];
      for (const next of queued) contents.send(REMOTE_TRANSPORT_PEER_IPC.command, next);
      return;
    }
    const connection = connections.get(event.connectionId);
    if (!connection) return;
    switch (event.type) {
      case 'offer': {
        if (!connection.offering) return;
        connection.offering = false;
        let fingerprints: RemoteWebrtcFingerprint[];
        try {
          fingerprints = remoteWebrtcSdpFingerprints(transportSdp(event.sdp));
        } catch (error) {
          fail(connection, 'protocol-error', error instanceof Error ? error.message : 'offer');
          return;
        }
        if (!fingerprints.length) {
          fail(connection, 'protocol-error', 'offer without fingerprints');
          return;
        }
        connection.awaitingAnswer = true;
        emit({ type: 'offer', connectionId: connection.id, sdp: event.sdp, fingerprints });
        return;
      }
      case 'candidate': {
        let candidate: RemoteWebrtcCandidate | null;
        try {
          candidate = parseRemoteWebrtcCandidate(event.candidate);
        } catch {
          report('candidate-dropped', { session: connection.session, connectionId: connection.id, side: 'local' });
          return;
        }
        if (candidate && / typ relay(?: |$)/u.test(candidate.candidate)) {
          const allocations = (turnAllocations.get(connection.session) ?? 0) + 1;
          turnAllocations.set(connection.session, allocations);
          report('turn-allocation', {
            session: connection.session,
            connectionId: connection.id,
            allocations,
            ...(event.relayProtocol ? { relayProtocol: event.relayProtocol } : {}),
            ...(event.url ? { url: event.url } : {}),
          });
        }
        emit({ type: 'candidate', connectionId: connection.id, candidate });
        return;
      }
      case 'connected':
        // DTLS is up: the certificate must be one the E2EE answer named.
        if (!connection.fingerprints || !remoteWebrtcCertificateMatches(connection.fingerprints, event.remoteCertificate)) {
          fail(connection, 'fingerprint-mismatch');
          return;
        }
        connection.certificate = event.remoteCertificate;
        return;
      case 'open': {
        if (connection.open) return;
        if (!connection.certificate) {
          fail(connection, 'protocol-error', 'open before the certificate check');
          return;
        }
        connection.open = true;
        if (connection.timer) clearTimeout(connection.timer);
        connection.timer = null;
        const fits = remoteTransportCarrierFits(event.maxMessageSize);
        report('open', {
          session: connection.session,
          connectionId: connection.id,
          maxMessageSize: event.maxMessageSize,
          fits,
          path: event.path,
        });
        emit({ type: 'open', connectionId: connection.id, maxMessageSize: event.maxMessageSize, fits, path: event.path });
        return;
      }
      case 'message': {
        const size = event.data.byteLength;
        if (!connection.open || size < 1 || size > REMOTE_TRANSPORT_MAX_MESSAGE_BYTES) return;
        emit({ type: 'message', connectionId: connection.id, channel: event.channel, data: event.data });
        return;
      }
      case 'sent':
        settle(connection, event.channel, (queue) => {
          queue.ipc = Math.max(0, queue.ipc - event.bytes);
          queue.buffered = event.bufferedAmount;
        });
        return;
      case 'buffered':
        settle(connection, event.channel, (queue) => {
          queue.buffered = event.bufferedAmount;
        });
        return;
      case 'failed':
        fail(connection, event.reason, event.detail);
        return;
    }
  }

  function open(): BrowserWindow {
    const created = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 64,
      height: 64,
      title: 'Mixdog direct transport',
      webPreferences: {
        preload: builtPreloadPath('remote-transport-peer.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // ICE consent checks, SCTP and the drain signals must run while hidden.
        backgroundThrottling: false,
      },
    });
    const contents = created.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    /** This page reported ready: from now on a new document is a reload that
     *  erased its peer connections. */
    let started = false;
    contents.ipc.on(REMOTE_TRANSPORT_PEER_IPC.event, (_event: IpcMainEvent, message: unknown) => {
      if (window !== created) return;
      const event = readEvent(message);
      if (!event) return;
      if (event.type === 'ready') {
        if (started) return lost(created, 'reloaded');
        started = true;
      }
      onPageEvent(contents, event);
    });
    contents.on('did-start-navigation', (details) => {
      if (started && details.isMainFrame && !details.isSameDocument) lost(created, 'navigated');
    });
    contents.on('render-process-gone', () => lost(created, 'crashed'));
    created.on('closed', () => {
      if (window === created) gone();
    });
    const load = options.page.developmentUrl
      ? created.loadURL(new URL('remote-transport-peer.html', options.page.developmentUrl).href)
      : created.loadFile(options.page.file);
    load.catch(() => {
      if (window === created && !created.isDestroyed()) created.destroy();
    });
    return created;
  }

  const live = (connectionId: string): PeerConnection | undefined => connections.get(connectionId);

  return {
    create({ connectionId, session, iceServers }) {
      if (disposed || !CONNECTION_ID.test(connectionId) || connections.has(connectionId)) return false;
      let servers: RemoteWebrtcIceServer[];
      try {
        servers = parseRemoteWebrtcIceServers(iceServers);
      } catch {
        report('create-refused', { session, connectionId, reason: 'ice-servers' });
        return false;
      }
      window ??= open();
      const connection: PeerConnection = {
        id: connectionId,
        session,
        offering: false,
        awaitingAnswer: false,
        fingerprints: null,
        certificate: null,
        open: false,
        queues: { app: { ipc: 0, buffered: 0 }, control: { ipc: 0, buffered: 0 } },
        timer: null,
      };
      connections.set(connectionId, connection);
      connection.timer = setTimeout(() => fail(connection, 'negotiation-timeout'), REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS);
      command({ type: 'create', connectionId, iceServers: servers });
      return true;
    },
    offer(connectionId, offerOptions) {
      const connection = live(connectionId);
      if (!connection || connection.offering) return false;
      connection.offering = true;
      connection.awaitingAnswer = false;
      command({ type: 'offer', connectionId, iceRestart: offerOptions?.iceRestart === true });
      return true;
    },
    answer(connectionId, answer) {
      const connection = live(connectionId);
      if (!connection || !connection.awaitingAnswer) return false;
      let sdp: string;
      try {
        sdp = transportSdp(answer.sdp);
      } catch {
        fail(connection, 'protocol-error', 'answer sdp');
        return false;
      }
      try {
        assertRemoteWebrtcSdpFingerprints(sdp, answer.fingerprints);
      } catch {
        fail(connection, 'fingerprint-mismatch');
        return false;
      }
      const fingerprints = remoteWebrtcSdpFingerprints(sdp);
      // After an ICE restart DTLS stays: its certificate must be one this answer names too.
      if (connection.certificate && !remoteWebrtcCertificateMatches(fingerprints, connection.certificate)) {
        fail(connection, 'fingerprint-mismatch');
        return false;
      }
      connection.awaitingAnswer = false;
      connection.fingerprints = fingerprints;
      command({ type: 'answer', connectionId, sdp });
      return true;
    },
    candidate(connectionId, candidate) {
      const connection = live(connectionId);
      if (!connection || !connection.fingerprints) return false;
      let parsed: RemoteWebrtcCandidate | null;
      try {
        parsed = parseRemoteWebrtcCandidate(candidate);
      } catch {
        report('candidate-dropped', { session: connection.session, connectionId, side: 'remote' });
        return false;
      }
      command({ type: 'candidate', connectionId, candidate: parsed });
      return true;
    },
    send(connectionId, channel, data) {
      const connection = live(connectionId);
      if (!connection?.open || !CHANNELS.has(channel) || !(data instanceof Uint8Array)) return false;
      const size = data.byteLength;
      if (size < 1 || size > REMOTE_TRANSPORT_MAX_MESSAGE_BYTES) return false;
      if (load(connection) + size > LIMITS[channel]) return false;
      connection.queues[channel].ipc += size;
      if (!batch.length) queueMicrotask(flush);
      batch.push({ connectionId, channel, data });
      return true;
    },
    queued(connectionId, channel) {
      const connection = live(connectionId);
      if (!connection) return 0;
      return channel ? total(connection.queues[channel]) : load(connection);
    },
    sample(connectionId) {
      if (live(connectionId)?.open) command({ type: 'sample', connectionId });
    },
    close(connectionId) {
      const connection = live(connectionId);
      if (!connection) return;
      forget(connection);
      command({ type: 'close', connectionId });
    },
    onEvent(next) {
      listener = next;
    },
    dispose() {
      disposed = true;
      const current = window;
      gone();
      if (current && !current.isDestroyed()) current.destroy();
    },
  };
}
