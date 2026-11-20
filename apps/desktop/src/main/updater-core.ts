// The updater's view of the local Mixdog core (LR §5.4): hold new work, read
// what runs, wind the core down with `stop{whenIdle, update}` (or
// `abortConfirmed` after the user confirmed the listing they saw) and wait for
// the process to exit before the installer replaces its files. Every call goes
// to the core's control listener (`/mgmt/*`, LR §6.1), which answers while the
// core's RPC runtime is busy or draining. The new core is not started here:
// the relaunched app starts it, and it refuses to start beside this one.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';

import { resolveRuntimeRoot } from '../shared/core-src/runtime/shared/runtime-root.mjs';

export interface DaemonDiscovery {
  /** The WebSocket listener; null while the core does not serve (no `rpc`). */
  rpcPort: number | null;
  /** The control listener (`/mgmt/*`, `/health`). */
  controlPort: number;
  /** The one token that opens both listeners. */
  token: string;
  pid: number;
  instanceId: string;
  /** The OS start time of `pid`: with the pid it names this process, not a later one that reused the pid. */
  processStartTime: string;
  state: string;
  version: string;
  build: string;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const port = (value: unknown): number | null =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535 ? (value as number) : null;

/** daemon.json as the core writes it (LR §4): `pid`, `endpoints.session.token`
 *  and the `core` block with the control port and, while serving, the RPC port. */
export function parseDaemonDiscovery(raw: unknown): DaemonDiscovery | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as {
    pid?: unknown;
    endpoints?: { session?: { token?: unknown } };
    core?: {
      version?: unknown;
      build?: unknown;
      instanceId?: unknown;
      processStartTime?: unknown;
      state?: unknown;
      rpc?: { port?: unknown };
      control?: { port?: unknown };
    };
  };
  const pid = record.pid;
  const token = record.endpoints?.session?.token;
  const core = record.core;
  const controlPort = port(core?.control?.port);
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof token !== 'string' || !token || !core || controlPort === null) return null;
  return {
    rpcPort: port(core.rpc?.port),
    controlPort,
    token,
    pid,
    instanceId: text(core.instanceId) ?? '',
    processStartTime: text(core.processStartTime) ?? '',
    state: text(core.state) ?? '',
    version: text(core.version) ?? '',
    build: text(core.build) ?? '',
  };
}

/** A control request the core refused (`code` is the state machine's refusal code). */
export class CoreControlError extends Error {
  override readonly name = 'CoreControlError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface CoreRunningWork {
  kind: string;
  threadId: string | null;
  turnId: string | null;
  title: string;
}

/** `GET /mgmt/status`: the fields the updater reads. */
export interface CoreStatus {
  state: string;
  hold: boolean;
  running: CoreRunningWork[];
  drain: { drainId: string; confirmToken: string; releasing: boolean } | null;
}

type StopMode = 'whenIdle' | 'abortConfirmed';

/** The management path of one core. A new discovery is read per call: the
 *  token and the port change with every core. */
export interface CoreControl {
  /** Null when no core runs (no discovery file, or its process is gone). Throws when a core may run but cannot be asked. */
  status(): Promise<{ status: CoreStatus; discovery: DaemonDiscovery } | null>;
  hold(on: boolean): Promise<void>;
  stop(mode: StopMode, confirmToken?: string): Promise<void>;
  cancelDrain(drainId: string): Promise<void>;
}

export interface CoreControlDeps {
  discoveryPath?: string;
}

/** Positive evidence that no process has this pid: the OS says so (ESRCH). A pid the check cannot judge (out of range, a failure) is
 *  not gone. */
function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
const REFUSED_CONNECTION = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT']);

