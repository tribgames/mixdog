/**
 * The desktop quit, ordered so it feels instant: every window disappears
 * first, then teardown (service detach, an in-tree daemon's stop and the
 * PostgreSQL it started) runs in the still-running main process, and the app
 * exits once it settles. A launch that arrives while that teardown runs is
 * not lost: the old instance still holds the single-instance lock, so it
 * relaunches the app on its way out instead of reviving a quitting window.
 */

import { IN_TREE_DAEMON_STOP_GRACE_MS } from '../../../../src/standalone/daemon-stop-budget.mjs';

/** Bound on waiting for a daemon in this app's process tree to exit after its
 *  forced stop. A healthy daemon shutdown (PostgreSQL stop included) measures
 *  ~0.6 s; past this the app exits and the daemon dies with it. The daemon
 *  times its forced PostgreSQL stop from the same constant. Windows are
 *  already hidden, so a longer wait only delays the invisible process exit. */
export const DESKTOP_DAEMON_STOP_TIMEOUT_MS = IN_TREE_DAEMON_STOP_GRACE_MS;

export interface QuitWindow {
  isDestroyed(): boolean;
  hide(): void;
}

export interface DesktopQuitSequenceOptions {
  windows(): readonly QuitWindow[];
  teardown(): Promise<void>;
  /** Let the quit proceed for real (the next before-quit is not intercepted). */
  exit(): void;
  /** Start a fresh instance once this one exits (Electron app.relaunch). */
  relaunch(): void;
  onError?(error: unknown): void;
}

export interface DesktopQuitSequence {
  readonly quitting: boolean;
  /** Hide every window now, then tear down and exit. Idempotent. */
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
      running = Promise.resolve()
        .then(() => options.teardown())
        .catch((error: unknown) => options.onError?.(error))
        .finally(() => options.exit());
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
