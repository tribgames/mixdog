// Dock terminal view: a module-shared xterm
// instance over the main-process PTY. The xterm DOM is re-appended on
// remount so tab switches keep scrollback; the PTY survives regardless.
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { beginBootSurface, reportBootSurfaceStage } from './boot-metrics';
import { reportRendererFailure } from './RendererRecovery';
import { errorSummary } from './ErrorNotice';
import { TerminalLocalEcho } from './terminal-local-echo';
import { TerminalWritePump } from './terminal-write-pump';
import { attachTerminalOutput, detachTerminalOutput } from './terminal-output-subscription';
import { applyTerminalActivity, StableTerminalFitScheduler } from './terminal-fit';
import { dataTransferHasLocalFiles, droppedLocalPaths, terminalPathText } from './file-drag';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { onTerminalCommandRequested } from './terminal-command-request';

type TerminalView = {
  id: string | null;
  /** Profile id the live PTY was ensured with; a strip change respawns it. */
  shell?: string;
  term: Terminal;
  fit: FitAddon;
  webgl: WebglAddon | null;
  webglContextLoss: { dispose(): void } | null;
  webglUnavailable: boolean;
  writer: TerminalWritePump;
  /** Predictive local echo over the relay; null on the local desktop, where
   *  the PTY echo is effectively instant. */
  localEcho: TerminalLocalEcho | null;
  unsubscribeOutput?: (() => void) | null;
};
interface TerminalViewState {
  cols: number;
  rows: number;
  scrollY: number;
  atBottom: boolean;
}
const terminalViews = new Map<string, TerminalView>();
const DOCK_TERMINAL_KEY = '__dock__';
const TERMINAL_VIEW_STATE_KEY = 'mixdog.desktop-terminal-view.v1';

/** A per-terminal record map persisted under one storage key. Throws on
 *  unavailable or corrupt storage; every caller treats that as best-effort. */
function readStoredRecord<T>(storageKey: string): Record<string, T> {
  return JSON.parse(window.localStorage.getItem(storageKey) || '{}') as Record<string, T>;
}

function readTerminalViewState(key: string): TerminalViewState | null {
  try {
    const state = readStoredRecord<Partial<TerminalViewState>>(TERMINAL_VIEW_STATE_KEY)[key];
    if (!state || !Number.isFinite(state.cols) || !Number.isFinite(state.rows) || !Number.isFinite(state.scrollY))
      return null;
    return {
      cols: Math.max(2, Math.round(state.cols as number)),
      rows: Math.max(1, Math.round(state.rows as number)),
      scrollY: Math.max(0, Math.round(state.scrollY as number)),
      atBottom: state.atBottom === true,
    };
  } catch {
    return null;
  }
}

function writeTerminalViewState(key: string, view: TerminalView): void {
  try {
    const buffer = view.term.buffer.active;
    const stored = readStoredRecord<TerminalViewState>(TERMINAL_VIEW_STATE_KEY);
    stored[key] = {
      cols: view.term.cols,
      rows: view.term.rows,
      scrollY: buffer.viewportY,
      atBottom: buffer.viewportY >= buffer.baseY,
    };
    window.localStorage.setItem(TERMINAL_VIEW_STATE_KEY, JSON.stringify(stored));
  } catch {
    // Terminal geometry persistence is a convenience only.
  }
}

function clearTerminalViewState(key: string): void {
  try {
    const stored = readStoredRecord<TerminalViewState>(TERMINAL_VIEW_STATE_KEY);
    if (!(key in stored)) return;
    delete stored[key];
    window.localStorage.setItem(TERMINAL_VIEW_STATE_KEY, JSON.stringify(stored));
  } catch {
    // Ignore corrupt or unavailable storage.
  }
}

function fitTerminalView(view: TerminalView, restore?: TerminalViewState | null): void {
  const current =
    restore ??
    (() => {
      const buffer = view.term.buffer.active;
      return {
        cols: view.term.cols,
        rows: view.term.rows,
        scrollY: buffer.viewportY,
        atBottom: buffer.viewportY >= buffer.baseY,
      };
    })();
  view.fit.fit();
  if (current.atBottom) view.term.scrollToBottom();
  else view.term.scrollToLine(Math.min(current.scrollY, view.term.buffer.active.baseY));
}

