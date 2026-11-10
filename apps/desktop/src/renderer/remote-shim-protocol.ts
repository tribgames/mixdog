// The phone's one switch from Node call names to the protocol. The DesktopApi table (remote-shim-api.ts) still names calls the way
// the Node core did (`call('gitStatus', [cwd])`); here each name is answered by the adapter that owns it
// (`remote-protocol-<group>.ts`, found by remote-shim-adapters.ts, no registration edit) or it fails with the method's name.
// A Node name no adapter claimed is never sent: the core would answer "unknown method" to a frame it cannot read.
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { armCallWatch } from './remote-shim-call-watch';
import { firstFrame, scopeClient } from '../../../mobile/src/phone-send-scope';
import { remoteConnectionInterruptedError } from './remote-connection-state';
import { runQueued } from './remote-protocol-queue';
import type { RemoteShimContext } from './remote-shim-state';

/** What an adapter reaches the core through. */
export interface PhoneProtocolHost {
  readonly ctx: RemoteShimContext;
  /** The connected client; present once the first connection is up (calls wait for it). */
  client(): ProtocolClient<SessionFold>;
  /** The scoped feeds a push lane reads (terminal, files, editor, visualize): opened while the page uses the lane. */
  declareLane(lane: string, feedIds: readonly string[]): void;
  /** Calls `listener` with the client that is up and with each client that replaces it (a re-pairing dials a new one in the same page);
   *  an adapter that reads a client's events wires them per client here. Returns the unsubscribe. */
  onClient?(listener: (client: ProtocolClient<SessionFold>) => void): () => void;
}

export type NodeCall = (params: unknown[], host: PhoneProtocolHost) => unknown;

/** One feature group's answers, keyed by the Node method name the DesktopApi table calls. */
export interface PhoneProtocolAdapter {
  readonly group: string;
  /** Calls that answer. */
  readonly calls?: Readonly<Record<string, NodeCall>>;
  /** Calls the page does not wait for; a method only in `calls` is also accepted here. */
  readonly fires?: Readonly<Record<string, (params: unknown[], host: PhoneProtocolHost) => void | Promise<void>>>;
  /** Wires the group's pushed events into the context's listener sets (`ctx.fanOut(ctx.termListeners, ...)`); returns its teardown. */
  install?(host: PhoneProtocolHost): (() => void) | undefined;
}

/** A Node method name no adapter owns yet. */
export class UnclaimedNodeMethodError extends Error {
  constructor(readonly method: string) {
    super(`phone: Node method '${method}' has no protocol adapter`);
    this.name = 'UnclaimedNodeMethodError';
  }
}

/** Calls that must reach a running turn now: they do not wait for the first sync. */
const UNGATED_CALLS = new Set(['abortSession', 'resolveToolApprovalForSession', 'answerApprovalNotification', 'provideSecretInput']);

export interface ProtocolRouter {
  call<T = unknown>(method: string, params: unknown[]): Promise<T>;
  /** Starts the reads the app makes as it mounts, once the client is usable; the app's first identical read takes each answer. */
  prefetch(reads: ReadonlyArray<readonly [string, unknown[]]>): void;
  fire(method: string, params: unknown[]): void;
  install(): void;
}

/** Desk-side state reads with no side effect: only these are prefetched or share a queued request (Node's COALESCED_READS and
 *  COALESCED_CAPABILITY_READS, remote-shim-calls.ts:32-60 at b6f10295a). */
const COALESCED_READS = new Set([
  'getSnapshot',
  'getUpdaterState',
  'listProjects',
  'readActivityRailPins',
  'readCapabilities',
  'readHostDisplayPreferences',
  'readSettings',
  'viewerDevice',
  'getTaskWorkspace',
]);
const COALESCED_CAPABILITY_READS = new Set([
  'getBotOrder',
  'getOrchestrationMode',
  'getConfiguredOrchestrationMode',
  'getProviderSetup',
  'getVoiceStatus',
  'getWorktreeSettings',
  'listWorkflows',
  'skillsStatus',
]);
const coalescedReadKey = (method: string, params: unknown[]): string => {
  if (method === 'invokeCapability') {
    const capability = (params[0] as { capability?: unknown } | undefined)?.capability;
    if (typeof capability !== 'string' || !COALESCED_CAPABILITY_READS.has(capability)) return '';
  } else if (!COALESCED_READS.has(method)) return '';
  return `${method}\0${JSON.stringify(params)}`;
};
/** Boot reads of state the view sync owns: they still wait for it, so their answer can never be older than the baseline the sync installs. */
const SYNC_ORDERED_BOOT_READS = new Set(['getSnapshot', 'listProjects']);
/** Whatever the app has not asked for when this window closes is dropped, so no later read is ever served from boot. */
export const BOOT_READ_WINDOW_MS = 10_000;

