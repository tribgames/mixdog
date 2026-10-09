/**
 * Command handling behind the runtime's read-only `terminal` tool. Pure over a
 * small backend so it never touches PTYs itself: a session only ever resolves
 * its own `session-terminal:<sessionId>[:<n>]` tabs, and nothing here writes.
 * The runtime client owns ANSI stripping and line capping; this returns raw
 * text plus a cursor.
 */
import type { SessionTerminalTab } from '../terminal-manager';

export interface TerminalBridgeBackend {
  sessionTabs(sessionId: string): SessionTerminalTab[] | Promise<SessionTerminalTab[]>;
  snapshot(
    id: string,
    since?: number
  ):
    | { text: string; cursor: number; reset: boolean }
    | null
    | Promise<{ text: string; cursor: number; reset: boolean } | null>;
}

export interface TerminalBridgeCommand {
  action?: unknown;
  session_id?: unknown;
  tab?: unknown;
  since?: unknown;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/;

function optionalInteger(value: unknown, name: string, minimum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

export function createTerminalCommandExecutor(backend: TerminalBridgeBackend) {
  return async (command: TerminalBridgeCommand): Promise<unknown> => {
    const sessionId = command.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('session_id is invalid');
    const tabs = await backend.sessionTabs(sessionId);
    if (command.action === 'list') {
      return { tabs: tabs.map(({ tab, shell, running, cwd }) => ({ tab, shell, running, cwd })) };
    }
    if (command.action !== 'read') throw new Error('unsupported terminal action');
    const requested = optionalInteger(command.tab, 'tab', 1);
    const since = optionalInteger(command.since, 'since', 0);
    if (!tabs.length) throw new Error('no terminal tabs are open for this session');
    const target = requested === undefined ? tabs[0] : tabs.find((entry) => entry.tab === requested);
    if (!target) throw new Error(`no terminal tab ${requested}; open tabs: ${tabs.map((entry) => entry.tab).join(', ')}`);
    const snapshot = await backend.snapshot(target.id, since);
    if (!snapshot) throw new Error(`terminal tab ${target.tab} is no longer available`);
    return {
      id: target.id,
      tab: target.tab,
      shell: target.shell,
      running: target.running,
      cwd: target.cwd,
      raw: snapshot.text,
      cursor: snapshot.cursor,
      reset: snapshot.reset,
    };
  };
}
