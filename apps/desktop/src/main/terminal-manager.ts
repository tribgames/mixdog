// Dock terminal service: PTYs live in the singleton daemon, while the renderer
// runs a thin xterm view over IPC. Prebuilt
// node-pty avoids an electron-rebuild step on Windows. Keep the native module
// behind first terminal use so cold desktop startup never loads its bindings.
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import { childEnvironment } from './child-environment';
import type { TerminalSpawnProfile } from './terminal-contract';
import type { TerminalDataEvent } from './terminal-data-buffer';
import type { TerminalSizeOwner, TerminalSizeOwnerChange } from '../shared/terminal-size-owner';
import type { TerminalActivityEvent } from '../shared/terminal-activity';
import { TerminalActivityTracker, TerminalMarkerScanner } from './terminal-activity';
import { planShellIntegration } from './terminal-shell-integration';

const REPLAY_BUFFER_LIMIT = 200_000;
/** How long output that may start a shell-integration marker is held back. */
const HELD_OUTPUT_FLUSH_MS = 50;
/** A phone re-claims every 10s while it shows the terminal; a claim that
 *  stops renewing (lost connection) lapses so the PC fits its pane again. */
const SIZE_OWNER_LEASE_MS = 30_000;

interface SizeClaim {
  cols: number;
  rows: number;
  lease: NodeJS.Timeout;
}

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
  activity: TerminalActivityTracker;
  /** Present only when the shell runs Mixdog's integration. */
  markers?: TerminalMarkerScanner;
}

/** One tab of a session's terminal, as the agent `terminal` bridge sees it. */
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

/** Slash-normalized, trailing-slash-free path; case-folded on Windows/macOS. */
function normalizeRoot(value: string): string {
  const path = String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
}

