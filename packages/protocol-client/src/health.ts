// The connection's health: the one state machine that decides a silent connection is dead. A request that has been sent stays
// pending for as long as the core is demonstrably alive, so the only way a pending request fails is that this machine drops the link
// (the engine's recovery then settles each request: `connectionLost`, or for a mutation the reconciliation that never runs it twice).
//
// Proof of life is new, authenticated receive progress from the core, counted as it arrives (`progress`): a completed message, or
// the transport's report that more of one has arrived and is not complete yet (a multi-megabyte response on a slow link is alive
// for as long as its fragments keep coming, and a probe's answer cannot overtake it). A transport's own keepalive (a relay's pong),
// an acknowledgement, bytes that did not authenticate, a replayed record and anything a past connection reports are not progress:
// transports report facts, and only this machine holds the policy. A transport that cannot report progress before a message is
// whole (a plain WebSocket opened by a page) gives silence the meaning "no complete message", which on a link that carries a message
// larger than the observation window is an assumption, not proof; the desktop's sockets are observed where they are owned.
//
// The cycle: idle -> a probe is sent (a question the core answers at once) -> once the probe has actually left (the transport's receipt of local departure, `SentClaim`; no receipt is no window and no verdict, never a silent core), an observation
// window of `windowMs` -> the window ends: let the receive work the transport already accepted settle, recheck progress and the
// connection, and only then drop. Progress at any moment ends the cycle and clears the suspicion. Time alone is never enough: the
// timer notices when it fired later than it was due by more than the gap policy (a suspended page or machine, a stalled scheduler),
// and then the cycle is void and a fresh one begins, because the window is valid only if the client could receive during it. A
// tick count never decides anything. One timer exists at a time (the heartbeat while requests are pending, the window while a probe
// is out) and none while nothing waits.
//
// Accepted limit: other traffic keeps the connection alive while one request stays pending, so a request the core never answers on a
// healthy connection waits until the caller leaves it.
import type { SentClaim } from './api.ts';

export interface HealthOptions {
  /** The heartbeat while requests are pending: how often a quiet connection is looked at. */
  readonly intervalMs?: number;
  /** The observation window after a probe has left. */
  readonly windowMs?: number;
  /** How much later than due a timer may fire before the machine takes the client to have been suspended. */
  readonly gapMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** What the machine needs of the engine. */
export interface HealthHost {
  /** A connection is up and can send and receive. */
  ready(): boolean;
  /** Requests waiting for their answer, the machine's own probes excluded. */
  pending(): number;
  /** The connection generation: a past connection's callbacks and cycles never act. */
  connection(): number;
  /** Sends the probe. `sent` receives the departure receipt (`SentClaim`); a transport that cannot give one never calls it, and no window opens. */
  probe(sent: SentClaim): void;
  /** Settles when the receive work the transport has already accepted (authentication, assembly) has been processed. */
  settle(): Promise<void>;
  /** Ends this connection from this side. */
  drop(reason: string): void;
  diag(event: string, fields: Record<string, unknown>): void;
}

interface Cycle {
  readonly id: number;
  readonly connection: number;
  /** The probe has left and the observation window runs: the progress count when it began, and when. */
  progress0?: number;
  startedAt?: number;
}

export const DEFAULT_HEALTH_INTERVAL_MS = 15_000;
export const DEFAULT_HEALTH_WINDOW_MS = 15_000;
/** The gap a timer may be late by before the client is taken to have been suspended; the one policy of the window's wake check. */
export const SCHEDULING_GAP_MS = 20_000;

export class LinkHealth {
  private readonly intervalMs: number;
  private readonly windowMs: number;
  private readonly gapMs: number;
  private readonly clock: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: unknown;
  /** When the armed timer is due, on `clock`. */
  private dueAt = 0;
  private progressCount = 0;
  /** The progress count at the last heartbeat. */
  private seen = 0;
  private cycle: Cycle | null = null;
  private cycles = 0;
  private waiters: Array<(alive: boolean) => void> = [];

  private readonly host: HealthHost;

