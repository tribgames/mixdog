import { createConnection, createServer } from 'node:net';
import type { ChildProcess } from 'node:child_process';

import { listenOnFetchSafePort } from '../../../../../src/runtime/shared/fetch-safe-listen.mjs';
import {
  classifySshFailure,
  isLocalForwardBindFailure,
  SshError,
  sshTunnelArgs,
  stderrTail,
  TunnelBackoff,
  type SshTarget,
} from './ssh-command';
import { defaultSshSpawn, killWithProcess, type SshSpawn } from './ssh-exec';

/** A tunnel that never accepts a connection is killed (and restarted). */
const TUNNEL_READY_DEADLINE_MS = 40_000;
const TUNNEL_READY_POLL_MS = 150;
const STDERR_KEEP_BYTES = 16 * 1024;

export interface TunnelDependencies {
  spawnImpl?: SshSpawn;
  /** Resolves true once something accepts connections on 127.0.0.1:port. */
  portAccepts?: (port: number) => Promise<boolean>;
  freePort?: () => Promise<number>;
  backoff?: TunnelBackoff;
  readyDeadlineMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Restart a child that exited on its own (the host's auto-reconnect);
   *  off, only revive()/restartNow() start one again. */
  autoRestart?: boolean;
}

export function localPortAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    // The port is opened in the user's browser (forwarded ports), which refuses blocked ports.
    listenOnFetchSafePort(server, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free local port'))));
    });
  });
}

interface Waiter {
  resolve(port: number): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * One supervised `ssh -N -L` child. It keeps the same local port across
 * restarts, so an attached client's stream simply reconnects through the
 * new child; restarts follow TUNNEL_BACKOFF_SECONDS; a changed host key or a
 * refused login stops supervision for good.
 */
export class SshTunnel {
  private readonly spawnImpl: SshSpawn;
  private readonly portAccepts: (port: number) => Promise<boolean>;
  private readonly freePort: () => Promise<number>;
  private readonly backoff: TunnelBackoff;
  private readonly readyDeadlineMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly autoRestart: boolean;
  private child: ChildProcess | null = null;
  private generation = 0;
  private remotePort = 0;
  private localPort = 0;
  private readyAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private terminalError: SshError | null = null;
  private closed = false;
  private readonly waiters = new Set<Waiter>();

  constructor(
    private readonly target: SshTarget,
    dependencies: TunnelDependencies = {}
  ) {
    this.spawnImpl = dependencies.spawnImpl ?? defaultSshSpawn;
    this.portAccepts = dependencies.portAccepts ?? localPortAccepts;
    this.freePort = dependencies.freePort ?? freeLocalPort;
    this.backoff = dependencies.backoff ?? new TunnelBackoff();
    this.readyDeadlineMs = dependencies.readyDeadlineMs ?? TUNNEL_READY_DEADLINE_MS;
    this.now = dependencies.now ?? Date.now;
    this.log = dependencies.log ?? (() => {});
    this.autoRestart = dependencies.autoRestart !== false;
  }

  get failure(): SshError | null {
    return this.terminalError;
  }

  /** Local port forwarding to 127.0.0.1:`remotePort` on the server, once
   *  ready. Waits through supervised restarts up to `timeoutMs`. */
  ensure(remotePort: number, timeoutMs: number): Promise<number> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closed) return Promise.reject(new Error('The ssh tunnel is closed.'));
    if (remotePort !== this.remotePort) {
      // The daemon moved: forward to its new port from scratch.
      this.remotePort = remotePort;
      this.backoff.reset();
      this.stopChild();
      this.clearRestart();
      void this.start();
    } else if (this.readyAt && this.child) {
      return Promise.resolve(this.localPort);
    } else if (!this.child && !this.restartTimer) {
      void this.start();
    }
    return new Promise<number>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(
            new SshError(`The ssh tunnel to ${this.target.display} is not ready after ${timeoutMs} ms.`, 'transient')
          );
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  /** The local port in use (0 before the first is chosen); it changes only
   *  when a restart finds it taken. */
  get boundPort(): number {
    return this.localPort;
  }

  /** A child is running and has accepted connections. */
  get alive(): boolean {
    return Boolean(this.child && this.readyAt);
  }

