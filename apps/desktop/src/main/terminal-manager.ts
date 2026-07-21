// Dock terminal backend (aider-desk terminal-manager pattern): PTYs live in
// the MAIN process, the renderer runs a thin xterm view over IPC. Prebuilt
// node-pty avoids an electron-rebuild step on Windows. Keep the native module
// behind first terminal use so cold desktop startup never loads its bindings.
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';

const REPLAY_BUFFER_LIMIT = 200_000;

interface ManagedTerminal {
  pty: IPty;
  buffer: string;
  disposed: boolean;
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
  async ensure(id: string | null, cwd: string | null): Promise<{ id: string; replay: string }> {
    if (this.disposed) throw new Error('Terminal manager is disposed.');
    if (id) {
      const existing = this.terminals.get(id);
      if (existing && !existing.disposed) return { id, replay: existing.buffer };
    }
    const { spawn } = await (this.ptyModule ??= import('@homebridge/node-pty-prebuilt-multiarch'));
    if (this.disposed) throw new Error('Terminal manager is disposed.');
    const nextId = `term_${process.pid}_${++this.sequence}`;
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash';
    const pty = spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || process.env.USERPROFILE || process.env.HOME || process.cwd(),
      env: process.env as Record<string, string>,
    });
    const entry: ManagedTerminal = { pty, buffer: '', disposed: false };
    pty.onData((data) => {
      entry.buffer = (entry.buffer + data).slice(-REPLAY_BUFFER_LIMIT);
      for (const listener of this.listeners) listener({ id: nextId, data });
    });
    pty.onExit(({ exitCode }) => {
      entry.disposed = true;
      const notice = `\r\n[process exited with code ${exitCode}]\r\n`;
      entry.buffer = (entry.buffer + notice).slice(-REPLAY_BUFFER_LIMIT);
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

  disposeAll(): void {
    this.disposed = true;
    for (const entry of this.terminals.values()) {
      entry.disposed = true;
      try { entry.pty.kill(); } catch { /* already gone */ }
    }
    this.terminals.clear();
    this.listeners.clear();
  }
}
