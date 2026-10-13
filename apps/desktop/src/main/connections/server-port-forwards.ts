// The Ports panel of one server connection: what listens on the server (asked
// from its daemon), and the server ports forwarded to this PC. Each forward is
// its own supervised `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>` child,
// bound to this PC's loopback only. Forwards are saved per server and started
// again when the connection comes back; a port that starts listening later is
// only suggested, never forwarded on its own.
import { createServer } from 'node:net';

import type { DesktopPortForward, DesktopServerPort, DesktopServerPortsView } from '../../shared/contract-server-ports';
import { freeLocalPort, localPortAccepts } from '../ssh/tunnel';
import type { PortForwardStore, SavedPortForward } from './port-forward-store';

/** How long a new forward may take before the panel shows it as failing. */
export const FORWARD_READY_TIMEOUT_MS = 30_000;
/** Ports below this on this PC are never bound (they need elevation). */
export const LOWEST_LOCAL_PORT = 1024;

/** The parts of a supervised ssh tunnel a forward uses (tunnel.ts). */
export interface ForwardTunnel {
  ensure(remotePort: number, timeoutMs: number): Promise<number>;
  readonly boundPort: number;
  readonly alive: boolean;
  readonly failure: Error | null;
  revive(): void;
  close(): Promise<void>;
}

export interface ServerPortForwardsOptions {
  hostId: string;
  store: PortForwardStore;
  /** The server's listening ports, from its daemon. */
  scan(): Promise<DesktopServerPort[]>;
  /** One ssh forward; `freePort` picks its local port, `onChange` hears every state change. */
  createTunnel(options: { freePort: () => Promise<number>; onChange: () => void }): ForwardTunnel;
  /** Runs ssh work under the server's settings (identity file); never prompts. */
  runSsh<T>(run: () => Promise<T>): Promise<T>;
  /** Free on this PC's loopback: nothing accepts there and it can be bound. */
  localPortFree?(port: number): Promise<boolean>;
  freePort?(): Promise<number>;
  readyTimeoutMs?: number;
}

export interface ServerPortForwards {
  view(): DesktopServerPortsView;
  /** Scans the server now. */
  refresh(): Promise<DesktopServerPortsView>;
  forward(remotePort: number, localPort?: number | null): Promise<DesktopPortForward>;
  stop(remotePort: number): Promise<void>;
  dismiss(port: number): void;
  /** http://127.0.0.1:<local>/ of an active forward. */
  browserUrl(remotePort: number): string;
  /** Starts the saved forwards that do not run, and wakes the ones waiting to retry. */
  restore(): Promise<void>;
  subscribe(listener: (view: DesktopServerPortsView) => void): () => void;
  /** Stops every forward of this connection; the saved list stays. */
  dispose(): Promise<void>;
}

/** The code leads the message (Electron's invoke keeps only the message) for
 *  the panel to show in the user's language. */
export type PortForwardErrorCode =
  | 'port-invalid'
  | 'port-privileged'
  | 'port-busy'
  | 'port-not-active'
  | 'window-closed';

export class PortForwardError extends Error {
  override readonly name = 'PortForwardError';
  constructor(
    readonly code: PortForwardErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
  }
}

export function validPortNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535;
}

/** Bindable on 127.0.0.1 and nothing answers there. */
export async function loopbackPortFree(port: number): Promise<boolean> {
  if (await localPortAccepts(port)) return false;
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}

interface Forward {
  remotePort: number;
  /** The port the user asked for (kept), or the one chosen. */
  preferred: number;
  tunnel: ForwardTunnel;
  /** A start that did not get ready in time (the tunnel keeps trying). */
  lastError: string | null;
}

function forwardView(entry: Forward): DesktopPortForward {
  const failure = entry.tunnel.failure;
  const localPort = entry.tunnel.boundPort || entry.preferred;
  if (failure) return { remotePort: entry.remotePort, localPort, status: 'error', message: failure.message };
  if (entry.tunnel.alive) return { remotePort: entry.remotePort, localPort, status: 'active' };
  return {
    remotePort: entry.remotePort,
    localPort,
    status: entry.lastError ? 'error' : 'starting',
    ...(entry.lastError ? { message: entry.lastError } : {}),
  };
}

interface LocalPorts {
  isFree(port: number): Promise<boolean>;
  freePort(): Promise<number>;
}

