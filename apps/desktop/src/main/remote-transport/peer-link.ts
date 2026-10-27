/**
 * The direct carrier across the daemon ↔ app hop (docs/remote-transport.md
 * §3 "Channels on the direct carrier", §5, §9 1A).
 *
 * The relay, and with it every coordinator, runs in the machine daemon: plain
 * Node, no Electron (daemon-bundle-electron.test.mjs). The peer connections
 * run in the desktop app's hidden peer window (peer-window.ts). Like the
 * remote-screen live view (desktop-service.ts `browserRemoteWebrtcSignal`),
 * the two meet over the existing daemon ↔ app lane:
 *
 *   daemon → app  desktop event REMOTE_TRANSPORT_PEER_COMMAND_EVENT,
 *                 `{ attachment, seq, command }`, to the window only
 *   app → daemon  desktop operations REMOTE_TRANSPORT_PEER_OPERATIONS:
 *                 `attach()` → attachment id; `report(attachment, report)`
 *                 (notify lane: acks and bridge events, in order);
 *                 `detach(attachment)`
 *
 * Daemon side: `createRemoteTransportPeerStandIn` implements
 * `RemoteTransportPeerBridge` (the coordinator wraps it with
 * `createRemoteTransportPeerHost`). App side: `createRemoteTransportPeerEndpoint`
 * drives the real bridge, created lazily on the first `create`.
 *
 * Backpressure across both hops: `queued(id)` is the bytes handed to the app
 * and not yet acknowledged by it, plus the app's last reported load of the
 * connection (`bridge.queued`). The app's load only grows by bytes this side
 * sent, which stay counted until the ack that reports the load after them;
 * so the figure never undercounts, and admitting against it holds the one
 * REMOTE_TRANSPORT_BUFFER_HIGH_BYTES bound end to end (app records stop
 * REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES short of it).
 *
 * No app: without an attachment `create` refuses (the session stays on the
 * relay and retries once per negotiation window). A detach, a newer attach
 * (the app restarted) or a command left unacknowledged for
 * REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS (the no-progress bound: the carrier
 * would be judged stalled anyway) fails every live connection
 * `peer-host-unavailable`; an app that attaches later serves the next offer.
 *
 */
import { randomUUID } from 'node:crypto';

import {
  REMOTE_TRANSPORT_BUFFER_HIGH_BYTES,
  REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES,
  REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS,
  REMOTE_TRANSPORT_MAX_MESSAGE_BYTES,
  remoteTransportCarrierFits,
} from '../../shared/remote-transport';
import {
  parseRemoteWebrtcCandidate,
  remoteWebrtcSdpFingerprints,
  type RemoteWebrtcCandidate,
  type RemoteWebrtcFingerprint,
} from '../../shared/remote-webrtc';
import { createRemoteTransportPeerHost, type RemoteTransportPeerHost } from './coordinator';
import type {
  RemoteTransportPeerBridge,
  RemoteTransportPeerBridgeEvent,
  RemoteTransportPeerBridgeFailure,
  RemoteTransportPeerChannel,
} from './peer-window';

/** daemon → app: one command envelope (to the window only, never the relay). */
export const REMOTE_TRANSPORT_PEER_COMMAND_EVENT = 'remote-transport-peer-command';
/** daemon → app: one diagnostics line of a transport session (the daemon has
 *  no diagnostics file; the app writes it to desktop-diagnostics.jsonl). */
export const REMOTE_TRANSPORT_LOG_EVENT = 'remote-transport-log';
/** app → daemon: desktop operations. */
export const REMOTE_TRANSPORT_PEER_OPERATIONS = {
  attach: 'remoteTransportPeerAttach',
  report: 'remoteTransportPeerReport',
  detach: 'remoteTransportPeerDetach',
} as const;

/** One carrier message on the JSON lane: base64 of its bytes. */
interface WireItem {
  connectionId: string;
  channel: RemoteTransportPeerChannel;
  data: string;
}

