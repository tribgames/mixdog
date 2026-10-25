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
import { TerminalImeGuard } from './terminal-ime-guard';

const IS_LINUX =
  typeof navigator !== 'undefined' && /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
import { TerminalWritePump } from './terminal-write-pump';
import { trackReplay, viewPaintsAtOnce } from './terminal-replay-state';
import { createTerminalConnectGate, type TerminalConnectMode } from './terminal-connect-gate';
import { attachTerminalOutput, detachTerminalOutput } from './terminal-output-subscription';
import { applyTerminalActivity, StableTerminalFitScheduler } from './terminal-fit';
import { dataTransferHasLocalFiles, droppedLocalPaths, terminalPathText } from './file-drag';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { markTerminalShown, onTerminalCommandRequested } from './terminal-command-request';
import {
  CONNECTION_REATTACHED_EVENT,
  connectionLinkView,
  isConnectionDown,
  useConnectionLink,
} from './connection-link-store';
import { t } from './i18n';
import { isMobileRemoteSurface, useMobileRemoteSurface } from './mobile-surface';
import { TerminalKeyBar } from './TerminalKeyBar';
import {
  applyTerminalModifiers,
  forgetTerminalModifiers,
  terminalBarSequence,
  terminalModifiers,
  type TerminalBarKey,
} from './terminal-key-bar';
import {
  applyEnsuredSizeOwner,
  applySizeOwner,
  sendSizeOwnerHeartbeat,
  sendSizeOwnerRelease,
} from './terminal-size-owner';

/** Quiet period before a layout change re-fits and resizes the PTY. */
const FIT_DEBOUNCE_MS = 50;
/** A phone re-claims the PTY size this often; the host's lease is 30s. */
const SIZE_OWNER_HEARTBEAT_MS = 10_000;

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
  /** Grid a phone owns for this PTY; this view follows it instead of fitting. */
  followSize: { cols: number; rows: number } | null;
  /** Re-fits the mounted pane after the phone gives the size back. */
  refit: (() => void) | null;
  /** Typed-input path (modifiers, local echo, PTY write) for bar keys. */
  sendInput: ((data: string) => void) | null;
  /** A prewarm's attach in flight (prewarmTerminal). */
  warming: Promise<boolean> | null;
  /** Prewarmed for a pane about to open: its parked mount takes the GPU
   *  renderer the open would, so the opening frame keeps the drawn screen. */
  warmed: boolean;
  /** The saved viewport a prewarmed replay restores at its first fit. */
  warmRestore: TerminalViewState | null;
  /** A scrollback replay still being written into `term` (trackReplay): the
   *  screen is not complete until it settles, whoever started it. */
  replayPending: Promise<void> | null;
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
/** How long a hidden terminal keeps its WebGL context (see the activity effect). */
const TERMINAL_RENDERER_RELEASE_DELAY_MS = 5_000;

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
  if (view.followSize) view.term.resize(view.followSize.cols, view.followSize.rows);
  else view.fit.fit();
  if (current.atBottom) view.term.scrollToBottom();
  else view.term.scrollToLine(Math.min(current.scrollY, view.term.buffer.active.baseY));
}

let unwatchSizeOwner: (() => void) | undefined;
function watchTerminalSizeOwner(): void {
  if (unwatchSizeOwner) return;
  unwatchSizeOwner =
    window.mixdogDesktop.subscribeTermSizeOwner?.((event) => {
      for (const view of terminalViews.values()) {
        if (view.id === event.id) applySizeOwner(view, event);
      }
    }) ?? (() => {});
}

