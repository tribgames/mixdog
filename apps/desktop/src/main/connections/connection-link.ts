// The state a server window shows for its link to the daemon, and the probe
// loop behind it. The tunnel and the service client each recover on their own;
// this owns what the user sees (connected, reconnecting with the attempt and
// its countdown, lost, paused for sleep) and nudges both layers so an attempt
// really happens when the countdown says so.
import type { DesktopConnectionLinkState, DesktopConnectionLinkView } from '../../shared/contract-connection-link';
import type { DesktopSshModelLogin } from '../../shared/contract-ssh';

/** App-level health probe through the tunnel while connected. */
export const LINK_HEALTH_INTERVAL_MS = 15_000;
export const LINK_PROBE_TIMEOUT_MS = 5_000;
/** This many failed probes inside the window replace the tunnel's ssh child. */
export const LINK_FAILURE_LIMIT = 3;
export const LINK_FAILURE_WINDOW_MS = 60_000;
/** A link that stayed healthy this long starts its backoff over. */
export const LINK_STABLE_RESET_MS = 60_000;
/** After sleep the link is probed this many times before it is called dead. */
export const RESUME_PROBE_ATTEMPTS = 2;
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
/** How long the server keeps an idle daemon for a remote client that went
 *  away, when MIXDOG_REMOTE_CLIENT_GRACE_MS is not set (the server default). */
export const REMOTE_CLIENT_GRACE_DEFAULT_MS = 1_800_000;
/** Attempts that must still fit inside the grace window at the longest delay. */
const ATTEMPTS_INSIDE_GRACE = 6;

/** The grace the server applies: the configured value, or its default. */
export function remoteClientGraceMs(configured: string | undefined): number {
  const value = Number(configured);
  return configured?.trim() && Number.isFinite(value) && value >= 0 ? value : REMOTE_CLIENT_GRACE_DEFAULT_MS;
}

/** A host's own grace setting (minutes) in ms; null when it has none, so
 *  the server's configured or default grace applies. */
export function hostGraceMs(graceMinutes: unknown): number | null {
  return typeof graceMinutes === 'number' && Number.isFinite(graceMinutes) && graceMinutes > 0
    ? Math.round(graceMinutes * 60_000)
    : null;
}

/** The longest wait between attempts: capped, and short enough that several
 *  attempts land while the server still keeps the daemon for this client. */
export function reconnectDelayCapMs(graceMs: number): number {
  return Math.max(
    RECONNECT_BASE_DELAY_MS,
    Math.min(RECONNECT_MAX_DELAY_MS, Math.floor(graceMs / ATTEMPTS_INSIDE_GRACE))
  );
}

/** Exponential delays up to the cap; the ladder starts over once the link
 *  stayed healthy for LINK_STABLE_RESET_MS. */
export class ReconnectLadder {
  private attempt = 0;
  private healthySince = 0;

  constructor(
    readonly capMs: number,
    private readonly stableMs = LINK_STABLE_RESET_MS
  ) {}

  next(now: number): { attempt: number; delayMs: number } {
    if (this.healthySince && now - this.healthySince >= this.stableMs) this.attempt = 0;
    this.healthySince = 0;
    this.attempt += 1;
    const delayMs = Math.min(this.capMs, RECONNECT_BASE_DELAY_MS * 2 ** Math.min(this.attempt - 1, 16));
    return { attempt: this.attempt, delayMs };
  }

  markHealthy(now: number): void {
    if (!this.healthySince) this.healthySince = now;
  }

  reset(): void {
    this.attempt = 0;
    this.healthySince = 0;
  }
}

export interface LinkTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemTimers: LinkTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface ConnectionLinkActions {
  /** One /health round trip through the tunnel: ms, or null when it failed. */
  probe(timeoutMs: number): Promise<number | null>;
  /** Replace the tunnel's ssh child now, with a fresh backoff. */
  resetTunnel(): void;
  /** Start the tunnel's ssh child now if none runs; a live one stays. */
  reviveTunnel(): void;
  /** Have the service client attach now instead of waiting out its delay. */
  retryService(): void;
  /** The failure that stopped the ssh side for good (a changed host key, a
   *  refused login), noticed by the tunnel before any transport saw it. */
  stoppedBy(): LinkFailure | null;
  /** Automatic reconnection is off: refuse dials until release(). */
  hold(): void;
  /** The user reconnects: dials are allowed again. */
  release(): void;
}

export interface LinkFailure {
  code: string;
  message: string;
  settingsRequired?: boolean;
}

export interface ConnectionLinkOptions {
  connectionId: string;
  actions: ConnectionLinkActions;
  graceMs: number;
  /** The host's setting; false: a drop goes straight to lost, and only the
   *  user's Reconnect dials again. */
  autoReconnect?: boolean;
  /** Whose provider logins the server's models run on; 'pc' by default. */
  modelLogin?: DesktopSshModelLogin;
  timers?: LinkTimers;
}