/** The asked-for local port must be usable as is; without one, the server's
 *  own number when it is free here, else any free port. */
async function chooseLocalPort(
  remotePort: number,
  requested: number | null,
  strict: boolean,
  { isFree, freePort }: LocalPorts
): Promise<number> {
  if (requested !== null && strict) {
    if (requested < LOWEST_LOCAL_PORT) {
      throw new PortForwardError(
        'port-privileged',
        `Ports below ${LOWEST_LOCAL_PORT} on this PC are not used for forwarding.`
      );
    }
    if (!(await isFree(requested)))
      throw new PortForwardError('port-busy', `Port ${requested} on this PC is already in use.`);
    return requested;
  }
  const candidate = requested ?? remotePort;
  if (candidate >= LOWEST_LOCAL_PORT && (await isFree(candidate))) return candidate;
  return freePort();
}

/** Server ports worth offering: ones that started listening after the first
 *  scan, minus those forwarded, dismissed or no longer listening. */
function createSuggestions() {
  /** Every port seen since the first scan; a port not in it is new. */
  let known: Set<number> | null = null;
  const suggested = new Set<number>();
  const dismissed = new Set<number>();
  return {
    update(ports: DesktopServerPort[], forwards: ReadonlyMap<number, unknown>): void {
      const listening = new Set(ports.map((port) => port.port));
      if (known) {
        for (const port of listening) if (!known.has(port)) suggested.add(port);
        for (const port of listening) known.add(port);
      } else {
        known = new Set(listening);
      }
      for (const port of [...suggested]) {
        if (!listening.has(port) || forwards.has(port) || dismissed.has(port)) suggested.delete(port);
      }
    },
    dismiss(port: number): void {
      dismissed.add(port);
      suggested.delete(port);
    },
    forget(port: number): void {
      suggested.delete(port);
    },
    list: (): number[] => [...suggested].sort((a, b) => a - b),
  };
}

/** What starting, creating and restoring a forward share with the panel. */
interface ForwardEnv {
  options: ServerPortForwardsOptions;
  forwards: Map<number, Forward>;
  inflight: Map<number, Promise<DesktopPortForward>>;
  suggestions: ReturnType<typeof createSuggestions>;
  localPorts: LocalPorts;
  readyTimeoutMs: number;
  emit(): void;
  persist(): Promise<void>;
  isDisposed(): boolean;
}

async function startForward(env: ForwardEnv, remotePort: number, localPort: number): Promise<Forward> {
  const { options, forwards, localPorts, readyTimeoutMs, emit } = env;
  let chosen = localPort;
  const entry: Forward = {
    remotePort,
    preferred: localPort,
    lastError: null,
    tunnel: options.createTunnel({
      // The first start takes the chosen port; a restart that finds it taken gets any free one.
      freePort: async () => {
        if (chosen) {
          const port = chosen;
          chosen = 0;
          return port;
        }
        return localPorts.freePort();
      },
      onChange: emit,
    }),
  };
  forwards.set(remotePort, entry);
  emit();
  try {
    await options.runSsh(() => entry.tunnel.ensure(remotePort, readyTimeoutMs));
    entry.lastError = null;
  } catch (error) {
    entry.lastError = error instanceof Error ? error.message : String(error);
  }
  emit();
  return entry;
}

async function createForward(
  env: ForwardEnv,
  remotePort: number,
  localPort: number | null | undefined
): Promise<DesktopPortForward> {
  const { forwards, suggestions } = env;
  if (env.isDisposed()) throw new PortForwardError('window-closed', 'The server window is closed.');
  if (!validPortNumber(remotePort))
    throw new PortForwardError('port-invalid', 'Choose a server port between 1 and 65535.');
  const strict = localPort !== null && localPort !== undefined;
  if (strict && !validPortNumber(localPort)) {
    throw new PortForwardError('port-invalid', `Choose a local port between ${LOWEST_LOCAL_PORT} and 65535.`);
  }
  const existing = forwards.get(remotePort);
  if (existing && !existing.tunnel.failure) return forwardView(existing);
  if (existing) {
    forwards.delete(remotePort);
    await existing.tunnel.close();
  }
  const chosen = await chooseLocalPort(remotePort, strict ? localPort : null, strict, env.localPorts);
  suggestions.forget(remotePort);
  const entry = await startForward(env, remotePort, chosen);
  await env.persist();
  return forwardView(entry);
}

