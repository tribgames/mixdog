// Dock terminal service: PTYs live in the singleton daemon, while the renderer
// runs a thin xterm view over IPC. Prebuilt
// node-pty avoids an electron-rebuild step on Windows. Keep the native module
// behind first terminal use so cold desktop startup never loads its bindings.
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import { childEnvironment } from './child-environment';
import type { TerminalSpawnProfile } from './terminal-contract';
import type { TerminalDataEvent } from './terminal-data-buffer';

const REPLAY_BUFFER_LIMIT = 200_000;

/** Retain only the newest terminal output without copying the whole replay
 * window on every PTY chunk. Materialize one string only when a view reattaches. */
export class TerminalReplayBuffer {
  private chunks: string[] = [];
  private head = 0;
  private headOffset = 0;
  private retainedChars = 0;
  private appendedChars: number;
  private readonly startOffset: number;
  private readonly limit: number;

  /** `startOffset` lets a recreated terminal begin above every cursor its
   * predecessor issued, so those stale cursors fall below `oldest`. */
  constructor(limit = REPLAY_BUFFER_LIMIT, startOffset = 0) {
    this.limit = Math.max(1, Math.floor(Number(limit)) || REPLAY_BUFFER_LIMIT);
    this.startOffset = Math.max(0, Math.floor(Number(startOffset)) || 0);
    this.appendedChars = this.startOffset;
  }

  append(data: string): void {
    const value = String(data || '');
    if (!value) return;
    this.appendedChars += value.length;
    if (value.length >= this.limit) {
      this.chunks = [value.slice(-this.limit)];
      this.head = 0;
      this.headOffset = 0;
      this.retainedChars = this.limit;
      return;
    }
    this.chunks.push(value);
    this.retainedChars += value.length;
    let overflow = this.retainedChars - this.limit;
    while (overflow > 0 && this.head < this.chunks.length) {
      const chunk = this.chunks[this.head];
      const available = chunk.length - this.headOffset;
      if (overflow < available) {
        this.headOffset += overflow;
        this.retainedChars -= overflow;
        overflow = 0;
      } else {
        overflow -= available;
        this.retainedChars -= available;
        this.head += 1;
        this.headOffset = 0;
      }
    }
    // Drop consumed references occasionally; unlike string slicing this only
    // copies the small array of retained chunk references.
    if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  read(): string {
    if (this.retainedChars <= 0 || this.head >= this.chunks.length) return '';
    const parts: string[] = [];
    for (let index = this.head; index < this.chunks.length; index += 1) {
      const chunk =
        index === this.head && this.headOffset > 0 ? this.chunks[index].slice(this.headOffset) : this.chunks[index];
      if (chunk) parts.push(chunk);
    }
    return parts.length === 1 ? parts[0] : parts.join('');
  }

  /** Read-only cursor: total characters ever appended (never decreases). */
  get cursor(): number {
    return this.appendedChars;
  }

  /** True once this terminal's own output exceeded the retained window. */
  get trimmed(): boolean {
    return this.appendedChars - this.startOffset > this.retainedChars;
  }

  /** Output appended after `cursor`, without consuming anything. `reset` is
   * true when the requested position had already been trimmed away, so the
   * text starts at the oldest retained character instead. */
  readSince(cursor: number): { text: string; cursor: number; reset: boolean } {
    const retained = this.read();
    const oldest = this.appendedChars - retained.length;
    const from = Math.floor(Number(cursor));
    if (!Number.isFinite(from) || from < 0 || from < oldest || from > this.appendedChars) {
      return { text: retained, cursor: this.appendedChars, reset: true };
    }
    return { text: retained.slice(from - oldest), cursor: this.appendedChars, reset: false };
  }
}

interface ManagedTerminal {
  pty: IPty;
  buffer: TerminalReplayBuffer;
  disposed: boolean;
  outputPaused: boolean;
  shell: string;
  cwd: string | null;
}

/** One tab of a session's terminal, as the read-only agent bridge sees it. */
export interface SessionTerminalTab {
  tab: number;
  id: string;
  shell: string;
  running: boolean;
  cwd: string | null;
}

const SESSION_TERMINAL_PREFIX = 'session-terminal:';
const SESSION_TERMINAL_ID = /^session-terminal:[A-Za-z0-9_-]{1,120}(?::[1-9]\d{0,2})?$/;

/** Shell label for a spawn path: `C:\\...\\pwsh.exe` → `pwsh`. */
function shellLabel(shell: string): string {
  return (
    shell
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.exe$/i, '') || shell
  );
}

