// Dock terminal backend: PTYs live in
// the MAIN process, the renderer runs a thin xterm view over IPC. Prebuilt
// node-pty avoids an electron-rebuild step on Windows. Keep the native module
// behind first terminal use so cold desktop startup never loads its bindings.
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import type { TerminalSpawnProfile } from './terminal-worker-protocol';

const REPLAY_BUFFER_LIMIT = 200_000;

/** Retain only the newest terminal output without copying the whole replay
 * window on every PTY chunk. Materialize one string only when a view reattaches. */
export class TerminalReplayBuffer {
  private chunks: string[] = [];
  private head = 0;
  private headOffset = 0;
  private retainedChars = 0;
  private readonly limit: number;

  constructor(limit = REPLAY_BUFFER_LIMIT) {
    this.limit = Math.max(1, Math.floor(Number(limit)) || REPLAY_BUFFER_LIMIT);
  }

  append(data: string): void {
    const value = String(data || '');
    if (!value) return;
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
      const chunk = index === this.head && this.headOffset > 0
        ? this.chunks[index].slice(this.headOffset)
        : this.chunks[index];
      if (chunk) parts.push(chunk);
    }
    return parts.length === 1 ? parts[0] : parts.join('');
  }
}

interface ManagedTerminal {
  pty: IPty;
  buffer: TerminalReplayBuffer;
  disposed: boolean;
  outputPaused: boolean;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly listeners = new Set<(event: TerminalDataEvent) => void>();
  private sequence = 0;
  private ptyModule: Promise<typeof import('@homebridge/node-pty-prebuilt-multiarch')> | null = null;
  private disposed = false;

  subscribe(listener: (event: TerminalDataEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Create (or reuse) a PTY; returns id + replay buffer for reattach. */
  async ensure(
    id: string | null,
    cwd: string | null,
    profile?: TerminalSpawnProfile | null,
  ): Promise<{ id: string; replay: string }> {
    if (this.disposed) throw new Error('Terminal manager is disposed.');
    if (id) {
      const existing = this.terminals.get(id);
      if (existing && !existing.disposed) return { id, replay: existing.buffer.read() };
    }
    const { spawn } = await (this.ptyModule ??= import('@homebridge/node-pty-prebuilt-multiarch'));
    if (this.disposed) throw new Error('Terminal manager is disposed.');
    const requestedId = id && /^term_[A-Za-z0-9_-]{1,120}$/.test(id) ? id : '';
    const nextId = requestedId || `term_${process.pid}_${++this.sequence}`;
    // A resolved shell profile (user picked one in the terminal strip) wins;
    // otherwise the platform default stands as before.
    const shell = profile?.path
      || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash');
    const env = profile?.env
      ? { ...process.env, ...profile.env }
      : process.env;
    const pty = spawn(shell, profile?.args ?? [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || process.env.USERPROFILE || process.env.HOME || process.cwd(),
      env: env as Record<string, string>,
    });
    const entry: ManagedTerminal = {
      pty,
      buffer: new TerminalReplayBuffer(),
      disposed: false,
      outputPaused: false,
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

  write(id: string, data: string): void {
    const entry = this.terminals.get(id);
    if (entry && !entry.disposed) entry.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.terminals.get(id);
    const safeCols = Math.max(2, Math.min(500, Math.floor(cols) || 80));
    const safeRows = Math.max(2, Math.min(200, Math.floor(rows) || 24));
    if (entry && !entry.disposed) {
      try { entry.pty.resize(safeCols, safeRows); } catch { /* racing exit */ }
    }
  }

  /** Pause the producer itself so a sustained flood backs up into the shell
   * instead of growing the main-process pending queue without bound. */
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
      try { (entry.pty as IPty & { resume?(): void }).resume?.(); } catch { /* racing exit */ }
      entry.outputPaused = false;
    }
    entry.disposed = true;
    try { entry.pty.kill(); } catch { /* already gone */ }
    this.terminals.delete(id);
  }

  disposeAll(): void {
    this.disposed = true;
    for (const entry of this.terminals.values()) {
      if (entry.outputPaused) {
        try { (entry.pty as IPty & { resume?(): void }).resume?.(); } catch { /* racing exit */ }
        entry.outputPaused = false;
      }
      entry.disposed = true;
      try { entry.pty.kill(); } catch { /* already gone */ }
    }
    this.terminals.clear();
    this.listeners.clear();
  }
}
