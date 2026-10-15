/**
 * Command handling behind the runtime's `terminal` tool (list / read / run).
 * Pure over a small backend so it never touches PTYs or windows itself: a
 * session only ever resolves its own `session-terminal:<sessionId>[:<n>]`
 * tabs. `run` types a command into one of them, or has the renderer open a tab
 * when the session has none, and is single-shot — it is never retried here.
 * The runtime client owns ANSI stripping and line capping; this returns raw
 * text plus a cursor.
 */
import { terminalCommandInput } from '../../shared/terminal-command';
import type { SessionTerminalTab } from '../terminal-manager';

export interface TerminalBridgeBackend {
  sessionTabs(sessionId: string): SessionTerminalTab[] | Promise<SessionTerminalTab[]>;
  /** Type `data` into the tab's PTY. */
  write(id: string, data: string): void | Promise<void>;
  /** Ask the renderer to reveal the session's terminal dock. False when no
   *  desktop window is available. */
  revealTerminal(sessionId: string): boolean;
  /** Ask the renderer to open a tab for the session and enter `command`. False
   *  when no desktop window is available. */
  openTerminal(sessionId: string, command: string): boolean;
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

export interface TerminalCommandOptions {
  /** How long `run` waits for a renderer-opened tab to appear. */
  openTimeoutMs?: number;
  openPollMs?: number;
}

const MAX_COMMAND_LENGTH = 8000;
const OPEN_TIMEOUT_MS = 5000;
const OPEN_POLL_MS = 100;

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

export function createTerminalCommandExecutor(backend: TerminalBridgeBackend, options: TerminalCommandOptions = {}) {
  const openTimeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS;
  const openPollMs = options.openPollMs ?? OPEN_POLL_MS;

  // The session has no tab: the renderer opens one and enters the command, so
  // wait (bounded) for the daemon to list it.
  async function runInNewTab(sessionId: string, command: string) {
    if (!backend.openTerminal(sessionId, command)) {
      throw new Error('no desktop window is available to open a terminal');
    }
    const deadline = Date.now() + openTimeoutMs;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, openPollMs));
      const [target] = await backend.sessionTabs(sessionId);
      if (target) return runResult(target, 0);
      if (Date.now() >= deadline) throw new Error('timed out waiting for the terminal tab to open');
    }
  }

  return async (command: TerminalBridgeCommand): Promise<unknown> => {
    const sessionId = command.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('session_id is invalid');
    if (command.action === 'run') {
      const requested = optionalInteger(command.tab, 'tab', 1);
      const text = requireCommand(command.command);
      const open = await backend.sessionTabs(sessionId);
      if (!open.length) {
        if (requested !== undefined) throw new Error(`no terminal tab ${requested}; no terminal tabs are open`);
        return runInNewTab(sessionId, text);
      }
      const target = requested === undefined ? open[0] : open.find((entry) => entry.tab === requested);
      if (!target) throw new Error(`no terminal tab ${requested}; open tabs: ${open.map((entry) => entry.tab).join(', ')}`);
      const before = await backend.snapshot(target.id);
      if (!before) throw new Error(`terminal tab ${target.tab} is no longer available`);
      await backend.write(target.id, terminalCommandInput(text));
      backend.revealTerminal(sessionId);
      return runResult(target, before.cursor);
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