async function restoreSaved(env: ForwardEnv): Promise<void> {
  const { options, forwards, inflight } = env;
  if (env.isDisposed()) return;
  const saved = await options.store.load(options.hostId);
  const starts: Promise<unknown>[] = [];
  for (const { remotePort, localPort } of saved) {
    if (inflight.has(remotePort)) continue;
    const entry = forwards.get(remotePort);
    if (entry && !entry.tunnel.failure) {
      // Running or waiting out its retry delay: try now (a live child is left alone).
      await options.runSsh(async () => entry.tunnel.revive());
      continue;
    }
    if (entry) {
      forwards.delete(remotePort);
      await entry.tunnel.close();
    }
    starts.push(
      chooseLocalPort(remotePort, localPort, false, env.localPorts).then((port) =>
        env.isDisposed() || forwards.has(remotePort) ? null : startForward(env, remotePort, port)
      )
    );
  }
  await Promise.all(starts);
  env.emit();
}

export function createServerPortForwards(options: ServerPortForwardsOptions): ServerPortForwards {
  const forwards = new Map<number, Forward>();
  const listeners = new Set<(view: DesktopServerPortsView) => void>();
  const suggestions = createSuggestions();
  let detected: DesktopServerPort[] | null = null;
  let scanError: string | undefined;
  let disposed = false;
  const inflight = new Map<number, Promise<DesktopPortForward>>();
  let restoring: Promise<void> | null = null;

  const view = (): DesktopServerPortsView => ({
    detected: detected ? detected.map((port) => ({ ...port, addresses: [...port.addresses] })) : null,
    ...(scanError ? { scanError } : {}),
    forwards: [...forwards.values()].sort((a, b) => a.remotePort - b.remotePort).map(forwardView),
    suggested: suggestions.list(),
  });
  const emit = (): void => {
    if (disposed) return;
    const current = view();
    for (const listener of listeners) listener(current);
  };
  const persist = (): Promise<void> =>
    options.store.save(
      options.hostId,
      [...forwards.values()].map<SavedPortForward>((entry) => ({
        remotePort: entry.remotePort,
        localPort: entry.tunnel.boundPort || entry.preferred,
      }))
    );

  const env: ForwardEnv = {
    options,
    forwards,
    inflight,
    suggestions,
    localPorts: {
      isFree: options.localPortFree ?? loopbackPortFree,
      freePort: options.freePort ?? freeLocalPort,
    },
    readyTimeoutMs: options.readyTimeoutMs ?? FORWARD_READY_TIMEOUT_MS,
    emit,
    persist,
    isDisposed: () => disposed,
  };

  return {
    view,
    async refresh() {
      try {
        const ports = await options.scan();
        detected = ports;
        scanError = undefined;
        suggestions.update(ports, forwards);
      } catch (error) {
        detected = null;
        scanError = error instanceof Error ? error.message : String(error);
      }
      emit();
      return view();
    },
    forward(remotePort, localPort) {
      // One request per server port at a time: a second click joins the first.
      const pending = inflight.get(remotePort);
      if (pending) return pending;
      const run = createForward(env, remotePort, localPort).finally(() => inflight.delete(remotePort));
      inflight.set(remotePort, run);
      return run;
    },
    async stop(remotePort) {
      await inflight.get(remotePort)?.catch(() => undefined);
      const entry = forwards.get(remotePort);
      if (!entry) return;
      forwards.delete(remotePort);
      await entry.tunnel.close();
      await persist();
      emit();
    },
    dismiss(port) {
      suggestions.dismiss(port);
      emit();
    },
    browserUrl(remotePort) {
      const entry = forwards.get(remotePort);
      if (!entry?.tunnel.alive || !entry.tunnel.boundPort) {
        throw new PortForwardError('port-not-active', `Port ${remotePort} is not forwarded to this PC right now.`);
      }
      return `http://127.0.0.1:${entry.tunnel.boundPort}/`;
    },
    restore() {
      // Startup and a reconnect may both ask; they share one pass.
      restoring ??= restoreSaved(env).finally(() => {
        restoring = null;
      });
      return restoring;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      disposed = true;
      listeners.clear();
      const closing = [...forwards.values()].map((entry) => entry.tunnel.close());
      forwards.clear();
      await Promise.all(closing);
    },
  };
}