  /** Replaces the ssh child now, with a fresh backoff: for a link whose
   *  health probes keep failing although the child has not exited. */
  restartNow(): void {
    if (this.closed || this.terminalError || !this.remotePort) return;
    this.backoff.reset();
    this.clearRestart();
    this.stopChild();
    this.log('ssh tunnel restarting now (health probes failed)');
    void this.start();
  }

  /** Starts a child now when none runs (one waiting out its restart delay);
   *  a running child is left alone. */
  revive(): void {
    if (this.closed || this.terminalError || !this.remotePort || this.child) return;
    this.backoff.reset();
    this.clearRestart();
    void this.start();
  }

  close(): Promise<void> {
    this.closed = true;
    this.clearRestart();
    this.settleWaiters(new Error('The ssh tunnel is closed.'));
    const child = this.child;
    this.stopChild();
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => child.once('exit', () => resolve()));
  }

  private settleWaiters(error: Error | null): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error);
      else waiter.resolve(this.localPort);
    }
    this.waiters.clear();
  }

  private clearRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /** Stop the current child on purpose: its exit is not a failure. */
  private stopChild(): void {
    const child = this.child;
    this.child = null;
    this.readyAt = 0;
    this.generation += 1;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }

  private async start(): Promise<void> {
    const generation = ++this.generation;
    if (!this.localPort) {
      try {
        this.localPort = await this.freePort();
      } catch (error) {
        this.onExit(generation, '', `no free local port: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    if (generation !== this.generation || this.closed) return;
    const args = sshTunnelArgs(this.target, this.localPort, this.remotePort);
    let child: ChildProcess;
    try {
      child = this.spawnImpl('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this.fatal(
        new SshError(`Could not start ssh: ${error instanceof Error ? error.message : String(error)}`, 'terminal')
      );
      return;
    }
    this.child = child;
    const release = killWithProcess(child);
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP_BYTES);
    });
    child.stdout?.resume();
    this.log(`ssh tunnel starting 127.0.0.1:${this.localPort} -> ${this.target.display}:127.0.0.1:${this.remotePort}`);
    const hardKill = setTimeout(() => {
      if (generation === this.generation && !this.readyAt) {
        stderr += `\nssh tunnel did not accept connections within ${this.readyDeadlineMs} ms`;
        child.kill();
      }
    }, this.readyDeadlineMs);
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        this.fatal(new SshError('The OpenSSH client (ssh) was not found on PATH.', 'terminal'));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(hardKill);
      release();
      this.onExit(generation, stderr, signal ? `ssh exited on ${signal}` : `ssh exited with status ${code}`);
    });
    void this.awaitReady(generation, child);
  }

  private async awaitReady(generation: number, child: ChildProcess): Promise<void> {
    while (generation === this.generation && child.exitCode === null && child.signalCode === null) {
      if (await this.portAccepts(this.localPort)) {
        if (generation !== this.generation || child.exitCode !== null) return;
        this.readyAt = this.now();
        this.log(`ssh tunnel ready on 127.0.0.1:${this.localPort}`);
        this.settleWaiters(null);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, TUNNEL_READY_POLL_MS));
    }
  }

  private fatal(error: SshError): void {
    this.terminalError = error;
    this.clearRestart();
    this.stopChild();
    this.log(`ssh tunnel stopped: ${error.message}`);
    this.settleWaiters(error);
  }

  private onExit(generation: number, stderr: string, status: string): void {
    if (generation !== this.generation || this.closed || this.terminalError) return;
    const healthyFor = this.readyAt ? this.now() - this.readyAt : 0;
    this.child = null;
    this.readyAt = 0;
    const tail = stderrTail(stderr);
    if (classifySshFailure(stderr) === 'terminal') {
      this.fatal(new SshError(`ssh tunnel to ${this.target.display} failed:\n${tail || status}`, 'terminal', tail));
      return;
    }
    if (isLocalForwardBindFailure(stderr)) this.localPort = 0;
    if (!this.autoRestart && healthyFor > 0) {
      // A link that was up dropped: the host does not redial on its own.
      this.log(`ssh tunnel exited (${status}); automatic reconnection is off`);
      return;
    }
    const delay = this.backoff.next(healthyFor);
    this.log(
      `ssh tunnel exited (${status}); restarting in ${delay} ms${tail ? `: ${tail.replace(/\n/g, ' | ')}` : ''}`
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, delay);
  }
}