function tryEnableWebglRenderer(view: TerminalView): void {
  if (view.webgl || view.webglUnavailable || !view.term.element) return;
  const addon = new WebglAddon();
  let contextLossDisposable: { dispose(): void } | undefined;
  try {
    contextLossDisposable = addon.onContextLoss(() => {
      contextLossDisposable?.dispose();
      if (view.webglContextLoss === contextLossDisposable) view.webglContextLoss = null;
      try {
        addon.dispose();
      } catch {
        /* already released by xterm */
      }
      if (view.webgl === addon) view.webgl = null;
      // A lost context normally means this window cannot sustain the WebGL
      // renderer. Keep xterm's built-in DOM renderer for the rest of the view
      // instead of repeatedly allocating contexts on every tab attach.
      view.webglUnavailable = true;
    });
    view.term.loadAddon(addon);
    view.webgl = addon;
    view.webglContextLoss = contextLossDisposable;
  } catch {
    contextLossDisposable?.dispose();
    try {
      addon.dispose();
    } catch {
      /* constructor/load failure */
    }
    // WebGL2 can be unavailable under remote desktop, VM, safe-mode, or a
    // blacklisted driver. xterm remains fully functional on its DOM renderer.
    view.webglUnavailable = true;
  }
}

/** Release the per-tab GL context when the terminal DOM detaches. Chromium
 * caps live WebGL contexts per renderer (~16) and evicts the oldest, which
 * permanently degraded early terminals to the DOM renderer once enough tabs
 * existed. Scrollback lives in xterm's buffer and is untouched; the next
 * attach re-enables WebGL through tryEnableWebglRenderer. */
function releaseWebglRenderer(view: TerminalView): void {
  const addon = view.webgl;
  if (!addon) return;
  // Drop the loss listener FIRST: disposing the renderer releases its context
  // via WEBGL_lose_context, and that self-inflicted loss must not mark the
  // view as permanently WebGL-unavailable.
  view.webglContextLoss?.dispose();
  view.webglContextLoss = null;
  view.webgl = null;
  try {
    addon.dispose();
  } catch {
    /* context already lost */
  }
}