  constructor(host: HealthHost, options: HealthOptions = {}) {
    this.host = host;
    this.intervalMs = options.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.windowMs = options.windowMs ?? DEFAULT_HEALTH_WINDOW_MS;
    this.gapMs = options.gapMs ?? SCHEDULING_GAP_MS;
    this.clock = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((run, ms) => {
        const handle = setTimeout(run, ms);
        // Looking never keeps a process alive (a page has no such handle).
        (handle as unknown as { unref?: () => void }).unref?.();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** New authenticated receive progress from the core on the current connection (the engine routes it through its generation guard). */
  progress(): void {
    this.progressCount++;
    if (this.cycle?.progress0 !== undefined) this.clear(true);
  }

  /** Requests are pending (a request was sent or answered): watch while any is, and stop watching when none is. */
  requestsChanged(): void {
    if (this.host.pending() > 0) {
      if (this.timer === undefined && this.cycle === null && this.host.ready()) {
        this.seen = this.progressCount;
        this.arm();
      }
    } else if (this.waiters.length === 0) {
      this.rest();
    }
  }

  /** Asks now whether the core is alive (a wake, a network change): any state of a past cycle is void and a fresh probe and window
   *  begin. Resolves with the machine's own verdict: `true` once progress was observed, `false` if the link was dropped or none was up. */
  check(): Promise<boolean> {
    if (!this.host.ready()) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.waiters.push(resolve);
      this.begin();
    });
  }

  /** The connection ended or the client closed: nothing is watched, and whoever asked is told the link is not alive. */
  stop(): void {
    this.rest();
    for (const resolve of this.waiters.splice(0)) resolve(false);
  }

  private rest(): void {
    this.cancel();
    this.cycle = null;
  }

  private cancel(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.cancel();
    this.dueAt = this.clock() + this.intervalMs;
    this.timer = this.setTimer(() => this.heartbeat(), this.intervalMs);
  }

  /** Progress ended the suspicion, or a check was answered. */
  private clear(alive: boolean): void {
    this.cycle = null;
    this.cancel();
    if (alive) for (const resolve of this.waiters.splice(0)) resolve(true);
    this.seen = this.progressCount;
    if (this.host.pending() > 0) this.arm();
  }

  private heartbeat(): void {
    this.timer = undefined;
    if (!this.host.ready()) return this.stop();
    if (this.host.pending() <= 0 && this.waiters.length === 0) return this.rest();
    if (this.clock() - this.dueAt > this.gapMs) {
      // The timer was held back far past its due time: whatever it was measuring is void.
      this.cycle = null;
      this.seen = this.progressCount;
      return this.arm();
    }
    // A probe that has not left yet is no silence to judge.
    if (this.cycle) return this.arm();
    if (this.progressCount !== this.seen) {
      this.seen = this.progressCount;
      return this.arm();
    }
    this.begin();
  }

  /** A fresh cycle: the probe goes out; the window opens when it has actually left. */
  private begin(): void {
    this.cancel();
    const id = ++this.cycles;
    this.cycle = { id, connection: this.host.connection() };
    // Only the transport's own receipt that this probe completed local departure opens the window. No receipt (the transport cannot
    // give one, or it has not come) is no window and no verdict, never a silent core; a refused write ends the cycle so the heartbeat
    // sends another probe, and the transport reports an explicit loss itself.
    let claimed = false;
    this.host.probe((sent) => {
      if (claimed) return;
      claimed = true;
      sent.then(
        () => this.left(id),
        () => {
          if (this.cycle?.id === id && this.cycle.progress0 === undefined) this.cycle = null;
        }
      );
    });
    // While the probe has not left, the heartbeat keeps the machine awake; a probe that is stuck is not proof of anything.
    if (this.cycle?.id === id && this.cycle.progress0 === undefined) this.arm();
  }

  private left(id: number): void {
    const cycle = this.cycle;
    if (!cycle || cycle.id !== id || cycle.connection !== this.host.connection() || cycle.progress0 !== undefined) return;
    cycle.progress0 = this.progressCount;
    cycle.startedAt = this.clock();
    this.cancel();
    this.dueAt = cycle.startedAt + this.windowMs;
    this.timer = this.setTimer(() => this.windowEnded(id), this.windowMs);
  }

  private windowEnded(id: number): void {
    this.timer = undefined;
    const cycle = this.cycle;
    if (!cycle || cycle.id !== id) return;
    const at = this.clock();
    if (at - this.dueAt > this.gapMs) return this.begin();
    void this.decide(cycle, at);
  }

  private async decide(cycle: Cycle, startedAt: number): Promise<void> {
    // Receive work the transport has already accepted may hold the very message that proves life: let it settle first.
    await this.host.settle();
    if (this.cycle !== cycle || cycle.connection !== this.host.connection() || !this.host.ready()) return;
    if (this.progressCount !== cycle.progress0) return this.clear(true);
    // Suspended while settling: the window is not a valid one.
    if (this.clock() - startedAt > this.gapMs) return this.begin();
    if (this.host.pending() <= 0 && this.waiters.length === 0) return this.rest();
    this.host.diag('link-silent', { requestsPending: this.host.pending(), windowMs: this.windowMs });
    this.cycle = null;
    for (const resolve of this.waiters.splice(0)) resolve(false);
    this.host.drop('core silent');
  }
}