/** True when `path` is `root` or lies inside it (the rule disposeTerminalsUnder uses). */
export function isPathUnderRoot(root: string, path: string): boolean {
  const base = normalizeRoot(root);
  const target = path ? normalizeRoot(path) : '';
  return !!base && !!target && (target === base || target.startsWith(`${base}/`));
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
  /** Per PTY, the remote connections claiming its size, oldest claim first;
   *  the newest claim owns. */
  private readonly sizeClaims = new Map<string, Map<string, SizeClaim>>();
  private readonly sizeOwnerListeners = new Set<(change: TerminalSizeOwnerChange) => void>();
  private readonly spawning = new Map<string, Promise<{ id: string; replay: string }>>();
  private readonly activityListeners = new Set<(event: TerminalActivityEvent) => void>();
  private sequence = 0;
  private ptyModule: Promise<typeof import('@homebridge/node-pty-prebuilt-multiarch')> | null = null;
  private disposed = false;

  /** `shellIntegrationDir`: Mixdog's own directory for shell startup files;
   *  without it only file-less integrations (PowerShell, cmd) apply. */
  constructor(private readonly options: { shellIntegrationDir?: string | null } = {}) {}

  subscribe(listener: (event: TerminalDataEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Command activity changed (see terminal-activity.ts). */
  subscribeActivity(listener: (event: TerminalActivityEvent) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  /** Every live terminal whose activity is known. */
  activitySnapshot(): TerminalActivityEvent[] {
    const events: TerminalActivityEvent[] = [];
    for (const [id, entry] of this.terminals) {
      const state = entry.activity.state;
      if (state && !entry.disposed) events.push({ id, state });
    }
    return events;
  }

  /** A view focused (or left) a terminal tab; focusing clears `finished`. */
  focus(id: string, client: string, focused: boolean): void {
    const entry = this.terminals.get(id);
    if (entry && !entry.disposed) entry.activity.setFocus(client || 'desktop', focused);
  }

  /** Ownership of a PTY's size changed (a phone claimed, released or lapsed). */
  subscribeSizeOwner(listener: (change: TerminalSizeOwnerChange) => void): () => void {
    this.sizeOwnerListeners.add(listener);
    return () => this.sizeOwnerListeners.delete(listener);
  }

  /** Who owns this PTY's size right now, if anyone. */
  sizeOwner(id: string): TerminalSizeOwner | null {
    const claims = this.sizeClaims.get(id);
    if (!claims) return null;
    let owner: TerminalSizeOwner | null = null;
    for (const [client, claim] of claims) owner = { cols: claim.cols, rows: claim.rows, owner: client };
    return owner;
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
  ): Promise<{ id: string; replay: string; sizeOwner?: TerminalSizeOwner }> {
    if (this.disposed) throw new Error('Terminal manager is disposed.');
    if (id) {
      const existing = this.terminals.get(id);
      if (existing && !existing.disposed) {
        // A view attaching while a phone owns the size must follow it.
        const sizeOwner = this.sizeOwner(id);
        return { id, replay: existing.buffer.read(), ...(sizeOwner ? { sizeOwner } : {}) };
      }
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
    const plan = planShellIntegration(
      { path: shell, args: profile?.args, env: profile?.env },
      this.options.shellIntegrationDir ?? null
    );
    const env = childEnvironment(plan.env);
    const pty = spawn(shell, plan.args, {
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
      activity: new TerminalActivityTracker(
        (state) => {
          for (const listener of this.activityListeners) listener({ id: nextId, state });
        },
        { inferStartFromSubmit: plan.integration === 'cmd' }
      ),
      ...(plan.integration ? { markers: new TerminalMarkerScanner() } : {}),
    };
    const emit = (data: string): void => {
      if (!data) return;
      entry.buffer.append(data);
      for (const listener of this.listeners) listener({ id: nextId, data });
    };
    // Text held back as a possible marker start is released if no chunk
    // follows shortly (a lone trailing ESC, say).
    let heldFlush: ReturnType<typeof setTimeout> | null = null;
    const flushHeld = (): void => {
      if (heldFlush) clearTimeout(heldFlush);
      heldFlush = null;
      if (entry.markers) emit(entry.markers.flush());
    };
    pty.onData((data) => {
      const { markers } = entry;
      if (!markers) {
        emit(data);
        return;
      }
      if (heldFlush) clearTimeout(heldFlush);
      heldFlush = null;
      const scanned = markers.scan(data);
      emit(scanned.text);
      for (const marker of scanned.markers) entry.activity.marker(marker);
      if (markers.pending) {
        heldFlush = setTimeout(() => {
          if (!entry.disposed) flushHeld();
        }, HELD_OUTPUT_FLUSH_MS);
        heldFlush.unref?.();
      }
    });
    pty.onExit(({ exitCode }) => {
      flushHeld();
      entry.disposed = true;
      entry.outputPaused = false;
      entry.activity.exit();
      emit(`\r\n[process exited with code ${exitCode}]\r\n`);
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
    if (!entry || entry.disposed) return;
    entry.pty.write(data);
    if (entry.markers) entry.activity.input(data);
  }

  /** `client` is the remote connection of a phone showing this terminal ('' =
   *  any other view). A phone's resize claims the PTY size (renewing its lease)
   *  and the newest claim owns; every other view follows it, so non-phone
   *  resizes are ignored while a claim stands. A phone call with a non-positive
   *  size releases that phone's claim; ownership then passes to the next
   *  claimant still renewing, or back to the PC. */
  resize(id: string, cols: number, rows: number, client = ''): void {
    if (client && !(cols > 0 && rows > 0)) {
      this.releaseSizeClaim(id, client);
      return;
    }
    const safeCols = Math.max(2, Math.min(500, Math.floor(cols) || 80));
    const safeRows = Math.max(2, Math.min(200, Math.floor(rows) || 24));
    if (client) {
      this.claimSize(id, client, safeCols, safeRows);
      return;
    }
    if (this.sizeClaims.has(id)) return;
    this.resizePty(id, safeCols, safeRows);
  }

  private resizePty(id: string, cols: number, rows: number): void {
    const entry = this.terminals.get(id);
    if (!entry || entry.disposed) return;
    try {
      entry.pty.resize(cols, rows);
    } catch {
      /* racing exit */
    }
  }

  private claimSize(id: string, client: string, cols: number, rows: number): void {
    const before = this.sizeOwner(id);
    let claims = this.sizeClaims.get(id);
    if (!claims) {
      claims = new Map();
      this.sizeClaims.set(id, claims);
    }
    const previous = claims.get(client);
    if (previous) clearTimeout(previous.lease);
    const lease = setTimeout(() => this.releaseSizeClaim(id, client), SIZE_OWNER_LEASE_MS);
    lease.unref();
    // Renewing keeps the claim's place in the order; only a NEW claim takes over.
    claims.set(client, { cols, rows, lease });
    this.ownerChanged(id, before);
  }

  private releaseSizeClaim(id: string, client: string): void {
    const claims = this.sizeClaims.get(id);
    const claim = claims?.get(client);
    if (!claims || !claim) return;
    const before = this.sizeOwner(id);
    clearTimeout(claim.lease);
    claims.delete(client);
    if (claims.size === 0) this.sizeClaims.delete(id);
    this.ownerChanged(id, before);
  }

  /** Applies and announces the new effective owner when it differs. */
  private ownerChanged(id: string, before: TerminalSizeOwner | null): void {
    const after = this.sizeOwner(id);
    if (before?.owner === after?.owner && before?.cols === after?.cols && before?.rows === after?.rows) return;
    if (after) this.resizePty(id, after.cols, after.rows);
    const change = { id, cols: after?.cols ?? 0, rows: after?.rows ?? 0, owner: after?.owner ?? '' };
    for (const listener of this.sizeOwnerListeners) listener(change);
  }

  private forgetSizeClaims(id: string): void {
    const claims = this.sizeClaims.get(id);
    if (!claims) return;
    for (const claim of claims.values()) clearTimeout(claim.lease);
    this.sizeClaims.delete(id);
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
    entry.activity.exit();
    try {
      entry.pty.kill();
    } catch {
      /* already gone */
    }
    this.cursorFloors.set(id, Math.max(this.cursorFloors.get(id) ?? -1, entry.buffer.cursor));
    this.terminals.delete(id);
    this.forgetSizeClaims(id);
  }

  /** Dispose every terminal whose cwd is `root` or inside it (a removed
   * managed worktree), so no PTY keeps the directory locked. Returns the ids. */
  disposeTerminalsUnder(root: string): string[] {
    const base = normalizeRoot(root);
    if (!base) return [];
    const ids: string[] = [];
    for (const [id, entry] of [...this.terminals]) {
      const cwd = entry.cwd ? normalizeRoot(entry.cwd) : '';
      if (cwd && (cwd === base || cwd.startsWith(`${base}/`))) {
        this.dispose(id);
        ids.push(id);
      }
    }
    return ids;
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
      entry.activity.dispose();
      try {
        entry.pty.kill();
      } catch {
        /* already gone */
      }
    }
    this.terminals.clear();
    for (const id of [...this.sizeClaims.keys()]) this.forgetSizeClaims(id);
    this.listeners.clear();
    this.sizeOwnerListeners.clear();
    this.activityListeners.clear();
  }
}
