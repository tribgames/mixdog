// Dock terminal view: mounts xterm while a pane shows the terminal and
// releases xterm, its addons, write pump and DOM on unmount while keeping
// the core PTY alive; reopening restores output from the core's PTY replay.
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { beginBootSurface, reportBootSurfaceStage } from './boot-metrics';
import { reportRendererFailure } from './RendererRecovery';
import { errorSummary } from './ErrorNotice';
import { TerminalLocalEcho } from './terminal-local-echo';
import { discardUnopenedView } from './terminal-view-discard';
import { TerminalImeGuard } from './terminal-ime-guard';
import { attachTerminalClipboardKeys } from './terminal-clipboard-keys';
import { copyTextToClipboard } from './text-format';

const IS_LINUX =
  typeof navigator !== 'undefined' && /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
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
import { emptyStateHost } from './empty-state-host';

/** Quiet period before a layout change re-fits and resizes the PTY. */
const FIT_DEBOUNCE_MS = 50;
/** A phone re-claims the PTY size this often; the host's lease is 30s. */
const SIZE_OWNER_HEARTBEAT_MS = 10_000;

type TerminalView = {
  id: string | null;
  /** Authoritative terminal-feed snapshot generation last rendered into `term`. */
  feedGen: number | null;
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
  /** Live ensure/attach calls currently binding this view; closes the gap
   *  between API settlement and `view.id` assignment during mount handoff. */
  inflightAttachCount: number;
  /** Attached PTY ids handed off from an outgoing view while this view is
   *  still binding; detached automatically if this view fails or unmounts unbound. */
  handedOffPtyIds: Set<string>;
  /** Aborted when this view is released so its own stalled ensure/attach releases
   *  its API inflight token immediately instead of deferring detach. */
  abortController: AbortController;
  /** Set only when the tab/session itself is explicitly closed (disposeTerminalPane). */
  ptyDisposed: boolean;
};
interface TerminalViewState {
  cols: number;
  rows: number;
  scrollY: number;
  atBottom: boolean;
}
const terminalViews = new Map<string, TerminalView>();
/** Last ensured shell profile per live tab so a shell change respawns its PTY even across remounts. */
const terminalShells = new Map<string, string>();
/** Views with an ensure/attach call in flight so an explicit close can dispose a late PTY answer. */
const inflightViews = new Map<string, Set<TerminalView>>();
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

function unwatchTerminalSizeOwnerIfEmpty(): void {
  if (terminalViews.size > 0 || !unwatchSizeOwner) return;
  unwatchSizeOwner();
  unwatchSizeOwner = undefined;
}

function trackInflightView(key: string, view: TerminalView): () => void {
  let set = inflightViews.get(key);
  if (!set) {
    set = new Set();
    inflightViews.set(key, set);
  }
  set.add(view);
  return () => {
    set.delete(view);
    if (set.size === 0) inflightViews.delete(key);
  };
}

function hasActiveTerminalConsumer(ptyId: string, excluding?: TerminalView): boolean {
  for (const other of terminalViews.values()) {
    if (other !== excluding && !other.ptyDisposed && other.id === ptyId) return true;
  }
  return false;
}

/** Transfers feed ownership of `ptyId` to a live consumer (bound or actively binding for `key`),
 *  or detaches it immediately if no consumer will read it. */
function handOffOrDetachPty(key: string, ptyId: string, excluding?: TerminalView): void {
  if (hasActiveTerminalConsumer(ptyId, excluding)) return;
  const current = terminalViews.get(key);
  if (current && current !== excluding && !current.ptyDisposed && current.inflightAttachCount > 0) {
    current.handedOffPtyIds.add(ptyId);
    return;
  }
  window.mixdogDesktop.termDetach?.(ptyId);
}

/** Releases any handed-off PTYs that `view` did not end up binding once its attach calls settle. */
function flushUnboundHandedOffPtys(key: string, view: TerminalView): void {
  if (view.inflightAttachCount > 0 || view.handedOffPtyIds.size === 0) return;
  const pending = [...view.handedOffPtyIds];
  view.handedOffPtyIds.clear();
  if (view.ptyDisposed) return;
  for (const ptyId of pending) {
    if (view.id !== ptyId) handOffOrDetachPty(key, ptyId, view);
  }
}

