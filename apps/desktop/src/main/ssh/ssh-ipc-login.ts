// The interactive login of an SSH IPC operation: run it with BatchMode first, retry
// a refused login once through the askpass helper (which asks the user in the
// window), and tell the user about their ssh-agent when the login still fails.
import type { WebContents } from 'electron';

import type {
  DesktopSshAgentStatus,
  DesktopSshCleanupResult,
  DesktopSshConnectResult,
  DesktopSshFailure,
} from '../../shared/contract-ssh';
import { runTool } from './host-key';
import type { AskpassAsk, AskpassSession, startAskpassSession } from './ssh-auth';
import type { SshRunContext } from './ssh-context';
import { resolvePlainDir } from './ssh-private-dir';

type SshResult = DesktopSshConnectResult | DesktopSshCleanupResult;

export const cancelledResult = (): { ok: false; failure: DesktopSshFailure } => ({
  ok: false,
  failure: { kind: 'cancelled' },
});

const refusedLogin = (result: SshResult): boolean => !result.ok && result.failure.kind === 'auth';

export interface LoginRetryDeps {
  startAskpass: typeof startAskpassSession;
  askInWindow(sender: WebContents, attemptId: string, host: string): AskpassAsk;
  agentStatus(): Promise<DesktopSshAgentStatus>;
  userDataPath: string;
  platform: NodeJS.Platform;
}

/** Returns `runLogin(sender, id, host, base, run, isCancelled)`: `run` once with `base`, and again with the helper after a refused login. */
export function createLoginRetry(deps: LoginRetryDeps) {
  const { platform } = deps;

  async function withLoginRetry<T extends SshResult>(
    sender: WebContents,
    attemptId: string,
    host: string,
    base: SshRunContext,
    run: (context: SshRunContext) => Promise<T>,
    isCancelled: () => boolean
  ): Promise<T> {
    const first = await run(base);
    if (!refusedLogin(first) || isCancelled() || sender.isDestroyed()) return first;
    let session: AskpassSession;
    try {
      session = await deps.startAskpass({
        ask: deps.askInWindow(sender, attemptId, host),
        helperDir: await resolvePlainDir(runTool, deps.userDataPath, 'askpass', { platform }),
        run: runTool,
        platform,
      });
    } catch {
      return first;
    }
    try {
      const second = await run({ ...base, askpass: session });
      return session.cancelled && !second.ok ? (cancelledResult() as T) : second;
    } finally {
      await session.close();
    }
  }

  /** After the last try: tells the user what state their ssh-agent is in. */
  async function withAgent<T extends SshResult>(result: T): Promise<T> {
    if (result.ok || result.failure.kind !== 'auth') return result;
    const agent = await deps.agentStatus().catch(() => undefined);
    return (agent ? { ok: false, failure: { ...result.failure, agent } } : result) as T;
  }

  return async <T extends SshResult>(
    sender: WebContents,
    attemptId: string,
    host: string,
    base: SshRunContext,
    run: (context: SshRunContext) => Promise<T>,
    isCancelled: () => boolean
  ): Promise<T> => withAgent(await withLoginRetry(sender, attemptId, host, base, run, isCancelled));
}
