// The phone's one switch from Node call names to the protocol. The DesktopApi table (remote-shim-api.ts) still names calls the way
// the Node core did (`call('gitStatus', [cwd])`); here each name is answered by the adapter that owns it
// (`remote-protocol-<group>.ts`, found by remote-shim-adapters.ts, no registration edit) or it fails with the method's name.
// A Node name no adapter claimed is never sent: the core would answer "unknown method" to a frame it cannot read.
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { armRemoteCallDeadline } from './remote-call-deadline';
import { remoteConnectionInterruptedError } from './remote-connection-state';
import type { RemoteShimContext } from './remote-shim-state';

/** What an adapter reaches the core through. */
export interface PhoneProtocolHost {
  readonly ctx: RemoteShimContext;
  /** The connected client; present once the first connection is up (calls wait for it). */
  client(): ProtocolClient<SessionFold>;
  /** The scoped feeds a push lane reads (terminal, files, editor, visualize): opened while the page uses the lane. */
  declareLane(lane: string, feedIds: readonly string[]): void;
}

export type NodeCall = (params: unknown[], host: PhoneProtocolHost) => unknown;

/** One feature group's answers, keyed by the Node method name the DesktopApi table calls. */
export interface PhoneProtocolAdapter {
  readonly group: string;
  /** Calls that answer. */
  readonly calls?: Readonly<Record<string, NodeCall>>;
  /** Calls the page does not wait for; a method only in `calls` is also accepted here. */
  readonly fires?: Readonly<Record<string, (params: unknown[], host: PhoneProtocolHost) => void>>;
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
  fire(method: string, params: unknown[]): void;
  install(): void;
}

/** A name claimed by two adapters is a defect: it throws here, at start, naming both. */
export function createProtocolRouter(
  adapters: readonly PhoneProtocolAdapter[],
  link: {
    host: PhoneProtocolHost;
    /** Resolves once the client is up (the first connect). */
    started(): Promise<unknown>;
    /** Resolves once the connection that is up is synced (the first connect included). */
    synced(): Promise<void>;
    /** Probe a connection whose call is overdue. */
    probe(): void;
  }
): ProtocolRouter {
  const owners = new Map<string, string>();
  const calls = new Map<string, NodeCall>();
  const fires = new Map<string, (params: unknown[], host: PhoneProtocolHost) => void>();
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
  // What the library says of a lost connection is what the page knows as an interrupted call.
  const interrupted = (error: unknown): unknown => {
    const kind = (error as { detail?: { kind?: string } } | null)?.detail?.kind;
    return kind === 'connectionLost' || kind === 'clientClosed' ? remoteConnectionInterruptedError() : error;
  };

  return {
    call<T>(method: string, params: unknown[]): Promise<T> {
      const handler = calls.get(method);
      if (!handler) return Promise.reject(new UnclaimedNodeMethodError(method));
      return new Promise<T>((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, true);
        // The deadline of this call alone; an overdue call first probes the connection.
        const cancel = armRemoteCallDeadline(waiting, id, reject, link.probe);
        const settle = (): void => {
          cancel();
          waiting.delete(id);
        };
        (async () => {
          if (UNGATED_CALLS.has(method)) await link.started();
          else await link.synced();
          return handler(params, link.host);
        })().then(
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
    },
    fire(method: string, params: unknown[]): void {
      const handler = fires.get(method);
      if (handler) {
        handler(params, link.host);
        return;
      }
      const call = calls.get(method);
      if (!call) throw new UnclaimedNodeMethodError(method);
      void Promise.resolve(call(params, link.host)).catch(() => undefined);
    },
    install(): void {
      for (const adapter of adapters) adapter.install?.(link.host);
    },
  };
}
