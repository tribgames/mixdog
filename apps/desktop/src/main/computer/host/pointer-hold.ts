/**
 * A foreground session keeps the system cursor blanked between its commands,
 * so the overlay arrow is the only pointer on screen while the agent thinks.
 * The hold ends when the arrow does: after the thinking grace, when the
 * user moves the mouse, when the session's turn ends, or when another session
 * takes the one physical pointer.
 * The worker's watchdog restores the cursor by itself on user input or worker
 * exit; this only ends holds nobody else would.
 */
import { DEFAULT_TARGET_LEASE_GRACE_MS } from '../session/coordinator';
import type { LifecycleContext } from './session-lifecycle';

export function createPointerHold(
  context: Pick<LifecycleContext, 'host' | 'coordinator' | 'execution'>,
  holdMs = DEFAULT_TARGET_LEASE_GRACE_MS
) {
  const { host, coordinator, execution } = context;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const drop = (sessionId: string): void => {
    const timer = timers.get(sessionId);
    if (timer) clearTimeout(timer);
    timers.delete(sessionId);
  };

  async function release(sessionId: string): Promise<void> {
    drop(sessionId);
    coordinator.releasePointer(sessionId);
    const child = host.powerShellBySession.get(sessionId);
    // Never start a worker just to release: a retired one already restored.
    if (!child || child.killed) return;
    try {
      await host.callPowerShell({ action: 'release_cursor_theme', session_id: sessionId, read_only: false });
    } catch {
      /* the watchdog restores the cursor when the worker cannot */
    }
  }

  // The overlay ends a hold when the user moves the mouse; a pause ends them all.
  const unsubscribe = coordinator.subscribe((snapshot) => {
    if (snapshot.userControlActive) {
      for (const sessionId of [...timers.keys()]) drop(sessionId);
      return;
    }
    for (const sessionId of snapshot.releasedPointerSessionIds ?? []) {
      if (timers.has(sessionId)) void release(sessionId);
    }
  });

  return {
    /** Before a session's foreground command: every other hold gives the pointer up. */
    async claim(sessionId: string): Promise<void> {
      drop(sessionId);
      await Promise.all([...timers.keys()].filter((held) => held !== sessionId).map(release));
    },
    /** After a session's foreground command, however it ended. */
    arm(sessionId: string): void {
      drop(sessionId);
      const timer = setTimeout(() => {
        timers.delete(sessionId);
        // A command running now re-arms the hold when it finishes.
        if (execution.activeExecutionsBySession.has(sessionId)) return;
        void release(sessionId);
      }, holdMs);
      timer.unref?.();
      timers.set(sessionId, timer);
    },
    /** The session's turn is over: a held pointer is the user's again at once. */
    async end(sessionId: string): Promise<void> {
      if (timers.has(sessionId)) await release(sessionId);
    },
    dispose(): void {
      unsubscribe();
      for (const sessionId of [...timers.keys()]) drop(sessionId);
    },
  };
}

export type PointerHold = ReturnType<typeof createPointerHold>;