export type RemoteTransportPeerLinkCommand =
  | { type: 'create'; connectionId: string; session: string; iceServers: unknown[] }
  | { type: 'offer'; connectionId: string; iceRestart: boolean }
  | { type: 'answer'; connectionId: string; sdp: string; fingerprints: RemoteWebrtcFingerprint[] }
  | { type: 'candidate'; connectionId: string; candidate: unknown }
  | { type: 'send'; items: WireItem[] }
  | { type: 'sample'; connectionId: string }
  | { type: 'close'; connectionId: string }
  /** A daemon client went away: is this app still there? */
  | { type: 'probe' };

export interface RemoteTransportPeerLinkEnvelope {
  attachment: string;
  seq: number;
  command: RemoteTransportPeerLinkCommand;
}

/** A connection's load in the app, per channel: `[app, control]`. */
type Load = [number, number];

/** app → daemon. `n` counts reports per attachment: a load older than one
 *  already applied is never applied. */
export type RemoteTransportPeerLinkReport = { n: number } & (
  | { type: 'ack'; seq: number; loads: Record<string, Load> }
  | { type: 'offer'; connectionId: string; sdp: string }
  | { type: 'candidate'; connectionId: string; candidate: unknown }
  | { type: 'open'; connectionId: string; maxMessageSize: number | null; path: 'direct' | 'turn' | null }
  | { type: 'message'; connectionId: string; channel: RemoteTransportPeerChannel; data: string }
  | { type: 'drain'; connectionId: string; load: Load }
  | { type: 'failed'; connectionId: string; reason: RemoteTransportPeerBridgeFailure; detail?: string }
);

const CHANNELS: readonly RemoteTransportPeerChannel[] = ['app', 'control'];
/** As peer-window.ts: app records stop the control reserve short of HIGH. */
const LIMITS: Record<RemoteTransportPeerChannel, number> = {
  app: REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES,
  control: REMOTE_TRANSPORT_BUFFER_HIGH_BYTES,
};
const FAILURES: ReadonlySet<string> = new Set<RemoteTransportPeerBridgeFailure>([
  'ice-failed',
  'dtls-failed',
  'channel-failed',
  'protocol-error',
  'peer-host-unavailable',
  'fingerprint-mismatch',
  'negotiation-timeout',
]);

type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isChannel = (value: unknown): value is RemoteTransportPeerChannel => value === 'app' || value === 'control';
const isLoad = (value: unknown): value is Load =>
  Array.isArray(value) && value.length === 2 && isCount(value[0]) && isCount(value[1]);

const toBase64 = (data: Uint8Array): string =>
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
/** A carrier message from the lane, or null when it is not one. */
function carrierBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length > Math.ceil(REMOTE_TRANSPORT_MAX_MESSAGE_BYTES / 3) * 4) return null;
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  return bytes.byteLength >= 1 && bytes.byteLength <= REMOTE_TRANSPORT_MAX_MESSAGE_BYTES ? bytes : null;
}

// ---------------------------------------------------------------------------
// Daemon side
// ---------------------------------------------------------------------------

export interface RemoteTransportPeerStandIn extends RemoteTransportPeerBridge {
  /** `attach()`: a new attachment; an earlier one (a restarted app) is lost. */
  attach(): string;
  /** `detach(attachment)`: the app is going away. */
  detach(attachment: unknown): void;
  /** `report(attachment, report)`: one ack or bridge event, in order. */
  report(attachment: unknown, report: unknown): void;
  /** A daemon client went away: the attached app must answer a probe. */
  clientReleased(): void;
}

export interface RemoteTransportPeerStandInDeps {
  /** Emits REMOTE_TRANSPORT_PEER_COMMAND_EVENT to the window. */
  publish(envelope: RemoteTransportPeerLinkEnvelope): void;
  /** Test seam; setTimeout (unref) by default. */
  schedule?(run: () => void, ms: number): () => void;
}

