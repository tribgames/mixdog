/**
 * The host's direct operations on resident session workers, outside the
 * command path: releasing a sequence's held input, retiring every worker when
 * the bridge stops, and killing them on dispose.
 */
import type { PowerShellResponse } from '../shared/types';
import { sequenceHoldReleaseError } from './sequence-runner';

interface SessionWorker {
  readonly killed: boolean;
  kill(): unknown;
}

export function createSequenceHoldRelease(host: {
  powerShellBySession: ReadonlyMap<string, SessionWorker>;
  callPowerShell(request: Record<string, unknown>): Promise<PowerShellResponse>;
}): (sessionId: string) => Promise<void> {
  const { powerShellBySession, callPowerShell } = host;
  return async (sessionId) => {
    const child = powerShellBySession.get(sessionId);
    // Never start a worker just to release: a retired worker held nothing.
    if (!child || child.killed) return;
    const response = await callPowerShell({
      action: 'release_sequence_holds',
      session_id: sessionId,
      read_only: false,
    });
    if (response.ok === false) throw sequenceHoldReleaseError(response.error);
  };
}

/** A stopped bridge answers no command, so its native workers are pure cost:
 *  each is retired once, through the session path. */
export function retireBridgeWorkers<Child>(
  powerShellBySession: ReadonlyMap<string, Child>,
  retirePowerShell: (child: Child, error: Error) => void
): void {
  for (const child of new Set(powerShellBySession.values())) {
    retirePowerShell(child, new Error('computer bridge stopped'));
  }
}

/** Dispose: every live worker is killed and the session table emptied. */
export function killSessionWorkers(powerShellBySession: Map<string, SessionWorker>): void {
  for (const child of powerShellBySession.values()) {
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
  powerShellBySession.clear();
}
