/**
 * Saved-login owners (Windows only, like saved logins): the OS's answer about
 * one runtime process, read by the host's own worker. The bridge asks as
 * owners attach and detach; a capture a detached owner's saved-login guard
 * would withhold asks too.
 */
import type { PowerShellResponse } from '../shared/types';
import type { ProcessFate } from './bridge-server-contract';
import { HOST_WARMUP_SESSION_ID } from './action-sets';

export type ReadProcessFate = (process: { pid: number; created: string }) => Promise<ProcessFate>;

export function createProcessFateReader(
  callPowerShell: (request: Record<string, unknown>) => Promise<PowerShellResponse>
): ReadProcessFate {
  return async ({ pid, created }) => {
    if (process.platform !== 'win32') return { state: 'unknown', created: '' };
    const response = await callPowerShell({
      action: 'process_fate',
      session_id: HOST_WARMUP_SESSION_ID,
      pid: String(pid),
      created,
    });
    const result = response.result as { state?: unknown; created?: unknown } | undefined;
    const state = response.ok && (result?.state === 'running' || result?.state === 'ended') ? result.state : 'unknown';
    return { state, created: typeof result?.created === 'string' ? result.created : '' };
  };
}