const AUTO_RECONNECT_OFF: LinkFailure = {
  code: 'auto-reconnect-off',
  message: 'Automatic reconnection is off for this server.',
};

export class ConnectionLink {
  readonly ladder: ReconnectLadder;
  private readonly timers: LinkTimers;
  private readonly listeners = new Set<(view: DesktopConnectionLinkView) => void>();
  private state: DesktopConnectionLinkState = { status: 'connected' };
  private started = false;
  private disposed = false;
  private paused = false;
  /** The service lost its stream/transport and has not re-attached yet. */
  private serviceDown = false;
  /** Health probes failed often enough that the tunnel was replaced. */
  private linkDown = false;
  private downSince = 0;
  private failures: number[] = [];
  private rttMs: number | null = null;
  private terminals = true;
  private modelLogin: DesktopSshModelLogin;
  private attemptTimer: unknown = null;
  private healthTimer: unknown = null;
  private probing = false;

  constructor(private readonly options: ConnectionLinkOptions) {
    this.timers = options.timers ?? systemTimers;
    this.ladder = new ReconnectLadder(reconnectDelayCapMs(options.graceMs));
    this.modelLogin = options.modelLogin ?? 'pc';
  }

  view(): DesktopConnectionLinkView {
    return {
      connectionId: this.options.connectionId,
      state: this.state,
      rttMs: this.rttMs,
      terminalsAvailable: this.terminals,
      modelLogin: this.modelLogin,
    };
  }

  setModelLogin(modelLogin: DesktopSshModelLogin): void {
    if (this.modelLogin === modelLogin) return;
    this.modelLogin = modelLogin;
    this.emit();
  }