function tryEnableWebglRenderer(view: TerminalView): void {
  if (view.webgl || view.webglUnavailable || !view.term.element) return;
  // A phone keeps xterm's DOM renderer: at a fractional device pixel ratio
  // the WebGL canvas kept a CSS-pixel backing store while its glyph atlas was
  // drawn at device pixels, so the prompt painted ~3x large and cut off at the
  // sheet's left edge. A phone-sized grid gains nothing from the GPU path.
  if (isMobileRemoteSurface()) return;
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
  const created: TerminalView = {
    id: null,
    term,
    fit,
    webgl: null,
    webglContextLoss: null,
    webglUnavailable: false,
    writer,
    localEcho,
    followSize: null,
    refit: null,
    sendInput: null,
    warming: null,
    warmed: false,
    warmRestore: null,
    replayPending: null,
  };
  terminalViews.set(key, created);
  watchTerminalSizeOwner();
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
            if (!view.followSize) view.fit.fit();
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

/** The tab's terminal paints complete in its mount frame: this renderer holds
 *  its screen (a live view whose replay is fully written), or it never ran (no
 *  saved view, so no scrollback to replay). The same rule lets the mount
 *  report ready at once. A replay still being written is never complete. */
export function terminalPaintsAtOnce(terminalId: string): boolean {
  return viewPaintsAtOnce(terminalViews.get(terminalId), Boolean(readTerminalViewState(terminalId)));
}

/** Attaches a tab's PTY before its pane mounts (the dock toggle's hover,
 *  focus or touch-down) when that PTY is already running: its scrollback
 *  replays into the view and its output streams there, so the pane that
 *  mounts next holds the screen and paints it in its first frame
 *  (terminalPaintsAtOnce) instead of a loading cover. Attach-only: a shell
 *  that never started or has exited stays so (resolves false) — a warm-up
 *  never starts or changes a process. A tab this renderer already holds
 *  resolves true; one being warmed shares that attach. */
export function prewarmTerminal(terminalId: string): Promise<boolean> {
  const view = terminalView(terminalId);
  if (view.id) return Promise.resolve(true);
  if (connectionLinkView()?.terminalsAvailable === false) return Promise.resolve(false);
  view.warming ??= (async () => {
    const attached = await window.mixdogDesktop.termAttach?.(terminalId);
    // Released meanwhile, or attached by a pane that mounted first.
    if (terminalViews.get(terminalId) !== view) return false;
    if (view.id) return true;
    if (!attached) return false;
    view.id = attached.id;
    applyEnsuredSizeOwner(view, attached.sizeOwner);
    let replayWrite: Promise<void> | null = null;
    if (attached.replay) {
      view.warmRestore = readTerminalViewState(terminalId);
      if (view.warmRestore) view.term.resize(view.warmRestore.cols, view.warmRestore.rows);
      view.localEcho?.reset();
      replayWrite = trackReplay(view, attached.replay);
    } else {
      clearTerminalViewState(terminalId);
    }
    attachTerminalOutput(view, window.mixdogDesktop.subscribeTermData);
    view.warmed = true;
    await replayWrite;
    return true;
  })()
    .catch(() => false)
    .finally(() => {
      view.warming = null;
    });
  return view.warming;
}

export async function disposeTerminalPane(id: string): Promise<void> {
  const view = terminalViews.get(id);
  terminalViews.delete(id);
  clearTerminalViewState(id);
  forgetTerminalModifiers(id);
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
  attachOnly = false,
  onReady,
}: {
  cwd: string | null;
  terminalId?: string;
  /** Shell profile id the PTY spawns with; '' is the OS default. */
  shell?: string;
  active?: boolean;
  /** Warm-up mount: attach to the PTY only if it is already running
   *  (termAttach), never start, respawn or dispose one. The first render
   *  without it (the real open) runs the usual ensure (terminal-connect-gate). */
  attachOnly?: boolean;
  onReady?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fitSchedulerRef = useRef<StableTerminalFitScheduler<TerminalViewState> | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const attachOnlyRef = useRef(attachOnly);
  attachOnlyRef.current = attachOnly;
  /** The real open of a warm-up mount (set by the mount effect). */
  const openRef = useRef<(() => void) | null>(null);
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
    let imeDetach: (() => void) | undefined;
    let scrollDisposable: { dispose(): void } | undefined;
    let revealTimer = 0;
    let persistTimer = 0;
    let retryTimer = 0;
    let retryDelay = 1000;
    let noticeShown = false;
    let pendingRestore: TerminalViewState | null = null;
    let replayOnReattach = false;
    const view = terminalView(key);
    const { term } = view;
    const modifiers = terminalModifiers(key);
    let fitDebounce = 0;
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
      proposeGrid: () => view.followSize ?? view.fit.proposeDimensions() ?? null,
      fit: (restore) => fitTerminalView(view, restore),
      emitResize: ({ cols, rows }) => {
        // A followed grid is the phone's: never send it back as our own.
        if (view.id && !view.followSize)
          window.mixdogDesktop.termResize?.(view.id, cols, rows, isMobileRemoteSurface());
      },
      onSettled: () => {
        writeTerminalViewState(key, view);
        // A replay still being written is not a ready screen; its own fit,
        // once written, settles again.
        if (view.id && !view.replayPending && term.element?.querySelector('.xterm-screen')) {
          onReadyRef.current?.();
        }
      },
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id),
    });
    fitSchedulerRef.current = fitScheduler;
    const refit = () => {
      fitScheduler.invalidateResize();
      fitScheduler.schedule();
    };
    view.refit = refit;
    // Phone: send the PTY ensure before the blocking xterm attach so the
    // relay round trip overlaps it instead of following it.
    let earlyEnsure: ReturnType<NonNullable<typeof window.mixdogDesktop.termEnsure>> | null = null;
    if (!attachOnlyRef.current && isMobileRemoteSurface() && connectionLinkView()?.terminalsAvailable !== false) {
      earlyEnsure = window.mixdogDesktop.termEnsure?.(view.id ?? terminalId ?? null, cwd, shell || null) ?? null;
      earlyEnsure?.catch(() => {});
    }
    if (term.element) container.appendChild(term.element);
    else term.open(container);
    if (activeRef.current || view.warmed) tryEnableWebglRenderer(view);
    view.warmed = false;
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
    // Nothing can dump in, though, when this renderer already holds the tab's
    // screen (view.id) or the tab never ran (no saved view, so no scrollback
    // to replay): the frame and the cursor line show at once, fitted, and the
    // prompt prints into them as it arrives.
    if (terminalPaintsAtOnce(key)) {
      fitScheduler.schedule(view.warmRestore);
      view.warmRestore = null;
      if (term.element?.querySelector('.xterm-screen')) onReadyRef.current?.();
    }
    revealTimer = window.setTimeout(() => {
      revealTimer = 0;
      if (!disposed && term.element?.querySelector('.xterm-screen')) {
        onReadyRef.current?.();
      }
    }, 1_500);
    scrollDisposable = term.onScroll(schedulePersist);
    const runEnsure = async (mode: TerminalConnectMode) => {
      const shellChanged = Boolean(view.id) && view.shell !== undefined && view.shell !== shell;
      // A warm-up never respawns: the open's ensure applies the shell change.
      if (mode === 'attach' && shellChanged) return;
      // A strip shell change respawns THIS tab's PTY: dispose the old
      // process, clear the scrollback, and let ensure() below create the
      // replacement under the same terminal id (tab identity holds).
      const early = shellChanged ? null : earlyEnsure;
      earlyEnsure = null;
      if (shellChanged && view.id) {
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
      const ensureNow = () => window.mixdogDesktop.termEnsure?.(view.id ?? terminalId ?? null, cwd, shell || null);
      let ensured: Awaited<ReturnType<typeof ensureNow>> | null | undefined;
      if (early) ensured = await early;
      else if (mode === 'attach') {
        ensured = await window.mixdogDesktop.termAttach?.(view.id || terminalId || key);
        // Not running: the open's ensure starts it.
        if (!ensured) return;
      } else ensured = await ensureNow();
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
      // A server window back from an outage missed the output in between:
      // the same PTY's replay redraws it from a clean screen.
      const reattached = replayOnReattach && !isNewPty;
      replayOnReattach = false;
      view.id = ensured.id;
      // Attaching to a PTY a phone already sizes: follow it from the start. A
      // phone attaching takes the size over instead (its first fit claims it).
      // An answer without `sizeOwner` says nobody owns it: a follower that
      // missed the release (e.g. across a reconnect) stops following.
      // Phones reconcile too: a phone only follows another phone's live claim,
      // and clearing a stale follow lets its refit send a fresh claim.
      applyEnsuredSizeOwner(view, ensured.sizeOwner);
      view.shell = shell;
      if (isNewPty) fitScheduler.invalidateResize();
      // A warm-up's replay still being written (opened mid-replay) finishes
      // before this pane fits and reports ready, with its saved viewport.
      let replayWrite: Promise<void> | null = view.replayPending;
      if (replayWrite && view.warmRestore) {
        pendingRestore = view.warmRestore;
        view.warmRestore = null;
      }
      if (isNewPty && ensured.replay) {
        pendingRestore = readTerminalViewState(key);
        if (pendingRestore) term.resize(pendingRestore.cols, pendingRestore.rows);
        view.localEcho?.reset();
        replayWrite = trackReplay(view, ensured.replay);
      } else if (isNewPty) {
        // A restored tab backed by a fresh PTY must not inherit the old
        // process's viewport position.
        clearTerminalViewState(key);
      } else if (reattached && ensured.replay) {
        view.localEcho?.reset();
        try {
          term.reset();
        } catch {
          /* disposed mid-reattach */
        }
        replayWrite = trackReplay(view, ensured.replay);
      }
      // A retry after a failed attempt must not stack a second subscription
      // or key handler onto the same view.
      attachTerminalOutput(view, window.mixdogDesktop.subscribeTermData);
      const sendToPty = (rawData: string) => {
        if (!view.id) return;
        // Armed phone Ctrl/Alt apply to the next input, typed or from the bar.
        const data = applyTerminalModifiers(rawData, modifiers.take());
        view.localEcho?.onInput(data);
        window.mixdogDesktop.termWrite?.(view.id, data);
      };
      view.sendInput = sendToPty;
      // ibus/Linux IME commits reach xterm's onData several times; the guard
      // sends each commit once and keeps xterm from re-reading it.
      const imeGuard = IS_LINUX && term.textarea ? new TerminalImeGuard(sendToPty, term.textarea) : null;
      if (imeGuard && term.element) imeDetach ??= imeGuard.attach(term.element);
      dataDisposable ??= term.onData((data) => {
        const out = imeGuard ? imeGuard.filter(data) : data;
        if (out !== '') sendToPty(out);
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
        // A soft keyboard or sheet slide fires a burst of observations; fit
        // (and the PTY resize it emits) once the layout has been quiet.
        observer = new ResizeObserver(() => {
          window.clearTimeout(fitDebounce);
          fitDebounce = window.setTimeout(() => {
            fitDebounce = 0;
            fitScheduler.schedule();
          }, FIT_DEBOUNCE_MS);
        });
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
    const connectGate = createTerminalConnectGate(attachOnlyRef.current, (mode) => {
      if (disposed || connectionLinkView()?.terminalsAvailable === false) return Promise.resolve();
      return runEnsure(mode).catch((error: unknown) => {
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
      });
    });
    const attemptEnsure = () => {
      if (disposed || connectionLinkView()?.terminalsAvailable === false) return;
      connectGate.connect();
    };
    const onRemoteReconnected = () => {
      if (retryTimer) {
        window.clearTimeout(retryTimer);
        retryTimer = 0;
      }
      retryDelay = 1000;
      view.localEcho?.reset();
      // The new connection holds none of this phone's size claims.
      refit();
      attemptEnsure();
    };
    const onConnectionReattached = () => {
      replayOnReattach = true;
      onRemoteReconnected();
    };
    openRef.current = () => {
      if (!disposed) connectGate.open();
    };
    window.addEventListener('mixdog:remote-reconnected', onRemoteReconnected);
    window.addEventListener(CONNECTION_REATTACHED_EVENT, onConnectionReattached);
    // A server without terminals: the pane says so instead of retrying.
    if (connectionLinkView()?.terminalsAvailable !== false) attemptEnsure();
    else onReadyRef.current?.();
    return () => {
      disposed = true;
      openRef.current = null;
      window.removeEventListener('mixdog:remote-reconnected', onRemoteReconnected);
      window.removeEventListener(CONNECTION_REATTACHED_EVENT, onConnectionReattached);
      window.clearTimeout(fitDebounce);
      fitScheduler.dispose();
      if (fitSchedulerRef.current === fitScheduler) fitSchedulerRef.current = null;
      if (view.refit === refit) view.refit = null;
      view.sendInput = null;
      window.clearTimeout(revealTimer);
      window.clearTimeout(persistTimer);
      if (retryTimer) window.clearTimeout(retryTimer);
      writeTerminalViewState(key, view);
      stopCommands?.();
      observer?.disconnect();
      dataDisposable?.dispose();
      imeDetach?.();
      scrollDisposable?.dispose();
      // A hidden tab must not hold a GPU context; reattach re-enables WebGL.
      releaseWebglRenderer(view);
      // The xterm DOM node stays alive for the next attach; only detach it.
      if (term.element?.parentElement === container) container.removeChild(term.element);
    };
  }, [cwd, key, shell, terminalId]);
  // The warm-up ends (the real open): the ensure runs whatever the warm-up
  // found, since a shell it attached to can have exited since.
  useEffect(() => {
    if (!attachOnly) openRef.current?.();
  }, [attachOnly]);
  // A pane showing this terminal is how the agent's `terminal` run learns it
  // is on screen; the process itself never depends on the pane.
  useEffect(() => (active && !attachOnly ? markTerminalShown(key) : undefined), [active, attachOnly, key]);
  useEffect(() => {
    const view = terminalViews.get(key);
    let releaseTimer = 0;
    applyTerminalActivity(active, {
      enableRenderer: () => {
        if (view) tryEnableWebglRenderer(view);
      },
      // Releasing the GL context swaps xterm to its DOM renderer, which
      // measures the cell box: a forced layout of the whole window inside the
      // commit that hides the terminal. The hidden terminal keeps its context
      // for a while; a reopen inside that window reuses it.
      releaseRenderer: () => {
        releaseTimer = window.setTimeout(() => {
          if (view) releaseWebglRenderer(view);
        }, TERMINAL_RENDERER_RELEASE_DELAY_MS);
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
    return () => window.clearTimeout(releaseTimer);
  }, [active, key]);
  const phoneLayout = useMobileRemoteSurface();
  // While the phone shows this terminal its grid is the PTY's: renew the claim
  // for the host's lease, and hand the size back (so the PC fits its own pane
  // again) the moment the phone stops showing it.
  useEffect(() => {
    if (!active || !phoneLayout) return undefined;
    const beat = window.setInterval(() => {
      const view = terminalViews.get(key);
      if (!view?.id) return;
      // Renew with THIS phone's fitted grid: while it follows another phone
      // its xterm holds that phone's size, but its own claim stays current so
      // ownership can pass back to it.
      const grid = view.fit.proposeDimensions() ?? view.term;
      sendSizeOwnerHeartbeat(window.mixdogDesktop, view.id, grid.cols, grid.rows);
    }, SIZE_OWNER_HEARTBEAT_MS);
    return () => {
      window.clearInterval(beat);
      fitSchedulerRef.current?.invalidateResize();
      const view = terminalViews.get(key);
      if (view?.id) sendSizeOwnerRelease(window.mixdogDesktop, view.id);
    };
  }, [active, key, phoneLayout]);
  const serverLink = useConnectionLink();
  const modifiers = terminalModifiers(key);
  const sendBarKey = (barKey: TerminalBarKey) => {
    const view = terminalViews.get(key);
    view?.sendInput?.(terminalBarSequence(barKey, view.term.modes.applicationCursorKeysMode));
  };
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
      {serverLink?.terminalsAvailable === false ? (
        <div className="terminal-connection-note" data-kind="unavailable" role="note">
          {t('Terminals are not available on this server.')}
        </div>
      ) : isConnectionDown(serverLink) ? (
        <div className="terminal-connection-note" role="status">
          {t('Disconnected — reconnecting…')}
        </div>
      ) : null}
      {phoneLayout && active ? <TerminalKeyBar modifiers={modifiers} onKey={sendBarKey} /> : null}
    </div>
  );
}
