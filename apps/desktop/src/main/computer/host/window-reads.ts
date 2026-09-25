/**
 * Window-list and integrity reads against the resident backend, filtered so
 * the app's own Computer Use surfaces never appear as targets.
 */
import type { ComputerCommand, PowerShellResponse } from '../shared/types';
import { normalizeComputerWindowRecords, type ComputerWindowRecord } from '../shared/window-transition';
import { filterComputerUseInternalWindows } from '../overlay/internal-windows';

export interface WindowReadsHost {
  callPowerShell(request: Record<string, unknown>, timeoutMs?: number): Promise<PowerShellResponse>;
  sessionIdFor(command: ComputerCommand): string;
}

/** An app Windows knows how to start, whether or not it is running. */
export interface InstalledAppRecord {
  name: string;
  app_id: string;
  packaged: boolean;
}

export interface InstalledApps {
  matches: InstalledAppRecord[];
  total: number;
}

export interface WindowIntegrity {
  known: boolean;
  higher: boolean;
  ownName: string;
  targetName: string;
}

/** No integrity was read: the worker choice falls back to the ordinary one. */
export const UNKNOWN_WINDOW_INTEGRITY: Readonly<WindowIntegrity> = Object.freeze({
  known: false,
  higher: false,
  ownName: 'Unknown',
  targetName: 'Unknown',
});

export function createWindowReads(host: WindowReadsHost) {
  const { callPowerShell, sessionIdFor } = host;

  async function readWindowIntegrity(windowId: string | undefined, sessionId: string): Promise<WindowIntegrity> {
    if (!windowId) return { ...UNKNOWN_WINDOW_INTEGRITY };
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
    includeApp = false
  ): Promise<ComputerWindowRecord[] | null> {
    try {
      const response = await callPowerShell({
        action: includeApp ? 'list_windows' : 'window_snapshot',
        session_id: sessionIdFor(command),
        read_only: true,
      });
      if (!response.ok) return null;
      return filterComputerUseInternalWindows(normalizeComputerWindowRecords(response.result?.windows));
    } catch {
      return null;
    }
  }

  async function readInstalledApps(command: ComputerCommand): Promise<InstalledApps | null> {
    try {
      const response = await callPowerShell({
        action: 'list_installed_apps',
        session_id: sessionIdFor(command),
        query: String(command.query || ''),
        read_only: true,
      });
      if (!response.ok) return null;
      const rows = (Array.isArray(response.result?.installed) ? response.result.installed : []) as Array<
        Record<string, unknown>
      >;
      return {
        matches: rows.map((row) => ({
          name: String(row.name || ''),
          app_id: String(row.app_id || ''),
          packaged: row.packaged === true,
        })),
        total: Number(response.result?.catalogue_total || 0),
      };
    } catch {
      return null;
    }
  }

  return { readWindowIntegrity, readComputerWindows, readInstalledApps };
}

export type WindowReads = ReturnType<typeof createWindowReads>;