type AbortableTerminalDesktop = {
  termEnsure?: (
    id: string | null,
    cwd?: string | null,
    shell?: string | null,
    signal?: AbortSignal
  ) => ReturnType<NonNullable<typeof window.mixdogDesktop.termEnsure>>;
  termAttach?: (id: string, signal?: AbortSignal) => ReturnType<NonNullable<typeof window.mixdogDesktop.termAttach>>;
  termAcknowledge?: (id: string, charCount: number, gen?: number) => void;
  subscribeTabTermData?: (
    id: string,
    listener: (event: { id: string; data: string; reset?: true }, gen?: number) => void
  ) => () => void;
  isTerminalAttached?: (id: string) => boolean;
  terminalFeedGeneration?: (id: string) => number | null;
  terminalSessionGeneration?: (session: unknown) => number | null;
};

function callTermEnsure(id: string | null, cwd: string | null, shell: string | null, signal: AbortSignal) {
  return (window.mixdogDesktop as AbortableTerminalDesktop).termEnsure?.(id, cwd, shell, signal);
}

function callTermAttach(id: string, signal: AbortSignal) {
  return (window.mixdogDesktop as AbortableTerminalDesktop).termAttach?.(id, signal);
}

function isTerminalFeedAttached(id: string): boolean {
  const check = (window.mixdogDesktop as AbortableTerminalDesktop).isTerminalAttached;
  return typeof check === 'function' ? check(id) : true;
}

function getTerminalFeedGeneration(id: string): number | null | undefined {
  const check = (window.mixdogDesktop as AbortableTerminalDesktop).terminalFeedGeneration;
  return typeof check === 'function' ? check(id) : undefined;
}

function getTerminalSessionGeneration(session: unknown): number | null | undefined {
  const check = (window.mixdogDesktop as AbortableTerminalDesktop).terminalSessionGeneration;
  return typeof check === 'function' ? check(session) : undefined;
}

function subscribeViewTermData(view: TerminalView) {
  const desktop = window.mixdogDesktop as AbortableTerminalDesktop;
  const subscribeTab = desktop.subscribeTabTermData;
  const subscribe = window.mixdogDesktop.subscribeTermData as
    | ((listener: (event: { id: string; data: string; reset?: true }, gen?: number) => void) => () => void)
    | undefined;
  if (!subscribeTab && !subscribe) return undefined;
  return (listener: (event: { id: string; data: string; reset?: true }, gen?: number) => void) => {
    const wrapped = (event: { id: string; data: string; reset?: true }, gen?: number) => {
      if (event.reset === true && event.id === view.id) {
        const currentGen = getTerminalFeedGeneration(event.id);
        if (typeof currentGen === 'number') view.feedGen = currentGen;
      }
      listener(event, gen);
    };
    if (subscribeTab && view.id) return subscribeTab(view.id, wrapped);
    return subscribe!(wrapped);
  };
}

/** Releases xterm, addons, write pump and DOM without terminating the backend PTY when `keepPtyAlive` is true. */
function releaseTerminalView(key: string, view: TerminalView, keepPtyAlive: boolean): void {
  if (terminalViews.get(key) === view) terminalViews.delete(key);
  if (keepPtyAlive) view.abortController.abort();
  const owned = new Set<string>(view.handedOffPtyIds);
  view.handedOffPtyIds.clear();
  if (view.id) owned.add(view.id);
  if (keepPtyAlive) {
    for (const ptyId of owned) handOffOrDetachPty(key, ptyId, view);
  }
  // Drop the context-loss listener first so term.dispose()'s WebglAddon teardown
  // does not flip webglUnavailable, and let term.dispose() mark the terminal disposed
  // before WebglAddon disposes so xterm skips building a fallback DOM renderer.
  view.webglContextLoss?.dispose();
  view.webglContextLoss = null;
  view.localEcho?.reset();
  detachTerminalOutput(view);
  view.writer.dispose();
  try {
    view.fit.dispose();
  } catch {
    /* already disposed with terminal */
  }
  try {
    view.term.dispose();
  } catch {
    /* already detached */
  }
  releaseWebglRenderer(view);
  unwatchTerminalSizeOwnerIfEmpty();
}