/** A name claimed by two adapters is a defect: it throws here, at start, naming both. */
export function createProtocolRouter(
  adapters: readonly PhoneProtocolAdapter[],
  link: {
    host: PhoneProtocolHost;
    /** Resolves once the client is up (the first connect). */
    started(): Promise<unknown>;
    /** Resolves once the connection that is up is synced (the first connect included). */
    synced(): Promise<void>;
    /** Probe a connection whose call is overdue (Node's wakeProbe). */
    probe(): void;
    /** Nothing has arrived since `since` and no probe is out: a call sent then is worth a probe. */
    silentSince(since: number): boolean;
  }
): ProtocolRouter {
  const owners = new Map<string, string>();
  const calls = new Map<string, NodeCall>();
  const fires = new Map<string, (params: unknown[], host: PhoneProtocolHost) => void | Promise<void>>();
  for (const adapter of adapters) {
    for (const name of new Set([...Object.keys(adapter.calls ?? {}), ...Object.keys(adapter.fires ?? {})])) {
      const owner = owners.get(name);
      if (owner !== undefined) throw new Error(`phone: Node method '${name}' is claimed by both '${owner}' and '${adapter.group}'`);
      owners.set(name, adapter.group);
    }
    for (const [name, handler] of Object.entries(adapter.calls ?? {})) calls.set(name, handler);
    for (const [name, handler] of Object.entries(adapter.fires ?? {})) fires.set(name, handler);
  }
  const waiting = new Map<number, true>();
  let nextId = 1;
  const bootReads = new Map<string, Promise<unknown>>();
  /** Identical state reads still waiting for the connection or the view sync. A read already sent is never joined, so a re-read after a change
   *  always gets an answer of its own (Node: queuedReads, remote-shim-calls.ts:306-333). */
  const queuedReads = new Map<string, Promise<unknown>>();
  // What the library says of a lost connection is what the page knows as an interrupted call.
  const interrupted = (error: unknown): unknown => {
    const kind = (error as { detail?: { kind?: string } } | null)?.detail?.kind;
    return kind === 'connectionLost' || kind === 'clientClosed' ? remoteConnectionInterruptedError() : error;
  };

  const dispatch = <T>(method: string, params: unknown[], gated: boolean, onGate?: () => void): Promise<T> => {
      const handler = calls.get(method);
      if (!handler) return Promise.reject(new UnclaimedNodeMethodError(method));
      return new Promise<T>((resolve, reject) => {
        // Node's send(): the call waits for the connection and the view sync first (remote-shim-calls.ts:298-303), and its deadline starts only
        // when it is handed on (invoke, :239). A call held by the gate cannot time out, so one that timed out was always run.
        let settle = (): void => undefined;
        // Enqueued on receipt, as Node's relay does (remote-relay-client-calls.ts:481): readiness is awaited inside the queued job, so a
        // call whose connection is not ready yet still keeps its place before every call that arrives after it.
        runQueued(link.host.ctx, method, params, async () => {
          if (!gated || UNGATED_CALLS.has(method)) await link.started();
          else await link.synced();
          onGate?.();
          const id = nextId++;
          waiting.set(id, true);
          // The deadline of this call alone; an overdue call first probes the connection.
          const watch = armCallWatch(waiting, id, reject, link.probe, link.silentSince);
          settle = (): void => {
            watch.cancel();
            waiting.delete(id);
          };
          // Node restarts the deadline and starts measuring silence when this call's own frame has left, not when the call began (:258-268):
          // the client the handler reaches hands that frame to this call's claim. A call that fails before sending claims nothing.
          const claim = firstFrame((sent) => void sent.then(watch.transmitted));
          const host: PhoneProtocolHost = { ...link.host, client: () => scopeClient(link.host.client(), claim) };
          return handler(params, host);
        }).then(
          (value) => {
            settle();
            resolve(value as T);
          },
          (error: unknown) => {
            settle();
            reject(interrupted(error));
          }
        );
      });
  };

  const queuedRead = <T>(key: string, method: string, params: unknown[]): Promise<T> => {
    const queued = queuedReads.get(key);
    if (queued) return queued as Promise<T>;
    const drop = (): void => {
      if (queuedReads.get(key) === read) queuedReads.delete(key);
    };
    const read: Promise<T> = dispatch<T>(method, params, true, drop);
    read.catch(drop);
    queuedReads.set(key, read);
    return read;
  };

  return {
    // The first identical read takes a prefetched answer before any gate: one use, and a failed read was never kept.
    call<T>(method: string, params: unknown[]): Promise<T> {
      const key = coalescedReadKey(method, params);
      if (!key) return dispatch<T>(method, params, true);
      const booted = bootReads.get(key);
      if (booted) {
        bootReads.delete(key);
        return booted as Promise<T>;
      }
      return queuedRead<T>(key, method, params);
    },
    prefetch(reads) {
      for (const [method, params] of reads) {
        const key = coalescedReadKey(method, params);
        if (!key || bootReads.has(key)) continue;
        // Everything but the sync-ordered reads leaves as soon as the client is up, beside the sync instead of behind it.
        const read = SYNC_ORDERED_BOOT_READS.has(method) ? queuedRead(key, method, params) : dispatch(method, params, false);
        read.catch(() => {
          if (bootReads.get(key) === read) bootReads.delete(key);
        });
        bootReads.set(key, read);
      }
      setTimeout(() => bootReads.clear(), BOOT_READ_WINDOW_MS);
    },
    fire(method: string, params: unknown[]): void {
      // A call the page does not wait for is still one call of the connection's queue, as in Node. Node's fire() waits for the connection,
      // not for the sync (remote-shim-calls.ts:354-359), and a failure is nobody's to hear.
      const handler = fires.get(method) ?? calls.get(method);
      if (!handler) throw new UnclaimedNodeMethodError(method);
      void runQueued(link.host.ctx, method, params, async () => {
        await link.started();
        return handler(params, link.host);
      }).catch(() => undefined);
    },
    install(): void {
      for (const adapter of adapters) adapter.install?.(link.host);
    },
  };
}
