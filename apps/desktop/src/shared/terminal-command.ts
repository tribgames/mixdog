/** Terminal input that runs `command`, entering each line in turn. */
export function terminalCommandInput(command: string): string {
  return `${command.replace(/\r\n?/g, '\n').replace(/\n+$/, '').replace(/\n/g, '\r')}\r`;
}

/** One terminal main runs for a session, as a client adopts it into its tabs. */
export interface DesktopTerminalRunTab {
  id: string;
  /** Tab number within the session (1 = the session's first terminal). */
  tab: number;
  cwd?: string | null;
}

/** Main → renderer (and paired clients): the agent's `terminal` tool ran a
 *  command in one of a session's terminals, whose process main already runs.
 *  The client lists the terminals, selects `terminalId` and reveals the
 *  session's terminal dock. */
export interface DesktopTerminalRunRequest {
  sessionId: string;
  /** The terminal the command went to; its tab is selected. */
  terminalId?: string;
  /** Every terminal main runs for the session: tabs this device lacks are added. */
  tabs?: DesktopTerminalRunTab[];
  /** Main waits on this: the desktop renderer claims it (`claimTerminalRun`)
   *  once a pane really shows `terminalId`; unclaimed, the run is reported as
   *  running in the background. Never sent to paired clients. */
  requestId?: string;
}

/** Desktop-service event carrying a DesktopTerminalRunRequest to the relay,
 *  which forwards it to paired clients as REMOTE_TERMINAL_RUN_EVENT. */
export const TERMINAL_RUN_REQUESTED_DESKTOP_EVENT = 'terminal-run-requested';
/** Encrypted relay push carrying a DesktopTerminalRunRequest. */
export const REMOTE_TERMINAL_RUN_EVENT = 'terminalRunRequested';

/** How long the desktop renderer watches for a pane to show a revealed
 *  terminal before giving up; main waits this long plus the claim's trip back. */
export const TERMINAL_SHOWN_WAIT_MS = 1500;

/** What paired clients receive: no ack id and no path (a tab's working
 *  directory is a PC path; a phone adopts the tab and binds its own root). */
export function remoteTerminalRun({ sessionId, terminalId, tabs }: DesktopTerminalRunRequest): DesktopTerminalRunRequest {
  return {
    sessionId,
    ...(terminalId ? { terminalId } : {}),
    ...(tabs ? { tabs: tabs.map(({ id, tab }) => ({ id, tab })) } : {}),
  };
}

/** A relayed terminal reveal, or null when the payload is not one. */
export function readRemoteTerminalRun(value: unknown): DesktopTerminalRunRequest | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.sessionId !== 'string' || !input.sessionId) return null;
  const tabs: DesktopTerminalRunTab[] = [];
  if (Array.isArray(input.tabs)) {
    for (const entry of input.tabs as Record<string, unknown>[]) {
      if (typeof entry?.id !== 'string' || !Number.isInteger(entry.tab) || (entry.tab as number) < 1) continue;
      tabs.push({
        id: entry.id,
        tab: entry.tab as number,
      });
    }
  }
  return {
    sessionId: input.sessionId,
    ...(typeof input.terminalId === 'string' && input.terminalId ? { terminalId: input.terminalId } : {}),
    ...(tabs.length ? { tabs } : {}),
  };
}