interface Mirror {
  open: boolean;
  /** Bytes handed to the app, not yet acknowledged. */
  hop: Record<RemoteTransportPeerChannel, number>;
  /** The app's last reported load. */
  app: Load;
}

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export function createRemoteTransportPeerStandIn(deps: RemoteTransportPeerStandInDeps): RemoteTransportPeerStandIn {
  const schedule = deps.schedule ?? defaultSchedule;
  let attachment: string | null = null;
  let disposed = false;
  let seq = 0;
  /** Highest report `n` whose loads were applied. */
  let appliedReport = -1;
  let listener: (event: RemoteTransportPeerBridgeEvent) => void = () => undefined;
  const connections = new Map<string, Mirror>();
  /** Unacknowledged commands: their hop bytes and ack deadline. */
  const pending = new Map<number, { bytes: Map<string, Record<RemoteTransportPeerChannel, number>>; cancel(): void }>();
  let batch: WireItem[] = [];
  let batchBytes = new Map<string, Record<RemoteTransportPeerChannel, number>>();

  const emit = (event: RemoteTransportPeerBridgeEvent): void => listener(event);
  const total = (mirror: Mirror): number => mirror.hop.app + mirror.hop.control + mirror.app[0] + mirror.app[1];
  const share = (mirror: Mirror, channel: RemoteTransportPeerChannel): number =>
    mirror.hop[channel] + mirror.app[channel === 'app' ? 0 : 1];

  /** The app is gone: every live connection with it. */
  function lost(): void {
    attachment = null;
    batch = [];
    batchBytes = new Map();
    for (const entry of pending.values()) entry.cancel();
    pending.clear();
    const ids = [...connections.keys()];
    connections.clear();
    for (const connectionId of ids) emit({ type: 'failed', connectionId, reason: 'peer-host-unavailable' });
  }

  function send(
    command: RemoteTransportPeerLinkCommand,
    bytes = new Map<string, Record<RemoteTransportPeerChannel, number>>()
  ): void {
    if (!attachment) return;
    const id = ++seq;
    pending.set(id, { bytes, cancel: schedule(lost, REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS) });
    deps.publish({ attachment, seq: id, command });
  }

  function flush(): void {
    const items = batch;
    const bytes = batchBytes;
    batch = [];
    batchBytes = new Map();
    if (items.length) send({ type: 'send', items }, bytes);
  }

  /** Applies a load the app reported, then wakes the coordinator if it fell. */
  function settle(connectionId: string, update: (mirror: Mirror) => void, channel: RemoteTransportPeerChannel): void {
    const mirror = connections.get(connectionId);
    if (!mirror) return;
    const before = total(mirror);
    update(mirror);
    const after = total(mirror);
    if (after < before) emit({ type: 'drain', connectionId, channel, queued: after });
  }

  function acknowledge(report: Fields, fresh: boolean): void {
    const entry = isCount(report.seq) ? pending.get(report.seq) : undefined;
    if (!entry) return;
    pending.delete(report.seq as number);
    entry.cancel();
    const loads = isRecord(report.loads) ? report.loads : {};
    const touched = new Set([...entry.bytes.keys(), ...Object.keys(loads)]);
    for (const connectionId of touched) {
      const sent = entry.bytes.get(connectionId);
      const load = loads[connectionId];
      settle(
        connectionId,
        (mirror) => {
          if (sent)
            for (const channel of CHANNELS) mirror.hop[channel] = Math.max(0, mirror.hop[channel] - sent[channel]);
          if (fresh && isLoad(load)) mirror.app = load;
        },
        sent && sent.app > 0 ? 'app' : 'control'
      );
    }
  }

  function onReport(report: Fields): void {
    const fresh = isCount(report.n) && report.n > appliedReport;
    if (fresh) appliedReport = report.n as number;
    if (report.type === 'ack') {
      acknowledge(report, fresh);
      return;
    }
    const connectionId = report.connectionId;
    if (!isText(connectionId) || !connections.has(connectionId)) return;
    const mirror = connections.get(connectionId)!;
    const fail = (reason: RemoteTransportPeerBridgeFailure, detail?: string): void => {
      connections.delete(connectionId);
      send({ type: 'close', connectionId });
      emit({ type: 'failed', connectionId, reason, ...(detail ? { detail } : {}) });
    };
    switch (report.type) {
      case 'offer': {
        // What gets signaled is derived here, not taken from the hop.
        let fingerprints: RemoteWebrtcFingerprint[] = [];
        try {
          if (typeof report.sdp === 'string') fingerprints = remoteWebrtcSdpFingerprints(report.sdp);
        } catch {
          fingerprints = [];
        }
        if (!fingerprints.length) return fail('protocol-error', 'offer');
        emit({ type: 'offer', connectionId, sdp: report.sdp as string, fingerprints });
        return;
      }
      case 'candidate': {
        let candidate: RemoteWebrtcCandidate | null;
        try {
          candidate = parseRemoteWebrtcCandidate(report.candidate);
        } catch {
          return;
        }
        emit({ type: 'candidate', connectionId, candidate });
        return;
      }
      case 'open': {
        const size = report.maxMessageSize;
        const maxMessageSize = typeof size === 'number' && !Number.isNaN(size) && size > 0 ? size : null;
        const path = report.path === 'direct' || report.path === 'turn' ? report.path : null;
        if (mirror.open) return;
        mirror.open = true;
        emit({ type: 'open', connectionId, maxMessageSize, fits: remoteTransportCarrierFits(maxMessageSize), path });
        return;
      }
      case 'message': {
        const data = carrierBytes(report.data);
        if (!mirror.open || !data || !isChannel(report.channel)) return;
        emit({ type: 'message', connectionId, channel: report.channel, data });
        return;
      }
      case 'drain':
        if (fresh && isLoad(report.load)) {
          const load = report.load;
          settle(connectionId, (next) => (next.app = load), 'app');
        }
        return;
      case 'failed': {
        connections.delete(connectionId);
        const reason =
          typeof report.reason === 'string' && FAILURES.has(report.reason) ? report.reason : 'channel-failed';
        emit({ type: 'failed', connectionId, reason: reason as RemoteTransportPeerBridgeFailure });
        return;
      }
      default:
        return;
    }
  }

  const live = (connectionId: string): Mirror | undefined => (attachment ? connections.get(connectionId) : undefined);

  return {
    attach() {
      if (attachment) lost();
      attachment = randomUUID();
      appliedReport = -1;
      return attachment;
    },
    detach(value) {
      if (attachment && value === attachment) lost();
    },
    report(value, report) {
      if (!attachment || value !== attachment || !isRecord(report)) return;
      onReport(report);
    },
    clientReleased() {
      send({ type: 'probe' });
    },
    create({ connectionId, session, iceServers }) {
      if (disposed || !attachment || !isText(connectionId) || connections.has(connectionId)) return false;
      connections.set(connectionId, { open: false, hop: { app: 0, control: 0 }, app: [0, 0] });
      send({ type: 'create', connectionId, session, iceServers: [...iceServers] });
      return true;
    },
    offer(connectionId, options) {
      if (!live(connectionId)) return false;
      send({ type: 'offer', connectionId, iceRestart: options?.iceRestart === true });
      return true;
    },
    answer(connectionId, answer) {
      if (!live(connectionId)) return false;
      send({ type: 'answer', connectionId, sdp: answer.sdp, fingerprints: [...answer.fingerprints] });
      return true;
    },
    candidate(connectionId, candidate) {
      if (!live(connectionId)) return false;
      send({ type: 'candidate', connectionId, candidate });
      return true;
    },
    send(connectionId, channel, data) {
      const mirror = live(connectionId);
      if (!mirror?.open || !isChannel(channel) || !(data instanceof Uint8Array)) return false;
      const size = data.byteLength;
      if (size < 1 || size > REMOTE_TRANSPORT_MAX_MESSAGE_BYTES) return false;
      if (total(mirror) + size > LIMITS[channel]) return false;
      mirror.hop[channel] += size;
      const counted = batchBytes.get(connectionId) ?? { app: 0, control: 0 };
      counted[channel] += size;
      batchBytes.set(connectionId, counted);
      if (!batch.length) queueMicrotask(flush);
      batch.push({ connectionId, channel, data: toBase64(data) });
      return true;
    },
    queued(connectionId, channel) {
      const mirror = live(connectionId);
      if (!mirror) return 0;
      return channel ? share(mirror, channel) : total(mirror);
    },
    sample(connectionId) {
      if (live(connectionId)?.open) send({ type: 'sample', connectionId });
    },
    close(connectionId) {
      if (!live(connectionId)) return;
      connections.delete(connectionId);
      send({ type: 'close', connectionId });
    },
    onEvent(next) {
      listener = next;
    },
    dispose() {
      disposed = true;
      lost();
    },
  };
}