/** 1000 cursor units per wall-clock millisecond: a terminal would have to
 *  print over 1000 characters per millisecond of its lifetime to reach the
 *  epoch of a terminal created after it. Stays a safe integer for centuries. */
export function terminalCursorEpoch(now = Date.now()): number {
  return Math.floor(now) * 1000;
}

export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly listeners = new Set<(event: TerminalDataEvent) => void>();
  private readonly cursorFloors = new Map<string, number>();
  private readonly spawning = new Map<string, Promise<{ id: string; replay: string }>>();
  private sequence = 0;
  private ptyModule: Promise<typeof import('@homebridge/node-pty-prebuilt-multiarch')> | null = null;
  private disposed = false;

  subscribe(listener: (event: TerminalDataEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Load the native PTY bindings, forgetting a FAILED load. A cached rejected
   * import (missing unpacked binding, blocked dlopen) otherwise pins every
   * later terminal in this service to the first failure, so the view's retry
   * loop can never recover without restarting the whole daemon. */
  private loadPtyBindings(): Promise<typeof import('@homebridge/node-pty-prebuilt-multiarch')> {
    if (this.ptyModule) return this.ptyModule;
    const pending: Promise<typeof import('@homebridge/node-pty-prebuilt-multiarch')> = import(
      '@homebridge/node-pty-prebuilt-multiarch'
    ).catch((error: unknown) => {
      if (this.ptyModule === pending) this.ptyModule = null;
      throw new Error(
        'The terminal service could not load its PTY bindings: ' +
          (error instanceof Error ? error.message : String(error))
      );
    });
    this.ptyModule = pending;
    return pending;
  }

  /** Create (or reuse) a PTY; returns id + replay buffer for reattach. */
  async ensure(
    id: string | null,
    cwd: string | null,
    profile?: TerminalSpawnProfile | null
  ): Promise<{ id: string; replay: string }> {
    if (this.disposed) throw new Error('Terminal manager is disposed.');
    if (id) {
      const existing = this.terminals.get(id);
      if (existing && !existing.disposed) return { id, replay: existing.buffer.read() };
      // Concurrent ensures for one id (remount, retry timer, second surface)
      // must share a single spawn; each extra spawn printed another banner
      // through the same id and orphaned the earlier PTY.
      const inFlight = this.spawning.get(id);
      if (inFlight) {
        await inFlight.catch(() => undefined);
        return this.ensure(id, cwd, profile);
      }
      const spawning = this.spawnTerminal(id, cwd, profile);
      this.spawning.set(id, spawning);
      try {
        return await spawning;
      } finally {
        if (this.spawning.get(id) === spawning) this.spawning.delete(id);
      }
    }
    return this.spawnTerminal(id, cwd, profile);
  }

  private async spawnTerminal(
    id: string | null,
    cwd: string | null,
    profile?: TerminalSpawnProfile | null
  ): Promise<{ id: string; replay: string }> {
    const { spawn } = await this.loadPtyBindings();
    if (this.disposed) throw new Error('Terminal manager is disposed.');
    const requestedId = id && (/^term_[A-Za-z0-9_-]{1,120}$/.test(id) || SESSION_TERMINAL_ID.test(id)) ? id : '';
    const nextId = requestedId || `term_${process.pid}_${++this.sequence}`;
    // A resolved shell profile (user picked one in the terminal strip) wins;
    // otherwise the platform default stands as before.
    const shell = profile?.path || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash');
    const env = childEnvironment(profile?.env ?? {});
    const pty = spawn(shell, profile?.args ?? [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || process.env.USERPROFILE || process.env.HOME || process.cwd(),
      env: env as Record<string, string>,
    });
    const prior = this.terminals.get(nextId);
    const floor = Math.max(this.cursorFloors.get(nextId) ?? -1, prior ? prior.buffer.cursor : -1);
    const entry: ManagedTerminal = {
      pty,
      // Cursors start at a creation-time epoch, so a cursor issued before a
      // daemon restart (whose floors are gone) still falls below `oldest`.
      buffer: new TerminalReplayBuffer(REPLAY_BUFFER_LIMIT, Math.max(floor + 1, terminalCursorEpoch())),
      disposed: false,
      outputPaused: false,
      shell: shellLabel(shell),
      cwd: cwd || null,
    };
    pty.onData((data) => {
      entry.buffer.append(data);
      for (const listener of this.listeners) listener({ id: nextId, data });
    });
    pty.onExit(({ exitCode }) => {
      entry.disposed = true;
      entry.outputPaused = false;
      const notice = `\r\n[process exited with code ${exitCode}]\r\n`;
      entry.buffer.append(notice);
      for (const listener of this.listeners) listener({ id: nextId, data: notice });
    });
    this.terminals.set(nextId, entry);
    return { id: nextId, replay: '' };
  }

  /** Read-only: the tabs of one session's terminal, ordered by tab number.
   * Tab 1 is `session-terminal:<sessionId>`, tab n is `…:<n>`. Other
   * sessions' terminals are never visible through this. */
  sessionTabs(sessionId: string): SessionTerminalTab[] {
    const base = `${SESSION_TERMINAL_PREFIX}${sessionId}`;
    const tabs: SessionTerminalTab[] = [];
    for (const [id, entry] of this.terminals) {
      let tab = 0;
      if (id === base) tab = 1;
      else if (id.startsWith(`${base}:`) && /^[1-9]\d*$/.test(id.slice(base.length + 1))) {
        tab = Number(id.slice(base.length + 1));
      }
      if (tab) tabs.push({ tab, id, shell: entry.shell, running: !entry.disposed, cwd: entry.cwd });
    }
    return tabs.sort((a, b) => a.tab - b.tab);
  }

  /** Read-only: output of one terminal after `since` (all retained output when
   * omitted). Does not consume or alter the replay buffer. */
  snapshot(id: string, since?: number): { text: string; cursor: number; reset: boolean } | null {
    const entry = this.terminals.get(id);
    if (!entry) return null;
    return since === undefined
      ? { text: entry.buffer.read(), cursor: entry.buffer.cursor, reset: entry.buffer.trimmed }
      : entry.buffer.readSince(since);
  }

  write(id: string, data: string): void {
    const entry = this.terminals.get(id);
    if (entry && !entry.disposed) entry.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.terminals.get(id);
    const safeCols = Math.max(2, Math.min(500, Math.floor(cols) || 80));
    const safeRows = Math.max(2, Math.min(200, Math.floor(rows) || 24));
    if (entry && !entry.disposed) {
      try {
        entry.pty.resize(safeCols, safeRows);
      } catch {
        /* racing exit */
      }
    }
  }

  /** Pause the producer itself so a sustained flood backs up into the shell
   * instead of growing the service transport queue without bound. */
  pauseOutput(id: string): void {
    const entry = this.terminals.get(id);
    if (!entry || entry.disposed || entry.outputPaused) return;
    const pty = entry.pty as IPty & { pause?(): void };
    if (typeof pty.pause !== 'function') return;
    try {
      pty.pause();
      entry.outputPaused = true;
    } catch {
      // Flow control is best-effort; IPC buffering still protects xterm.
    }
  }

  resumeOutput(id: string): void {
    const entry = this.terminals.get(id);
    if (!entry || entry.disposed || !entry.outputPaused) return;
    const pty = entry.pty as IPty & { resume?(): void };
    if (typeof pty.resume !== 'function') return;
    try {
      pty.resume();
      entry.outputPaused = false;
    } catch {
      // A later acknowledgement or teardown can retry the resume.
    }
  }

  dispose(id: string): void {
    const entry = this.terminals.get(id);
    if (!entry) return;
    if (entry.outputPaused) {
      try {
        (entry.pty as IPty & { resume?(): void }).resume?.();
      } catch {
        /* racing exit */
      }
      entry.outputPaused = false;
    }
    entry.disposed = true;
    try {
      entry.pty.kill();
    } catch {
      /* already gone */
    }
    this.cursorFloors.set(id, Math.max(this.cursorFloors.get(id) ?? -1, entry.buffer.cursor));
    this.terminals.delete(id);
  }

  disposeAll(): void {
    this.disposed = true;
    for (const entry of this.terminals.values()) {
      if (entry.outputPaused) {
        try {
          (entry.pty as IPty & { resume?(): void }).resume?.();
        } catch {
          /* racing exit */
        }
        entry.outputPaused = false;
      }
      entry.disposed = true;
      try {
        entry.pty.kill();
      } catch {
        /* already gone */
      }
    }
    this.terminals.clear();
    this.listeners.clear();
  }
}
