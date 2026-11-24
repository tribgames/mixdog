import { IN_TREE_DAEMON_STOP_GRACE_MS } from '../shared/core-src/standalone/daemon-stop-budget.mjs';
import { flushEditorBackups } from './editor-backup-flush';

/** A healthy daemon shutdown (PostgreSQL stop included) measures ~0.6 s. The daemon arms its forced PostgreSQL stop at
 *  this constant less the stop's signal margin (`daemon-stop-budget.mjs` PG_FORCED_STOP_AT_MS, mirrored by the core's
 *  `PG_FORCED_STOP_AT`); its release backstop is due only once every release step has had its own budget (`release_bound`). */
export const DESKTOP_DAEMON_STOP_TIMEOUT_MS = IN_TREE_DAEMON_STOP_GRACE_MS;

/** What a quit's stop of its core came to: the request (see `CoreStopRequest`), whether the core had exited when the wait
 *  ended, and the times. Written to the desktop diagnostics as `desktop-daemon-stop`, the line 1.4.5 wrote. */
export interface CoreStopOutcome {
  request: 'none' | 'not-ours' | 'sent' | 'refused' | 'unanswered';
  error: string | null;
  /** How long the request took to be answered. */
  requestMs: number;
  /** The core's process had ended when the wait did (or there was none to wait for). */
  exited: boolean;
  /** From the quit's stop beginning to the core's exit or the wait giving up. */
  elapsedMs: number;
  timeoutMs: number;
}

export interface CoreStopQuitOptions {
  request(timeoutMs: number): Promise<{ request: CoreStopOutcome['request']; error: string | null; elapsedMs: number }>;
  /** Resolves true once the core has exited, false after `remainingMs`. */
  exit(remainingMs: number): Promise<boolean>;
  record(outcome: CoreStopOutcome): void | Promise<void>;
  timeoutMs?: number;
  now?(): number;
}

/** The core's end at a quit, as 1.4.5's `stopInTreeDaemon` did it: ask it to stop with its running work aborted, wait for
 *  its own exit within `timeoutMs` (the request counts against it), and record what happened. The app exits after this,
 *  so a core that did not leave in time is the only one the app's exit still ends. */
export async function stopCoreForQuit(options: CoreStopQuitOptions): Promise<CoreStopOutcome> {
  const timeoutMs = options.timeoutMs ?? DESKTOP_DAEMON_STOP_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const began = now();
  const asked = await options.request(timeoutMs);
  const exited = await options.exit(Math.max(0, timeoutMs - (now() - began)));
  const outcome: CoreStopOutcome = {
    request: asked.request,
    error: asked.error,
    requestMs: asked.elapsedMs,
    exited,
    elapsedMs: now() - began,
    timeoutMs,
  };
  await options.record(outcome);
  return outcome;
}

export interface QuitWindow {
  isDestroyed(): boolean;
  hide(): void;
}

export interface DesktopQuitSequenceOptions {
  windows(): readonly QuitWindow[];
  /** Settles once every window has written its editors' pending backups (or is gone); the teardown that stops the core
   *  waits for it. Default: the windows joined to `flushEditorBackups`. */
  flushEditorBackups?(): Promise<void>;
  teardown(): Promise<void>;
  /** Let the quit proceed for real (the next before-quit is not intercepted). */
  exit(): void;
  /** Start a fresh instance once this one exits (Electron app.relaunch). */
  relaunch(): void;
  onError?(error: unknown): void;
  /** Bound on the backup flush and the whole teardown: past it the app exits anyway (`onTeardownTimeout` first), so a step
   *  that never settles cannot leave a quitting app running with its core and the single-instance lock held. None:
   *  unbounded. */
  teardownTimeoutMs?: number;
  onTeardownTimeout?(): void;
}

export interface DesktopQuitSequence {
  readonly quitting: boolean;
  /** Hide every window now, then flush the editor backups, tear down and exit. Idempotent. */
  begin(): Promise<void>;
  /** A second launch: false while running (activate as usual); during a
   *  quit it schedules a relaunch and returns true. */
  secondInstance(): boolean;
}

export function createDesktopQuitSequence(options: DesktopQuitSequenceOptions): DesktopQuitSequence {
  let running: Promise<void> | null = null;
  let relaunchRequested = false;
  return {
    get quitting() {
      return running !== null;
    },
    begin() {
      if (running) return running;
      for (const window of options.windows()) {
        try {
          if (!window.isDestroyed()) window.hide();
        } catch (error) {
          options.onError?.(error);
        }
      }
      const teardown = Promise.resolve()
        .then(() => (options.flushEditorBackups ?? flushEditorBackups)())
        .then(() => options.teardown())
        .catch((error: unknown) => options.onError?.(error));
      const bound = options.teardownTimeoutMs;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const deadline =
        bound === undefined
          ? null
          : new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                try {
                  options.onTeardownTimeout?.();
                } catch (error) {
                  options.onError?.(error);
                }
                resolve();
              }, bound);
            });
      running = (deadline ? Promise.race([teardown, deadline]) : teardown).finally(() => {
        if (timer) clearTimeout(timer);
        options.exit();
      });
      return running;
    },
    secondInstance() {
      if (!running) return false;
      if (!relaunchRequested) {
        relaunchRequested = true;
        options.relaunch();
      }
      return true;
    },
  };
}