function terminalView(key: string): TerminalView {
  const existing = terminalViews.get(key);
  if (existing) return existing;
  armTerminalMonoRefresh();
  const term = new Terminal({
    fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.35,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'bar',
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const writer = new TerminalWritePump(
    (data, complete) => term.write(data, complete),
    (id, charCount) => window.mixdogDesktop.termAcknowledge?.(id, charCount)
  );
  // Relay-served browsers pay a full round trip per echoed keystroke; the
  // predictor paints validated keystrokes immediately (user: RTT 때문에
  // 터미널 타이핑이 답답함). Electron's local PTY needs none of it.
  const localEcho = isRemoteHostRenderer()
    ? new TerminalLocalEcho({
        write: (data) => {
          void writer.writeReplay(data);
        },
        renderAnchor: () => {
          if (writer.hasQueuedOutput) return null;
          const buffer = term.buffer.active;
          if (buffer.type !== 'normal') return null;
          const line = buffer.getLine(buffer.baseY + buffer.cursorY);
          if (!line) return null;
          // Only end-of-line typing predicts: a mid-line insert shifts the
          // tail and cannot be rolled back with a plain erase.
          if (line.translateToString(true).length > buffer.cursorX) return null;
          return buffer.cursorX;
        },
        cols: () => term.cols,
        // One confirmed echo is enough to characterise the shell here: every
        // extra measured keystroke is a full relay round trip the typist waits
        // out with nothing on screen (user: 타이핑이 느리다). A mismatch still
        // rolls back and restarts validation, so the safety net is unchanged.
        validationStreak: 1,
      })
    : null;
  const created = {
    id: null,
    term,
    fit,
    webgl: null,
    webglContextLoss: null,
    webglUnavailable: false,
    writer,
    localEcho,
  };
  terminalViews.set(key, created);
  return created;
}

// xterm measures cell metrics (and the WebGL renderer bakes its glyph atlas)
// with whatever face is ACTIVE at open. A terminal created before JetBrains
// Mono settles keeps fallback metrics after the swap — clipped glyphs and a
// visible jump (same class as the Monaco boot shift, user report). One
// refresh when the face lands realigns every live terminal.
let terminalMonoRefreshArmed = false;
function armTerminalMonoRefresh() {
  if (terminalMonoRefreshArmed) return;
  terminalMonoRefreshArmed = true;
  try {
    void document.fonts
      .load('400 13px "JetBrains Mono Variable"')
      .then(() => {
        for (const view of terminalViews.values()) {
          try {
            view.webgl?.clearTextureAtlas();
          } catch {
            /* atlas rebuilds lazily */
          }
          try {
            view.fit.fit();
            view.term.refresh(0, Math.max(0, view.term.rows - 1));
          } catch {
            /* a detached terminal refits on its next mount */
          }
        }
      })
      .catch(() => undefined);
  } catch {
    /* font readiness stays cosmetic */
  }
}

export async function disposeTerminalPane(id: string): Promise<void> {
  const view = terminalViews.get(id);
  terminalViews.delete(id);
  clearTerminalViewState(id);
  const ptyId = view?.id || id;
  view?.localEcho?.reset();
  if (view) detachTerminalOutput(view);
  view?.writer.dispose();
  try {
    view?.term.dispose();
  } catch {
    /* already detached */
  }
  await window.mixdogDesktop.termDispose?.(ptyId);
}

// Terminals stay dark on both app themes: ANSI palettes —
// PSReadLine yellows included — assume a dark background, and a light sheet
// made typed input and the cursor unreadable (user-flagged).
// The 16 ANSI slots use the editor's dark palette instead of xterm's
// built-in Tango defaults: Tango's blue (#3465a4) and bright black sit near
// this canvas and made paths/prompts hard to read. Background stays in sync
// with --mx-terminal-bg (desktop.css).
function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function terminalTheme() {
  const background = cssVar('--mx-terminal-bg', '#121215');
  const foreground = cssVar('--mx-terminal-fg', '#e9e9e9');
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: 'rgba(255, 255, 255, .28)',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  };
}

export default function TerminalPane({
  cwd,
  terminalId,
  shell = '',
  active = true,
  onReady,
}: {
  cwd: string | null;
  terminalId?: string;
  /** Shell profile id the PTY spawns with; '' is the OS default. */
  shell?: string;
  active?: boolean;
  onReady?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fitSchedulerRef = useRef<StableTerminalFitScheduler<TerminalViewState> | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // The mount effect's ensure pipeline outlives renders; a stale captured
  // `active` skipped the boot-complete focus when the tab activated while
  // the PTY was still spawning (cold entry via Ctrl+Arrow).
  const activeRef = useRef(active);
  activeRef.current = active;
  const key = terminalId || DOCK_TERMINAL_KEY;
  const [droppingPaths, setDroppingPaths] = useState(false);
  beginBootSurface('terminal', key);
  reportBootSurfaceStage('terminal', key, 'module');
  useEffect(() => {
    const container = host.current;
    if (!container) return undefined;
    let disposed = false;
    let stopCommands: (() => void) | undefined;
    let observer: ResizeObserver | undefined;
    let dataDisposable: { dispose(): void } | undefined;
    let scrollDisposable: { dispose(): void } | undefined;
    let revealTimer = 0;
    let persistTimer = 0;
    let retryTimer = 0;
    let retryDelay = 1000;
    let noticeShown = false;
    let ensureInFlight: Promise<void> | null = null;
    let pendingRestore: TerminalViewState | null = null;
    const view = terminalView(key);
    const { term } = view;
    const schedulePersist = () => {
      window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(() => {
        persistTimer = 0;
        if (!disposed) writeTerminalViewState(key, view);
      }, 120);
    };
    const fitScheduler = new StableTerminalFitScheduler<TerminalViewState>({
      isActive: () => !disposed && activeRef.current,
      isMeasurable: () => {
        const rect = container.getBoundingClientRect();
        return rect.width >= 1 && rect.height >= 1;
      },
      currentGrid: () => ({ cols: term.cols, rows: term.rows }),
      proposeGrid: () => view.fit.proposeDimensions() ?? null,
      fit: (restore) => fitTerminalView(view, restore),
      emitResize: ({ cols, rows }) => {
        if (view.id) window.mixdogDesktop.termResize?.(view.id, cols, rows);
      },
      onSettled: () => {
        writeTerminalViewState(key, view);
        if (view.id && term.element?.querySelector('.xterm-screen')) {
          onReadyRef.current?.();
        }
      },
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id),
    });
    fitSchedulerRef.current = fitScheduler;
    if (term.element) container.appendChild(term.element);
    else term.open(container);
    if (activeRef.current) tryEnableWebglRenderer(view);
    // Focus at ATTACH time, not after the PTY round trip. A phone raises its
    // keypad only for a focus that still sits inside the opening tap's
    // activation window, so waiting for termEnsure() + replay + fit made the
    // keyboard arrive seconds later and shove the layout a SECOND time
    // (user: 터미널 열리고 키패드가 늦게 올라온다). The post-ensure and
    // activation focus calls stay as fallbacks for a cold or failed attach.
    if (activeRef.current) {
      try {
        term.focus();
      } catch {
        /* element not measurable yet */
      }
    }
    // PTY ensure/replay can be slow. Revealing xterm's empty shell first let
    // the replayed scrollback visibly dump into an already-open terminal
    // (user: PANE 최초 진입 시 스크립트가 튐). Keep PaneSurfaceGate's opaque
    // cover up until the replay buffer is written and the first fit has run —
    // the ensure path fires onReady right after that. This timer only guards
    // a stalled PTY host so the gate can never hang on a blank pane.
    revealTimer = window.setTimeout(() => {
      revealTimer = 0;
      if (!disposed && term.element?.querySelector('.xterm-screen')) {
        onReadyRef.current?.();
      }
    }, 1_500);
    scrollDisposable = term.onScroll(schedulePersist);
    const runEnsure = async () => {
      // A strip shell change respawns THIS tab's PTY: dispose the old
      // process, clear the scrollback, and let ensure() below create the
      // replacement under the same terminal id (tab identity holds).
      if (view.id && view.shell !== undefined && view.shell !== shell) {
        const previous = view.id;
        view.id = null;
        clearTerminalViewState(key);
        view.localEcho?.reset();
        try {
          term.reset();
        } catch {
          /* fresh spawn repaints anyway */
        }
        await window.mixdogDesktop.termDispose?.(previous);
      }
      const ensured = await window.mixdogDesktop.termEnsure?.(view.id ?? terminalId ?? null, cwd, shell || null);
      reportBootSurfaceStage('terminal', key, 'data', ensured ? 'pty-ready' : 'shell-only');
      if (!ensured) {
        if (!disposed) onReadyRef.current?.();
        return;
      }
      if (disposed) {
        // A final session release removes the shared view while ensure() is in
        // flight. Dispose the actual generated PTY id once it arrives.
        if (terminalViews.get(key) !== view) {
          await window.mixdogDesktop.termDispose?.(ensured.id);
        }
        return;
      }
      const isNewPty = view.id !== ensured.id;
      view.id = ensured.id;
      view.shell = shell;
      if (isNewPty) fitScheduler.invalidateResize();
      let replayWrite: Promise<void> | null = null;
      if (isNewPty && ensured.replay) {
        pendingRestore = readTerminalViewState(key);
        if (pendingRestore) term.resize(pendingRestore.cols, pendingRestore.rows);
        view.localEcho?.reset();
        replayWrite = view.writer.writeReplay(ensured.replay);
      } else if (isNewPty) {
        // A restored tab backed by a fresh PTY must not inherit the old
        // process's viewport position.
        clearTerminalViewState(key);
      }
      // A retry after a failed attempt must not stack a second subscription
      // or key handler onto the same view.
      attachTerminalOutput(view, window.mixdogDesktop.subscribeTermData);
      dataDisposable ??= term.onData((data) => {
        if (!view.id) return;
        view.localEcho?.onInput(data);
        window.mixdogDesktop.termWrite?.(view.id, data);
      });
      if (replayWrite) await replayWrite;
      if (disposed) return;
      // A command a chat code block sent to this terminal is entered once the
      // PTY is attached, including one sent before the pane existed.
      stopCommands ??= onTerminalCommandRequested(key, (input) => {
        if (view.id) window.mixdogDesktop.termWrite?.(view.id, input);
      });
      // Restored split ratios settle in the commit before this frame. Fitting
      // earlier leaves xterm with the startup pane's stale row count and a
      // malformed viewport scrollbar.
      if (pendingRestore) {
        fitScheduler.schedule(pendingRestore);
        pendingRestore = null;
      } else {
        fitScheduler.schedule();
      }
      if (!observer) {
        observer = new ResizeObserver(() => fitScheduler.schedule());
        observer.observe(container);
        const surface = container.parentElement;
        if (surface) observer.observe(surface);
        const persistentRoot = container.closest<HTMLElement>('.session-terminal-surface-container');
        if (persistentRoot && persistentRoot !== surface) {
          observer.observe(persistentRoot);
        }
      }
      if (activeRef.current) term.focus();
    };
    // The PTY host can be down (worker exit, ensure timeout, spawn failure).
    // Surface it once, reveal the pane, and keep retrying: TerminalHost
    // lazily respawns its worker on the next ensure().
    const attemptEnsure = () => {
      if (disposed || ensureInFlight) return;
      ensureInFlight = runEnsure();
      void ensureInFlight
        .catch((error: unknown) => {
          if (disposed) return;
          // Notice/reveal are best-effort (the terminal may already be
          // disposed); retry scheduling must always run.
          if (!noticeShown) {
            noticeShown = true;
            // Name the concrete failure. A bare "unavailable" hid a missing
            // native PTY binding behind an endless retry loop.
            const detail = errorSummary(error);
            try {
              term.write(
                `\r\n\x1b[31mterminal service unavailable${detail ? ` — ${detail}` : ''} — retrying…\x1b[0m\r\n`
              );
            } catch {
              /* xterm disposed mid-failure */
            }
            // A dead PTY host left NO trace in the desktop diagnostics log, so
            // a terminal that never opened could only be diagnosed live.
            reportRendererFailure('unhandled-rejection', error, {
              components: ['TerminalPane'],
              failureCode: 'terminal-pty-unavailable',
            });
          }
          try {
            onReadyRef.current?.();
          } catch {
            /* gate consumer threw */
          }
          retryTimer = window.setTimeout(() => {
            retryTimer = 0;
            if (!disposed) attemptEnsure();
          }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 5000);
        })
        .finally(() => {
          ensureInFlight = null;
        });
    };
    const onRemoteReconnected = () => {
      if (retryTimer) {
        window.clearTimeout(retryTimer);
        retryTimer = 0;
      }
      retryDelay = 1000;
      view.localEcho?.reset();
      attemptEnsure();
    };
    window.addEventListener('mixdog:remote-reconnected', onRemoteReconnected);
    attemptEnsure();
    return () => {
      disposed = true;
      window.removeEventListener('mixdog:remote-reconnected', onRemoteReconnected);
      fitScheduler.dispose();
      if (fitSchedulerRef.current === fitScheduler) fitSchedulerRef.current = null;
      window.clearTimeout(revealTimer);
      window.clearTimeout(persistTimer);
      if (retryTimer) window.clearTimeout(retryTimer);
      writeTerminalViewState(key, view);
      stopCommands?.();
      observer?.disconnect();
      dataDisposable?.dispose();
      scrollDisposable?.dispose();
      // A hidden tab must not hold a GPU context; reattach re-enables WebGL.
      releaseWebglRenderer(view);
      // The xterm DOM node stays alive for the next attach; only detach it.
      if (term.element?.parentElement === container) container.removeChild(term.element);
    };
  }, [cwd, key, shell, terminalId]);
  useEffect(() => {
    const view = terminalViews.get(key);
    applyTerminalActivity(active, {
      enableRenderer: () => {
        if (view) tryEnableWebglRenderer(view);
      },
      releaseRenderer: () => {
        if (view) releaseWebglRenderer(view);
      },
      scheduleFit: () => fitSchedulerRef.current?.schedule(),
      pauseFit: () => fitSchedulerRef.current?.pause(),
      focus: () => {
        try {
          view?.term.focus();
        } catch {
          /* disposed mid-activation */
        }
      },
    });
    return undefined;
  }, [active, key]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop file target; the terminal surface is not a control
    <div
      className="dock-terminal-surface"
      data-dropping={droppingPaths ? 'true' : undefined}
      onDragEnter={(event) => {
        if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        setDroppingPaths(true);
      }}
      onDragOver={(event) => {
        if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        setDroppingPaths(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDroppingPaths(false);
      }}
      onDrop={(event) => {
        if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        setDroppingPaths(false);
        const paths = droppedLocalPaths(event.dataTransfer);
        const text = terminalPathText(paths);
        if (!text) return;
        const view = terminalView(key);
        view.term.paste(text);
        view.term.focus();
      }}
    >
      <div className="dock-terminal" ref={host} />
    </div>
  );
}