function tryEnableWebglRenderer(view: TerminalView): void {
  if (view.webgl || view.webglUnavailable || !view.term.element) return;
  // A phone keeps xterm's DOM renderer: at a fractional device pixel ratio the WebGL canvas and its glyph atlas disagree on pixel size.
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

/** Releases the tab's GL context on detach: Chromium caps live WebGL contexts per renderer (~16) and evicts the oldest. */
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

/** Main's flow control: output parsed into xterm is acknowledged by its char count and buffer generation. */
function acknowledgeTerminalOutput(id: string, charCount: number, gen?: number): void {
  (window.mixdogDesktop as AbortableTerminalDesktop).termAcknowledge?.(id, charCount, gen);
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
  attachTerminalClipboardKeys(term, IS_MAC, copyTextToClipboard);
  const fit = new FitAddon();
  term.loadAddon(fit);
  const writer = new TerminalWritePump((data, complete) => term.write(data, complete), acknowledgeTerminalOutput);
  // Relay-served browsers pay a full round trip per echoed keystroke; the
  // predictor paints validated keystrokes immediately. Electron's local PTY
  // needs none of it.
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
        validationStreak: 1,
      })
    : null;
  const created: TerminalView = {
    id: null,
    feedGen: null,
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
    inflightAttachCount: 0,
    handedOffPtyIds: new Set(),
    abortController: new AbortController(),
    ptyDisposed: false,
  };
  terminalViews.set(key, created);
  watchTerminalSizeOwner();
  return created;
}

// xterm measures cell metrics (and the WebGL glyph atlas) with the face active at open; one refresh when JetBrains Mono loads realigns live terminals.
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

/** True when the tab's terminal paints complete in its mount frame: this renderer holds its fully written screen, or the tab never ran. */
export function terminalPaintsAtOnce(terminalId: string): boolean {
  return viewPaintsAtOnce(terminalViews.get(terminalId), Boolean(readTerminalViewState(terminalId)));
}

/** Attaches a running PTY before its pane mounts so the pane paints its screen in its first frame. Resolves false for a shell that never started or has exited; never starts or changes a process. */
export function prewarmTerminal(terminalId: string): Promise<boolean> {
  const existing = terminalViews.get(terminalId);
  if (existing?.id) return Promise.resolve(true);
  if (connectionLinkView()?.terminalsAvailable === false) {
    if (existing) discardUnopenedView(terminalViews, terminalId, existing);
    return Promise.resolve(false);
  }
  const view = existing ?? terminalView(terminalId);
  view.warming ??= (async () => {
    view.inflightAttachCount += 1;
    let replayWrite: Promise<void> | null = null;
    try {
      const attached = await callTermAttach(terminalId, view.abortController.signal);
      // Released meanwhile, or attached by a pane that mounted first.
      if (terminalViews.get(terminalId) !== view) {
        if (attached && !view.ptyDisposed) handOffOrDetachPty(terminalId, attached.id, view);
        return false;
      }
      if (view.id) return true;
      if (!attached) {
        discardUnopenedView(terminalViews, terminalId, view);
        return false;
      }
      view.id = attached.id;
      const attachedGen = getTerminalSessionGeneration(attached);
      if (attachedGen !== undefined) view.feedGen = attachedGen;
      view.handedOffPtyIds.delete(attached.id);
      applyEnsuredSizeOwner(view, attached.sizeOwner);
      if (attached.replay) {
        view.warmRestore = readTerminalViewState(terminalId);
        if (view.warmRestore) view.term.resize(view.warmRestore.cols, view.warmRestore.rows);
        view.localEcho?.reset();
        replayWrite = trackReplay(view, attached.replay);
      } else {
        clearTerminalViewState(terminalId);
      }
      attachTerminalOutput(view, subscribeViewTermData(view), acknowledgeTerminalOutput);
      view.warmed = true;
    } finally {
      view.inflightAttachCount = Math.max(0, view.inflightAttachCount - 1);
      flushUnboundHandedOffPtys(terminalId, view);
    }
    await replayWrite;
    return true;
  })()
    .catch(() => {
      if (!view.id) discardUnopenedView(terminalViews, terminalId, view);
      return false;
    })
    .finally(() => {
      view.warming = null;
    });
  return view.warming;
}