function call(discovery: DaemonDiscovery, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: discovery.controlPort,
        method,
        path,
        headers: {
          Authorization: `Bearer ${discovery.token}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            // A body that is not JSON is reported by status below.
          }
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolve(json);
          const refusal = (json as { error?: { code?: string; message?: string } } | null)?.error;
          reject(
            new CoreControlError(
              status,
              refusal?.code ?? 'http',
              refusal?.message ?? `control listener answered ${status}`
            )
          );
        });
      }
    );
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

function statusOf(value: unknown): CoreStatus {
  const raw = (value ?? {}) as Partial<CoreStatus> & {
    running?: Partial<CoreRunningWork>[];
    drain?: Partial<CoreStatus['drain']> | null;
  };
  const drain = raw.drain;
  return {
    state: String(raw.state ?? ''),
    hold: raw.hold === true,
    running: (raw.running ?? []).map((work) => ({
      kind: String(work.kind ?? ''),
      threadId: work.threadId ?? null,
      turnId: work.turnId ?? null,
      title: String(work.title ?? ''),
    })),
    drain:
      drain && typeof drain.drainId === 'string' && typeof drain.confirmToken === 'string'
        ? { drainId: drain.drainId, confirmToken: drain.confirmToken, releasing: drain.releasing === true }
        : null,
  };
}

export function createCoreControl(deps: CoreControlDeps = {}): CoreControl {
  const discoveryPath = deps.discoveryPath ?? join(resolveRuntimeRoot(), 'daemon.json');
  const discover = async (): Promise<DaemonDiscovery | null> => {
    try {
      const raw = await readFile(discoveryPath, 'utf8');
      const found = parseDaemonDiscovery(raw);
      if (found) return found;
      // A record without a control listener is a 1.4.5 daemon's: no core when its process is gone. Anything else that cannot be
      // read is a core that cannot be asked, not an idle one.
      let legacy: {
        pid?: unknown;
        protocol?: unknown;
        core?: unknown;
        endpoints?: { session?: { port?: unknown; token?: unknown } };
      } | null = null;
      try {
        legacy = JSON.parse(raw);
      } catch {
        // Malformed: unknown below.
      }
      const session = legacy?.endpoints?.session;
      const validLegacy =
        legacy !== null &&
        typeof legacy === 'object' &&
        legacy.core === undefined &&
        legacy.protocol === 1 &&
        typeof legacy.pid === 'number' &&
        Number.isSafeInteger(legacy.pid) &&
        legacy.pid > 0 &&
        port(session?.port) !== null &&
        typeof session?.token === 'string';
      if (validLegacy && pidGone(legacy!.pid as number)) return null;
      throw new Error('core discovery record is unreadable');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  /** The discovery of the running core, or null; a refused connection is no core. */
  const running = async <T>(use: (discovery: DaemonDiscovery) => Promise<T>): Promise<T | null> => {
    const discovery = await discover();
    if (!discovery) return null;
    try {
      return await use(discovery);
    } catch (error) {
      // A refused connection is no core only when its process is gone too; a live
      // pid that does not answer is unknown work, which the caller must not treat as idle.
      if (REFUSED_CONNECTION.has((error as NodeJS.ErrnoException).code ?? '') && pidGone(discovery.pid)) return null;
      throw error;
    }
  };
  return {
    status: () =>
      running(async (discovery) => ({ status: statusOf(await call(discovery, 'GET', '/mgmt/status')), discovery })),
    async hold(on) {
      await running((discovery) => call(discovery, 'POST', '/mgmt/hold', { on }));
    },
    async stop(mode, confirmToken) {
      await running((discovery) =>
        call(discovery, 'POST', '/mgmt/stop', { mode, reason: 'update', ...(confirmToken ? { confirmToken } : {}) })
      );
    },
    async cancelDrain(drainId) {
      await running((discovery) => call(discovery, 'POST', '/mgmt/cancelDrain', { drainId }));
    },
  };
}

/** What the updater controller needs from the core. */
export interface CoreUpdateGate {
  /** Units of work running now; 0 when idle or no core runs. */
  running(): Promise<number>;
  /** Hold new work and report what runs in one step: 0 = idle (hold stays on
   *  until the core stops or `release`), a count = busy (hold released again). */
  hold(): Promise<number>;
  /** Undo a hold, and a wind-down that has not reached its release. */
  release(): Promise<void>;
  /** Wind the core down for the update and wait for its process to exit. With
   *  `abort`, the user confirmed the running work they were shown. */
  stop(options: { abort: boolean }): Promise<void>;
}

export interface CoreUpdateGateDeps {
  control?: CoreControl;
  /** Resolves once the OS reports the core process (pid + start time) gone. */
  waitExit: (core: { pid: number; processStartTime: string }) => Promise<void>;
}

/** `mixdogd ctl wait-exit`: the OS reports the exit through a process handle opened on the pid and its start
 *  time, so a reused pid is never waited on. */
export function ctlWaitExit(mixdogd: string): CoreUpdateGateDeps['waitExit'] {
  return ({ pid, processStartTime }) =>
    new Promise((resolve, reject) => {
      execFile(
        mixdogd,
        ['ctl', 'wait-exit', '--pid', String(pid), '--start-time', processStartTime],
        (error, _out, stderr) =>
          error ? reject(new Error(`mixdogd ctl wait-exit failed: ${stderr.trim() || error.message}`)) : resolve()
      );
    });
}

export function createCoreUpdateGate(deps: CoreUpdateGateDeps): CoreUpdateGate {
  const control = deps.control ?? createCoreControl();
  const gate: CoreUpdateGate = {
    async running() {
      return (await control.status())?.status.running.length ?? 0;
    },
    async hold() {
      await control.hold(true);
      const count = await gate.running();
      if (count > 0) await control.hold(false);
      return count;
    },
    async release() {
      const current = await control.status();
      const drain = current?.status.drain;
      if (drain && !drain.releasing) await control.cancelDrain(drain.drainId);
      await control.hold(false);
    },
    async stop({ abort }) {
      const before = await control.status();
      if (!before) return;
      await control.stop('whenIdle');
      if (abort) {
        const draining = await control.status();
        if (draining?.status.drain && draining.status.running.length > 0) {
          await control.stop('abortConfirmed', draining.status.drain.confirmToken);
        }
      }
      // Exit is an OS event, not a core claim: the installer may replace the
      // binary only once the process is gone.
      await deps.waitExit(before.discovery);
    },
  };
  return gate;
}
