/**
 * Window-list and integrity reads against the resident backend, filtered so
 * the app's own Computer Use surfaces never appear as targets.
 */
import type { ComputerCommand, PowerShellResponse } from '../shared/types';
import {
  normalizeComputerWindowRecords,
  type ComputerWindowRecord,
} from '../shared/window-transition';
import { filterComputerUseInternalWindows } from '../overlay/internal-windows';

export interface WindowReadsHost {
  callPowerShell(request: Record<string, unknown>, timeoutMs?: number): Promise<PowerShellResponse>;
  sessionIdFor(command: ComputerCommand): string;
}

export interface WindowIntegrity {
  known: boolean;
  higher: boolean;
  ownName: string;
  targetName: string;
}

export function createWindowReads(host: WindowReadsHost) {
  const { callPowerShell, sessionIdFor } = host;

  async function readWindowIntegrity(
    windowId: string | undefined,
    sessionId: string,
  ): Promise<WindowIntegrity> {
    if (!windowId) return { known: false, higher: false, ownName: 'Unknown', targetName: 'Unknown' };
    const response = await callPowerShell({
      action: 'window_integrity',
      window_id: windowId,
      session_id: sessionId,
      read_only: true,
    });
    if (!response.ok) throw new Error(response.error || 'window integrity lookup failed');
    return {
      known: response.result?.known === true,
      higher: response.result?.higher === true,
      ownName: String(response.result?.own_name || 'Unknown'),
      targetName: String(response.result?.target_name || 'Unknown'),
    };
  }

  async function readComputerWindows(
    command: ComputerCommand,
    includeApp = false,
  ): Promise<ComputerWindowRecord[] | null> {
    try {
      const response = await callPowerShell({
        action: includeApp ? 'list_windows' : 'window_snapshot',
        session_id: sessionIdFor(command),
        read_only: true,
      });
      if (!response.ok) return null;
      return filterComputerUseInternalWindows(
        normalizeComputerWindowRecords(response.result?.windows),
      );
    } catch {
      return null;
    }
  }

  return { readWindowIntegrity, readComputerWindows };
}

export type WindowReads = ReturnType<typeof createWindowReads>;