export interface RemoteTransportPeerService {
  standIn: RemoteTransportPeerStandIn;
  /** The one peer host every transport session of this daemon shares. */
  peerHost: RemoteTransportPeerHost;
}

/** The daemon's direct-carrier service. */
export function createRemoteTransportPeerService(deps: RemoteTransportPeerStandInDeps): RemoteTransportPeerService {
  const standIn = createRemoteTransportPeerStandIn(deps);
  return { standIn, peerHost: createRemoteTransportPeerHost(standIn) };
}

// ---------------------------------------------------------------------------
// App side (Electron main)
// ---------------------------------------------------------------------------

export interface RemoteTransportPeerEndpointDeps {
  /** `createRemoteTransportPeerWindow(...)`, called on the first `create`. */
  createBridge(): RemoteTransportPeerBridge;
  /** The attach operation on THIS PC's daemon connection. */
  attach(): Promise<unknown>;
  /** The report operation (notify lane, in order). */
  report(attachment: string, report: RemoteTransportPeerLinkReport): void;
  /** The detach operation. */
  detach(attachment: string): void;
}

export interface RemoteTransportPeerEndpoint {
  /** The local daemon is (again) ready: attach, dropping an earlier daemon's peers. */
  attach(): Promise<void>;
  /** One REMOTE_TRANSPORT_PEER_COMMAND_EVENT value from the local daemon. */
  command(value: unknown): void;
  /** App quit: detach and destroy the window. */
  dispose(): void;
}

