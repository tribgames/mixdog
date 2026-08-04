import { constants as osConstants, setPriority } from 'node:os';
import * as nodeModule from 'node:module';

import { EngineHost } from './engine-host';
import type { EngineSnapshot } from '../shared/contract';
import {
  ENGINE_HOST_RPC_METHODS,
  type EngineHostRpcMethod,
} from './engine-host-api';
import {
  createLatestStateMailbox,
  engineWorkerError,
  type EngineWorkerInbound,
  type EngineWorkerOutbound,
} from './engine-worker-protocol';
import {
  createSnapshotDeltaEncoder,
  shouldPublishSessionState,
  type SnapshotDeltaEncoder,
} from './state-delta';

interface UtilityParentPort {
  postMessage(message: EngineWorkerOutbound): void;
  on(event: 'message', listener: (event: { data?: unknown } | unknown) => void): unknown;
  start?(): void;
}

const parentPort = (process as NodeJS.Process & { parentPort?: UtilityParentPort }).parentPort;
if (!parentPort) throw new Error('Mixdog engine worker requires an Electron utility-process parent port.');

// V8 compile cache (VS Code parity): the engine host dynamically imports the
// entire unbundled mixdog runtime (hundreds of ESM modules) on init — caching
// their compiled bytecode across launches removes that parse cost from every
// cold start. Best-effort: unavailable Node builds simply skip it.
try {
  (nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache?.();
} catch { /* compile cache is a launch-speed optimization only */ }

// Desktop-only scheduling policy: retain all agent/tool concurrency and let
// the engine consume every idle core, but yield immediately when Chromium's
// main/renderer processes need CPU. Child tools inherit this priority.
try {
  setPriority(0, osConstants.priority.PRIORITY_BELOW_NORMAL);
} catch (error) {
  console.warn('Mixdog engine worker could not lower its process priority:', error);
}

const rpcMethods = new Set<string>(ENGINE_HOST_RPC_METHODS);
const stateEncoder = createSnapshotDeltaEncoder();
const sessionStateEncoders = new Map<string, SnapshotDeltaEncoder>();
const latestSessionStates = new Map<string, EngineSnapshot>();
// The last provenance per session, so a delta RESYNC re-sends the very same
// frame description instead of an unversioned one.
const latestSessionProvenance = new Map<string, {
  frameSource?: 'live' | 'replay';
  contentRevision?: number;
}>();
const visibleSessionIds = new Set<string>();
let host: EngineHost | null = null;
let unsubscribeState: (() => void) | null = null;
let unsubscribeSessions: (() => void) | null = null;
let unsubscribeAgentPool: (() => void) | null = null;
let unsubscribeSessionStates: (() => void) | null = null;
let initializing: Promise<void> | null = null;

function post(message: EngineWorkerOutbound): void {
  parentPort!.postMessage(message);
}

const stateMailbox = createLatestStateMailbox<EngineSnapshot>((sequence, snapshot) => {
  post({ kind: 'state', sequence, wire: stateEncoder.encode(snapshot) });
});

function postSessionState(
  sessionId: string,
  snapshot: EngineSnapshot,
  provenance: { frameSource?: 'live' | 'replay'; contentRevision?: number } = {},
): void {
  let encoder = sessionStateEncoders.get(sessionId);
  if (!encoder) encoder = createSnapshotDeltaEncoder();
  if (snapshot === null) {
    post({
      kind: 'session-state',
      sessionId,
      wire: encoder.encode(null),
      ...(provenance.frameSource ? { frameSource: provenance.frameSource } : {}),
      ...(typeof provenance.contentRevision === 'number'
        ? { contentRevision: provenance.contentRevision }
        : {}),
    });
    sessionStateEncoders.delete(sessionId);
    latestSessionStates.delete(sessionId);
    latestSessionProvenance.delete(sessionId);
    return;
  }
  sessionStateEncoders.set(sessionId, encoder);
  latestSessionStates.delete(sessionId);
  latestSessionStates.set(sessionId, snapshot);
  latestSessionProvenance.set(sessionId, provenance);
  post({
    kind: 'session-state',
    sessionId,
    wire: encoder.encode(snapshot),
    ...(provenance.frameSource ? { frameSource: provenance.frameSource } : {}),
    ...(typeof provenance.contentRevision === 'number'
      ? { contentRevision: provenance.contentRevision }
      : {}),
  });
}

async function initialize(message: Extract<EngineWorkerInbound, { kind: 'init' }>): Promise<void> {
  if (host) {
    post({ kind: 'ready' });
    return;
  }
  if (initializing) return initializing;
  initializing = (async () => {
    const next = new EngineHost(message.options);
    host = next;
    unsubscribeState = next.subscribe((snapshot) => {
      stateMailbox.publish(snapshot);
    });
    unsubscribeSessions = next.subscribeSessions((sessions) => {
      post({ kind: 'sessions', sessions });
    });
    unsubscribeAgentPool = next.subscribeAgentPool((agents) => {
      post({ kind: 'agent-pool', agents });
    });
    unsubscribeSessionStates = next.subscribeSessionStates((update) => {
      if (!shouldPublishSessionState(update.sessionId, update.snapshot, visibleSessionIds)) return;
      // Keep the 20 Hz publication cadence, but preserve settled transcript
      // identity across the structured-clone boundary just like focused state.
      postSessionState(update.sessionId, update.snapshot, update);
    });
    stateMailbox.publish(next.getSnapshot());
    post({ kind: 'ready' });
  })();
  try {
    await initializing;
  } finally {
    initializing = null;
  }
}

async function executeRequest(
  message: Extract<EngineWorkerInbound, { kind: 'request' }>,
): Promise<void> {
  const current = host;
  if (!current) {
    post({
      kind: 'response',
      id: message.id,
      ok: false,
      error: { name: 'Error', message: 'Mixdog engine worker is not initialized.' },
    });
    return;
  }
  if (!rpcMethods.has(message.method)) {
    post({
      kind: 'response',
      id: message.id,
      ok: false,
      error: { name: 'TypeError', message: 'Mixdog engine worker method is unavailable.' },
    });
    return;
  }
  try {
    if (message.method === 'dispose') {
      await disposeWorker();
      post({ kind: 'response', id: message.id, ok: true, value: null });
      return;
    }
    if (message.method === 'setVisibleSessions') {
      visibleSessionIds.clear();
      const requested = message.args[0];
      if (Array.isArray(requested)) {
        for (const value of requested) {
          const sessionId = String(value || '');
          if (/^[A-Za-z0-9_-]+$/.test(sessionId)) visibleSessionIds.add(sessionId);
        }
      }
    }
    const method = (current as unknown as Record<
      EngineHostRpcMethod,
      (...args: unknown[]) => unknown
    >)[message.method];
    const value = await method.apply(current, message.args);
    post({ kind: 'response', id: message.id, ok: true, value: value ?? null });
  } catch (error) {
    post({ kind: 'response', id: message.id, ok: false, error: engineWorkerError(error) });
  }
}

function messageData(event: { data?: unknown } | unknown): unknown {
  return event && typeof event === 'object' && 'data' in event
    ? (event as { data?: unknown }).data
    : event;
}

parentPort.on('message', (event) => {
  const value = messageData(event);
  if (!value || typeof value !== 'object') return;
  const message = value as EngineWorkerInbound;
  if (message.kind === 'init') {
    void initialize(message).catch((error) => {
      console.error('Failed to initialize the Mixdog engine worker:', error);
      process.exit(1);
    });
    return;
  }
  if (message.kind === 'state-resync') {
    if (!host) return;
    stateEncoder.reset();
    stateMailbox.reset(host.getSnapshot());
    return;
  }
  if (message.kind === 'session-state-resync') {
    const sessionId = String(message.sessionId || '');
    if (!sessionStateEncoders.has(sessionId) || !latestSessionStates.has(sessionId)) return;
    sessionStateEncoders.get(sessionId)!.reset();
    postSessionState(
      sessionId,
      latestSessionStates.get(sessionId)!,
      latestSessionProvenance.get(sessionId) ?? {},
    );
    return;
  }
  if (message.kind === 'state-ack' && Number.isSafeInteger(message.sequence)) {
    stateMailbox.acknowledge(message.sequence);
    return;
  }
  if (message.kind === 'request' && Number.isSafeInteger(message.id)
    && rpcMethods.has(String(message.method)) && Array.isArray(message.args)) {
    void executeRequest(message);
  }
});
parentPort.start?.();

async function disposeWorker(): Promise<void> {
  unsubscribeState?.();
  unsubscribeState = null;
  unsubscribeSessions?.();
  unsubscribeSessions = null;
  unsubscribeAgentPool?.();
  unsubscribeAgentPool = null;
  unsubscribeSessionStates?.();
  unsubscribeSessionStates = null;
  const current = host;
  host = null;
  stateMailbox.clear();
  sessionStateEncoders.clear();
  latestSessionStates.clear();
  latestSessionProvenance.clear();
  visibleSessionIds.clear();
  if (current) await current.dispose();
}

process.once('SIGTERM', () => {
  void disposeWorker().finally(() => process.exit(0));
});