  subscribe(listener: (view: DesktopConnectionLinkView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The first attachment is up: probing starts. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.ladder.markHealthy(this.timers.now());
    this.healthTimer = this.timers.setInterval(() => void this.healthTick(), LINK_HEALTH_INTERVAL_MS);
    this.emit();
  }

  setTerminalsAvailable(available: boolean): void {
    if (this.terminals === available) return;
    this.terminals = available;
    this.emit();
  }

  /** The service's stream or transport dropped. */
  serviceLost(): void {
    if (!this.started || this.disposed) return;
    this.serviceDown = true;
    this.goDown();
  }

  /** The service attached again (stream back, transport ready, daemon replaced). */
  serviceRestored(): void {
    if (!this.started || this.disposed) return;
    this.serviceDown = false;
    this.linkDown = false;
    this.goUp();
  }

  /** A failure no retry fixes stopped the connection. */
  terminal(failure: LinkFailure): void {
    if (this.disposed) return;
    this.clearAttempt();
    this.serviceDown = true;
    this.setState({
      status: 'lost',
      terminal: true,
      code: failure.code,
      message: failure.message,
      ...(failure.settingsRequired ? { settingsRequired: true } : {}),
    });
  }

  /** The connection was opened again after a terminal failure. */
  reopening(): void {
    if (this.disposed) return;
    this.clearAttempt();
    this.ladder.reset();
    this.serviceDown = true;
    this.downSince = this.timers.now();
    this.setState({ status: 'reconnecting', attempt: 1, nextRetryAt: null });
  }

  /** The user asked to reconnect now (a non-terminal loss or a long wait). */
  retry(): void {
    if (this.disposed || this.paused || !this.isDown()) return;
    this.options.actions.release();
    this.clearAttempt();
    this.ladder.reset();
    this.downSince = this.timers.now();
    void this.runAttempt(1);
  }

  /** The user skips the countdown: the scheduled attempt runs now. The ladder
   *  keeps its count and the outage keeps its start, so a failed attempt
   *  schedules the next step exactly as the timer would have. */
  attemptNow(): void {
    if (this.disposed || this.paused || this.state.status !== 'reconnecting' || !this.attemptTimer) return;
    const { attempt } = this.state;
    this.clearAttempt();
    void this.runAttempt(attempt);
  }

  /** This PC goes to sleep: not a failure, nothing is attempted. */
  suspend(): void {
    if (!this.started || this.disposed || this.paused) return;
    this.paused = true;
    this.clearAttempt();
    if (this.isTerminal()) return;
    this.setState({ status: 'paused' });
  }

  /** This PC woke up: probe the link before touching it. A live link stays as
   *  it is; a dead one gets a new ssh child and a fresh backoff. */
  async resume(): Promise<void> {
    if (!this.started || this.disposed || !this.paused) return;
    this.paused = false;
    this.ladder.reset();
    this.failures = [];
    if (this.isTerminal()) return;
    let rtt: number | null = null;
    for (let attempt = 0; attempt < RESUME_PROBE_ATTEMPTS && rtt === null; attempt += 1) {
      rtt = await this.options.actions.probe(LINK_PROBE_TIMEOUT_MS);
      if (this.disposed || this.paused) return;
    }
    if (rtt !== null) {
      this.rttMs = rtt;
      this.linkDown = false;
      if (this.serviceDown) {
        this.options.actions.retryService();
        this.goDown();
      } else {
        this.goUp(true);
      }
      return;
    }
    if (this.autoReconnect) this.options.actions.resetTunnel();
    this.linkDown = true;
    this.downSince = 0;
    this.goDown();
  }

  private get autoReconnect(): boolean {
    return this.options.autoReconnect !== false;
  }

  dispose(): void {
    this.disposed = true;
    this.clearAttempt();
    if (this.healthTimer) this.timers.clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.listeners.clear();
  }

  private isDown(): boolean {
    return this.state.status === 'reconnecting' || this.state.status === 'lost';
  }

  private isTerminal(): boolean {
    return this.state.status === 'lost' && this.state.terminal;
  }

  private goDown(): void {
    if (this.paused || this.isTerminal()) return;
    if (!this.isDown()) this.downSince = this.timers.now();
    if (this.state.status === 'lost' || this.attemptTimer) return;
    this.scheduleAttempt();
  }

  private goUp(force = false): void {
    if (this.paused || this.serviceDown || this.linkDown) return;
    if (this.isTerminal() && !force) return;
    this.clearAttempt();
    this.downSince = 0;
    this.ladder.markHealthy(this.timers.now());
    this.setState({ status: 'connected' });
  }

  private scheduleAttempt(): void {
    if (!this.autoReconnect) {
      this.options.actions.hold();
      this.setState({ status: 'lost', terminal: false, ...AUTO_RECONNECT_OFF });
      return;
    }
    const now = this.timers.now();
    if (this.downSince && now - this.downSince >= this.options.graceMs) {
      // Past the server's grace the daemon may have let this client go: stop
      // counting down and leave the next step to the user.
      this.setState({
        status: 'lost',
        terminal: false,
        code: 'unreachable',
        message: 'The server stayed unreachable longer than it keeps a session for this PC.',
      });
      return;
    }
    const { attempt, delayMs } = this.ladder.next(now);
    this.setState({ status: 'reconnecting', attempt, nextRetryAt: now + delayMs });
    this.attemptTimer = this.timers.setTimeout(() => {
      this.attemptTimer = null;
      void this.runAttempt(attempt);
    }, delayMs);
  }

  private async runAttempt(attempt: number): Promise<void> {
    if (this.disposed || this.paused) return;
    this.setState({ status: 'reconnecting', attempt, nextRetryAt: null });
    const rtt = await this.options.actions.probe(LINK_PROBE_TIMEOUT_MS);
    if (this.disposed || this.paused || !this.isDown() || this.isTerminal()) return;
    if (rtt !== null) {
      this.rttMs = rtt;
      this.linkDown = false;
      if (this.serviceDown) this.options.actions.retryService();
      else {
        this.goUp();
        return;
      }
    } else {
      const stopped = this.options.actions.stoppedBy();
      if (stopped) {
        this.terminal(stopped);
        return;
      }
      this.options.actions.reviveTunnel();
      if (!this.autoReconnect) {
        // The user's one attempt: its outcome comes from the service
        // (attached again, or dropped once more and lost).
        this.options.actions.retryService();
        return;
      }
    }
    if (!this.attemptTimer && this.isDown()) this.scheduleAttempt();
  }

  private async healthTick(): Promise<void> {
    if (this.disposed || this.paused || this.probing || this.state.status !== 'connected') return;
    this.probing = true;
    let rtt: number | null;
    try {
      rtt = await this.options.actions.probe(LINK_PROBE_TIMEOUT_MS);
    } finally {
      this.probing = false;
    }
    if (this.disposed || this.paused) return;
    const now = this.timers.now();
    if (rtt !== null) {
      this.rttMs = rtt;
      this.emit();
      return;
    }
    this.failures = [...this.failures.filter((at) => now - at < LINK_FAILURE_WINDOW_MS), now];
    if (this.failures.length < LINK_FAILURE_LIMIT) return;
    this.failures = [];
    if (this.autoReconnect) this.options.actions.resetTunnel();
    this.linkDown = true;
    this.goDown();
  }

  private clearAttempt(): void {
    if (this.attemptTimer) this.timers.clearTimeout(this.attemptTimer);
    this.attemptTimer = null;
  }

  private setState(state: DesktopConnectionLinkState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    if (!this.started || this.disposed) return;
    const view = this.view();
    for (const listener of this.listeners) listener(view);
  }
}
