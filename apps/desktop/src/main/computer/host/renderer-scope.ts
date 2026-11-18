/**
 * The scope endpoint of a renderer input operation in the desktop's own host (`input-dispatch.ts`): the endpoint of the command
 * it belongs to (`command-fence.ts`), its only scope source. `commit` admits each hand-over through the command's `commit` and the
 * run's abort in the turn it happens; the signal is the command's (it aborts at the scope's revocation), so the port lets go of a
 * press still awaiting a debugger reply then, not when the operation exits; each hand-over is counted by the command's `track`.
 *
 * The endpoint latches: once revoked (the command's signal aborted, its `commit` refused once, or `close` ran) it refuses for good,
 * before the command's endpoint is read again, so one kept across Off and On stays refused; On again serves only a new one.
 */
import type { CommandEndpoint } from './command-fence';
import type { ScopeEndpoint } from './electron-input-port';

export function rendererScope(
  command: CommandEndpoint,
  action: string,
  assertRunnable: () => void
): { scope: ScopeEndpoint; close(): void } {
  const latched = new AbortController();
  const follow = (): void => latched.abort(command.signal.reason);
  if (command.signal.aborted) follow();
  else command.signal.addEventListener('abort', follow, { once: true });
  return {
    scope: {
      commit(): void {
        latched.signal.throwIfAborted();
        try {
          command.commit();
          assertRunnable();
        } catch (error) {
          latched.abort(error);
          throw error;
        }
      },
      signal: latched.signal,
      track: (reply) => command.track(reply),
    },
    close(): void {
      command.signal.removeEventListener('abort', follow);
      latched.abort(new Error(`the ${action} input endpoint is closed`));
    },
  };
}
