/**
 * The desktop app's side of the agent `terminal` tool: PTYs are daemon-owned
 * and reached through desktop operations, and a run starts its process here
 * rather than waiting for a mounted terminal pane.
 */
import type { DesktopTerminalRunRequest } from '../../shared/terminal-command';
import type { SessionTerminalTab } from '../terminal-manager';
import type { TerminalBridgeBackend } from './commands';

export interface TerminalBridgeBackendDeps {
  invoke(name: string, args: unknown[]): Promise<unknown>;
  /** The session's working directory, where its first terminal starts. */
  sessionCwd(sessionId: string): Promise<string | null>;
  /** Reveal to the desktop window and paired clients; true when a desktop pane shows it. */
  reveal(request: Omit<DesktopTerminalRunRequest, 'requestId'>): Promise<boolean>;
}

/** A session's first terminal (tab 1); the renderer's tab 1 uses the same id. */
const firstTerminalId = (sessionId: string): string => `session-terminal:${sessionId}`;

export function createTerminalBridgeBackend({
  invoke,
  sessionCwd,
  reveal,
}: TerminalBridgeBackendDeps): TerminalBridgeBackend {
  const sessionTabs = async (sessionId: string) => (await invoke('termSessionTabs', [sessionId])) as SessionTerminalTab[];
  return {
    sessionTabs,
    write: async (id, data) => {
      await invoke('termWrite', [id, data]);
    },
    startTerminal: async (sessionId) => {
      await invoke('termEnsure', [firstTerminalId(sessionId), await sessionCwd(sessionId), null]);
      const started = (await sessionTabs(sessionId)).find((entry) => entry.id === firstTerminalId(sessionId));
      if (!started) throw new Error('the terminal did not start');
      return started;
    },
    revealTerminal: (sessionId, target, tabs) =>
      reveal({
        sessionId,
        terminalId: target.id,
        tabs: tabs.map(({ id, tab, cwd }) => ({ id, tab, cwd })),
      }),
    snapshot: async (id, since) =>
      (await invoke('termSnapshot', since === undefined ? [id] : [id, since])) as {
        text: string;
        cursor: number;
        reset: boolean;
      } | null,
  };
}