export function createRemoteTransportPeerEndpoint(deps: RemoteTransportPeerEndpointDeps): RemoteTransportPeerEndpoint {
  let attachment: string | null = null;
  let bridge: RemoteTransportPeerBridge | null = null;
  let reports = 0;
  /** Connections this attachment created and the bridge still holds. */
  const ids = new Set<string>();

  const report = (next: DistributiveOmit<RemoteTransportPeerLinkReport, 'n'>): void => {
    if (attachment) deps.report(attachment, { ...next, n: reports++ } as RemoteTransportPeerLinkReport);
  };
  const loadOf = (connectionId: string): Load => [
    bridge?.queued(connectionId, 'app') ?? 0,
    bridge?.queued(connectionId, 'control') ?? 0,
  ];

  function forward(event: RemoteTransportPeerBridgeEvent): void {
    if (!ids.has(event.connectionId)) return;
    switch (event.type) {
      case 'offer':
        report({ type: 'offer', connectionId: event.connectionId, sdp: event.sdp });
        return;
      case 'candidate':
        report({ type: 'candidate', connectionId: event.connectionId, candidate: event.candidate });
        return;
      case 'open':
        report({
          type: 'open',
          connectionId: event.connectionId,
          maxMessageSize: event.maxMessageSize,
          path: event.path,
        });
        return;
      case 'message':
        report({
          type: 'message',
          connectionId: event.connectionId,
          channel: event.channel,
          data: toBase64(event.data),
        });
        return;
      case 'drain':
        report({ type: 'drain', connectionId: event.connectionId, load: loadOf(event.connectionId) });
        return;
      case 'failed':
        ids.delete(event.connectionId);
        report({
          type: 'failed',
          connectionId: event.connectionId,
          reason: event.reason,
          ...(event.detail ? { detail: event.detail } : {}),
        });
        return;
    }
  }

  const ensureBridge = (): RemoteTransportPeerBridge => {
    if (!bridge) {
      bridge = deps.createBridge();
      bridge.onEvent(forward);
    }
    return bridge;
  };

  /** Closes every connection of an earlier attachment (no event follows). */
  const closeAll = (): void => {
    for (const connectionId of ids) bridge?.close(connectionId);
    ids.clear();
  };

  function run(command: Fields): string[] {
    const connectionId = command.connectionId;
    switch (command.type) {
      case 'create': {
        if (!isText(connectionId) || !Array.isArray(command.iceServers)) return [];
        const created = ensureBridge().create({
          connectionId,
          session: typeof command.session === 'string' ? command.session : '',
          iceServers: command.iceServers,
        });
        if (created) ids.add(connectionId);
        else report({ type: 'failed', connectionId, reason: 'peer-host-unavailable' });
        return [];
      }
      case 'offer':
        if (isText(connectionId) && ids.has(connectionId))
          bridge?.offer(connectionId, { iceRestart: command.iceRestart === true });
        return [];
      case 'answer':
        if (
          isText(connectionId) &&
          ids.has(connectionId) &&
          typeof command.sdp === 'string' &&
          Array.isArray(command.fingerprints)
        ) {
          bridge?.answer(connectionId, {
            sdp: command.sdp,
            fingerprints: command.fingerprints as RemoteWebrtcFingerprint[],
          });
        }
        return [];
      case 'candidate':
        if (isText(connectionId) && ids.has(connectionId)) bridge?.candidate(connectionId, command.candidate);
        return [];
      case 'send': {
        const touched = new Set<string>();
        for (const item of Array.isArray(command.items) ? command.items : []) {
          if (!isRecord(item) || !isText(item.connectionId) || !isChannel(item.channel)) continue;
          const id = item.connectionId;
          touched.add(id);
          if (!ids.has(id)) continue;
          const data = carrierBytes(item.data);
          // The daemon admits against this bridge's own bound, so a refusal
          // means the hop broke its accounting: the carrier fails.
          if (data && bridge?.send(id, item.channel, data)) continue;
          ids.delete(id);
          bridge?.close(id);
          report({ type: 'failed', connectionId: id, reason: 'channel-failed', detail: 'hop' });
        }
        return [...touched];
      }
      case 'sample':
        if (isText(connectionId) && ids.has(connectionId)) bridge?.sample(connectionId);
        return [];
      case 'close':
        if (isText(connectionId) && ids.delete(connectionId)) bridge?.close(connectionId);
        return [];
      default:
        return [];
    }
  }

  /** Permanent: after quit nothing attaches, runs or opens a window again. */
  let disposed = false;
  /** Bumped by every attach and by dispose: only the latest pending attach
   *  may install its response. */
  let generation = 0;

  return {
    async attach() {
      if (disposed) return;
      const mine = ++generation;
      closeAll();
      attachment = null;
      const value = await deps.attach();
      if (!isText(value)) return;
      if (disposed || mine !== generation) {
        // Superseded by a newer attach or by dispose: the daemon may hold this
        // attachment, so hand it back instead of installing it (a stale id is
        // a no-op there).
        deps.detach(value);
        return;
      }
      attachment = value;
      reports = 0;
    },
    command(value) {
      if (disposed || !attachment || !isRecord(value) || value.attachment !== attachment) return;
      if (!isCount(value.seq) || !isRecord(value.command)) return;
      const touched = run(value.command);
      const loads: Record<string, Load> = {};
      for (const connectionId of touched) if (ids.has(connectionId)) loads[connectionId] = loadOf(connectionId);
      report({ type: 'ack', seq: value.seq, loads });
    },
    dispose() {
      disposed = true;
      generation += 1;
      if (attachment) deps.detach(attachment);
      attachment = null;
      ids.clear();
      bridge?.dispose();
      bridge = null;
    },
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
