/**
 * Command handling behind the runtime's `terminal` tool (list / read / run).
 * Pure over a small backend so it never touches PTYs or windows itself: a
 * session only ever resolves its own `session-terminal:<sessionId>[:<n>]`
 * tabs. `run` types a command into one of them, or starts the session's first
 * terminal here when it has none — main owns the process, so a run never waits
 * on a mounted pane — then reveals that tab; it is single-shot, never retried.
 * The runtime client owns ANSI stripping and line capping; this returns raw
 * text plus a cursor.
 */
import { terminalCommandInput } from '../../shared/terminal-command';
import type { SessionTerminalTab } from '../terminal-manager';

export interface TerminalBridgeBackend {
  sessionTabs(sessionId: string): SessionTerminalTab[] | Promise<SessionTerminalTab[]>;
  /** Type `data` into the tab's PTY. */
  write(id: string, data: string): void | Promise<void>;
  /** Start the session's first terminal process (no pane needed) and return its tab. */
  startTerminal(sessionId: string): SessionTerminalTab | Promise<SessionTerminalTab>;
  /** Select `target` among the session's `tabs` and reveal its dock, on the
   *  desktop and on paired clients. Resolves true when a pane shows it, false
   *  when it runs in the background. */
  revealTerminal(sessionId: string, target: SessionTerminalTab, tabs: SessionTerminalTab[]): Promise<boolean>;
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
  command?: unknown;
}

const MAX_COMMAND_LENGTH = 8000;

const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/;

function optionalInteger(value: unknown, name: string, minimum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function requireCommand(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('command must be a non-empty string');
  if (value.length > MAX_COMMAND_LENGTH) throw new Error(`command must be at most ${MAX_COMMAND_LENGTH} characters`);
  return value;
}

const runResult = (target: SessionTerminalTab, cursor: number) => ({
  id: target.id,
  tab: target.tab,
  shell: target.shell,
  running: target.running,
  cwd: target.cwd,
  cursor,
});

export function createTerminalCommandExecutor(backend: TerminalBridgeBackend) {
  return async (command: TerminalBridgeCommand, signal?: AbortSignal): Promise<unknown> => {
    const sessionId = command.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('session_id is invalid');
    if (command.action === 'run') {
      const requested = optionalInteger(command.tab, 'tab', 1);
      const text = requireCommand(command.command);
      // A caller that cancelled must never see its command entered: checked
      // after every wait and again right before the write.
      const notCancelled = () => {
        if (signal?.aborted) throw new Error('terminal run cancelled');
      };
      notCancelled();
      let open = await backend.sessionTabs(sessionId);
      if (!open.length) {
        if (requested !== undefined) throw new Error(`no terminal tab ${requested}; no terminal tabs are open`);
        // The process starts here, whatever the screen shows: the pane that
        // appears later attaches to it.
        open = [await backend.startTerminal(sessionId)];
      }
      notCancelled();
      const target = requested === undefined ? open[0] : open.find((entry) => entry.tab === requested);
      if (!target)
        throw new Error(`no terminal tab ${requested}; open tabs: ${open.map((entry) => entry.tab).join(', ')}`);
      const before = await backend.snapshot(target.id);
      if (!before) throw new Error(`terminal tab ${target.tab} is no longer available`);
      notCancelled();
      await backend.write(target.id, terminalCommandInput(text));
      // Only a command that was entered is revealed, so the dock never opens on
      // a run that failed.
      const shown = await backend.revealTerminal(sessionId, target, open);
      return { ...runResult(target, before.cursor), shown };
    }
    const tabs = await backend.sessionTabs(sessionId);
    if (command.action === 'list') {
      return { tabs: tabs.map(({ tab, shell, running, cwd }) => ({ tab, shell, running, cwd })) };
    }
    if (command.action !== 'read') throw new Error('unsupported terminal action');
    const requested = optionalInteger(command.tab, 'tab', 1);
    const since = optionalInteger(command.since, 'since', 0);
    if (!tabs.length) throw new Error('no terminal tabs are open for this session');
    const target = requested === undefined ? tabs[0] : tabs.find((entry) => entry.tab === requested);
    if (!target)
      throw new Error(`no terminal tab ${requested}; open tabs: ${tabs.map((entry) => entry.tab).join(', ')}`);
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