export async function disposeTerminalPane(id: string): Promise<void> {
  const view = terminalViews.get(id);
  if (view) view.ptyDisposed = true;
  const inflight = inflightViews.get(id);
  if (inflight) {
    for (const pending of inflight) pending.ptyDisposed = true;
  }
  terminalShells.delete(id);
  clearTerminalViewState(id);
  forgetTerminalModifiers(id);
  const ptyId = view?.id || id;
  if (view) releaseTerminalView(id, view, false);
  await window.mixdogDesktop.termDispose?.(ptyId);
}

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
  const viewRef = useRef<TerminalView | null>(null);
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
  const phoneLayout = useMobileRemoteSurface();
  beginBootSurface('terminal', key);
  reportBootSurfaceStage('terminal', key, 'module');
  // While the phone shows this terminal its grid is the PTY's: renew the claim
  // for the host's lease, and hand the size back (so the PC fits its own pane
  // again) the moment the phone stops showing it. Declared before the mount
  // effect so unmount releases ownership before `terminalViews` drops the view.
  useEffect(() => {
    if (!active || !phoneLayout) return undefined;
    const beat = window.setInterval(() => {
      const view = terminalViews.get(key) ?? viewRef.current;
      if (!view?.id) return;
      const grid = view.fit.proposeDimensions() ?? view.term;
      sendSizeOwnerHeartbeat(window.mixdogDesktop, view.id, grid.cols, grid.rows);
    }, SIZE_OWNER_HEARTBEAT_MS);
    return () => {
      window.clearInterval(beat);
      fitSchedulerRef.current?.invalidateResize();
      const view = terminalViews.get(key) ?? viewRef.current;
      if (view?.id && !view.ptyDisposed) sendSizeOwnerRelease(window.mixdogDesktop, view.id);
    };
  }, [active, key, phoneLayout]);
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
    // Do not overwrite persisted viewport state before ensure, replay, and any saved viewport restore finish.
    let viewStateReady = false;
    const view = terminalView(key);
    viewRef.current = view;
    const { term } = view;
    const modifiers = terminalModifiers(key);
    let fitDebounce = 0;
    const schedulePersist = () => {
      window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(() => {
        persistTimer = 0;
        if (!disposed && viewStateReady) writeTerminalViewState(key, view);
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
      fit: (restore) => {
        fitTerminalView(view, restore);
        if (view.id && !view.replayPending) viewStateReady = true;
      },
      emitResize: ({ cols, rows }) => {
        // A followed grid is the phone's: never send it back as our own.
        if (view.id && !view.followSize)
          window.mixdogDesktop.termResize?.(view.id, cols, rows, isMobileRemoteSurface());
      },
      onSettled: () => {
        if (viewStateReady) writeTerminalViewState(key, view);
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
      earlyEnsure =
        callTermEnsure(view.id ?? terminalId ?? null, cwd, shell || null, view.abortController.signal) ?? null;
      earlyEnsure?.catch(() => {});
    }
    if (term.element) container.appendChild(term.element);
    else term.open(container);
    if (activeRef.current || view.warmed) tryEnableWebglRenderer(view);
    view.warmed = false;
    // A phone raises its keypad only for a focus inside the opening tap's activation window.
    if (activeRef.current) {
      try {
        term.focus();
      } catch {
        /* element not measurable yet */
      }
    }
    if (terminalPaintsAtOnce(key)) {
      const restore = view.warmRestore;
      view.warmRestore = null;
      if (view.id && !restore) viewStateReady = true;
      fitScheduler.schedule(restore);
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
      const previousShell = terminalShells.get(key);
      const shellChanged = previousShell !== undefined && previousShell !== shell;
      // A warm-up never respawns: the open's ensure applies the shell change.
      if (mode === 'attach' && shellChanged) return;
      // A strip shell change respawns THIS tab's PTY: dispose the old
      // process, clear the scrollback, and let ensure() below create the
      // replacement under the same terminal id (tab identity holds).
      const early = shellChanged ? null : earlyEnsure;
      earlyEnsure = null;
      if (shellChanged) {
        const previous = view.id || terminalId || key;
        detachTerminalOutput(view);
        view.id = null;
        view.feedGen = null;
        terminalShells.delete(key);
        clearTerminalViewState(key);
        view.localEcho?.reset();
        await view.writer.writeReplay('', () => {
          try {
            term.reset();
          } catch {
            /* fresh spawn repaints anyway */
          }
        });
        await window.mixdogDesktop.termDispose?.(previous);
        if (disposed) return;
      }
      const ensureNow = () =>
        callTermEnsure(view.id ?? terminalId ?? null, cwd, shell || null, view.abortController.signal);
      const untrackInflight = trackInflightView(key, view);
      view.inflightAttachCount += 1;
      let ensured: Awaited<ReturnType<typeof ensureNow>> | null | undefined;
      let alreadyAttached = false;
      let isNewPty = false;
      let reattached = false;
      let disposeAfterMountId: string | null = null;
      try {
        if (early) ensured = await early;
        else if (mode === 'attach') {
          const liveFeedGen = view.id !== null ? getTerminalFeedGeneration(view.id) : null;
          const upToDate =
            view.id !== null &&
            !replayOnReattach &&
            (liveFeedGen === undefined
              ? isTerminalFeedAttached(view.id)
              : liveFeedGen !== null && view.feedGen === liveFeedGen);
          if (upToDate && view.id !== null) {
            // Already bound and streaming this exact snapshot generation on the current link:
            // avoid a redundant refresh attach whose snapshot cut would drop in-flight deltas.
            alreadyAttached = true;
            ensured = { id: view.id, replay: '' };
          } else {
            ensured = await callTermAttach(view.id || terminalId || key, view.abortController.signal);
            // Not running: the open's ensure starts it.
            if (!ensured) return;
          }
        } else ensured = await ensureNow();
        reportBootSurfaceStage('terminal', key, 'data', ensured ? 'pty-ready' : 'shell-only');
        if (!ensured) {
          if (!disposed) onReadyRef.current?.();
          return;
        }
        if (disposed) {
          // Only an explicit tab/session close kills a PTY whose ensure() settled
          // after unmount; hiding a pane detaches this window's feed subscription
          // unless another active mount already took over or is binding this terminal.
          if (view.ptyDisposed) {
            disposeAfterMountId = ensured.id;
          } else {
            handOffOrDetachPty(key, ensured.id, view);
          }
        } else {
          isNewPty = view.id !== ensured.id;
          const sessionGen = alreadyAttached ? undefined : getTerminalSessionGeneration(ensured);
          // Redraw from snapshot only when the authoritative feed generation differs from what this
          // view has already rendered (e.g. replacement PTY or post-outage snapshot), never when a
          // relink resumed seamlessly in replay mode on the same generation.
          reattached =
            !isNewPty &&
            !alreadyAttached &&
            (sessionGen !== undefined ? sessionGen !== null && view.feedGen !== sessionGen : replayOnReattach);
          replayOnReattach = false;
          view.id = ensured.id;
          if (sessionGen !== undefined && (isNewPty || reattached)) {
            view.feedGen = sessionGen;
          }
          view.handedOffPtyIds.delete(ensured.id);
        }
      } finally {
        untrackInflight();
        view.inflightAttachCount = Math.max(0, view.inflightAttachCount - 1);
        flushUnboundHandedOffPtys(key, view);
      }
      if (disposeAfterMountId) {
        await window.mixdogDesktop.termDispose?.(disposeAfterMountId);
        return;
      }
      if (disposed || !ensured) return;
      // An answer without `sizeOwner` means nobody owns the size: a follower that missed the release stops following.
      if (!alreadyAttached) applyEnsuredSizeOwner(view, ensured.sizeOwner);
      view.shell = shell;
      terminalShells.set(key, shell);
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
      } else if (reattached) {
        view.localEcho?.reset();
        replayWrite = trackReplay(view, ensured.replay, () => {
          try {
            term.reset();
          } catch {
            /* disposed mid-reattach */
          }
        });
      }
      // A retry after a failed attempt must not stack a second subscription
      // or key handler onto the same view.
      attachTerminalOutput(view, subscribeViewTermData(view), acknowledgeTerminalOutput);
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
        viewStateReady = true;
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
      if (viewStateReady) writeTerminalViewState(key, view);
      stopCommands?.();
      observer?.disconnect();
      dataDisposable?.dispose();
      imeDetach?.();
      scrollDisposable?.dispose();
      // Release xterm, addons, write pump and DOM when no pane shows this
      // terminal; the PTY stays running and replays on the next open.
      releaseTerminalView(key, view, !view.ptyDisposed);
      if (viewRef.current === view) viewRef.current = null;
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
    applyTerminalActivity(active, {
      enableRenderer: () => {
        if (view) tryEnableWebglRenderer(view);
      },
      releaseRenderer: () => {
        if (view && !attachOnly) releaseWebglRenderer(view);
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
  }, [active, attachOnly, key]);
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
        <div
          className="terminal-connection-note mx-empty-state mx-empty-state-cover"
          ref={emptyStateHost}
          data-kind="unavailable"
          role="note"
        >
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
