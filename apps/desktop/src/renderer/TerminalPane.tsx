// Dock terminal view: a module-shared xterm
// instance over the main-process PTY. The xterm DOM is re-appended on
// remount so tab switches keep scrollback; the PTY survives regardless.
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';
import {
  beginBootSurface,
  reportBootSurfaceStage,
} from './boot-metrics';
import { TerminalWritePump } from './terminal-write-pump';

type ShellProfile = { id: string; label: string; path: string; default?: boolean };

type TerminalView = {
  id: string | null;
  /** Profile id the live PTY was ensured with; a strip change respawns it. */
  shell?: string;
  term: Terminal;
  fit: FitAddon;
  webgl: WebglAddon | null;
  webglUnavailable: boolean;
  writer: TerminalWritePump;
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
const TERMINAL_SHELL_CHOICE_KEY = 'mixdog.desktop-terminal-shell.v1';
const TERMINAL_SHELL_DEFAULT_SLOT = '__default__';

/** Per-terminal shell choice; the last pick doubles as the default for every
 *  NEW terminal (user: 터미널 변경 — 간단하게). */
function readShellChoice(key: string): string {
  try {
    const stored = JSON.parse(window.localStorage.getItem(TERMINAL_SHELL_CHOICE_KEY) || '{}') as
      Record<string, unknown>;
    return String(stored[key] || stored[TERMINAL_SHELL_DEFAULT_SLOT] || '');
  } catch {
    return '';
  }
}

function writeShellChoice(key: string, id: string): void {
  try {
    const stored = JSON.parse(window.localStorage.getItem(TERMINAL_SHELL_CHOICE_KEY) || '{}') as
      Record<string, unknown>;
    stored[key] = id;
    stored[TERMINAL_SHELL_DEFAULT_SLOT] = id;
    window.localStorage.setItem(TERMINAL_SHELL_CHOICE_KEY, JSON.stringify(stored));
  } catch {
    // The in-memory choice still applies for this session.
  }
}

// Detected shells are fetched ONCE per renderer session and shared by every
// terminal surface, and each pane prefetches on mount — the picker opens on a
// ready list instead of flashing an empty state (user: 캐싱하거나 미리 받기).
let shellProfilesCache: ShellProfile[] | null = null;
let shellProfilesRequest: Promise<ShellProfile[]> | null = null;

function loadShellProfiles(): Promise<ShellProfile[]> {
  if (shellProfilesCache) return Promise.resolve(shellProfilesCache);
  shellProfilesRequest ??= (async () => {
    try {
      const request = window.mixdogDesktop.termProfiles?.();
      const list = request ? await request : [];
      const profiles = Array.isArray(list) ? (list as ShellProfile[]) : [];
      // Only a real answer is cached; an empty/failed one retries next time,
      // so a transient IPC failure never pins "No shells detected".
      if (profiles.length) shellProfilesCache = profiles;
      return profiles;
    } catch {
      return [];
    } finally {
      if (!shellProfilesCache) shellProfilesRequest = null;
    }
  })();
  return shellProfilesRequest;
}

function readTerminalViewState(key: string): TerminalViewState | null {
  try {
    const stored = JSON.parse(window.localStorage.getItem(TERMINAL_VIEW_STATE_KEY) || '{}') as
      Record<string, Partial<TerminalViewState>>;
    const state = stored[key];
    if (!state || !Number.isFinite(state.cols) || !Number.isFinite(state.rows)
      || !Number.isFinite(state.scrollY)) return null;
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
    const stored = JSON.parse(window.localStorage.getItem(TERMINAL_VIEW_STATE_KEY) || '{}') as
      Record<string, TerminalViewState>;
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
    const stored = JSON.parse(window.localStorage.getItem(TERMINAL_VIEW_STATE_KEY) || '{}') as
      Record<string, TerminalViewState>;
    if (!(key in stored)) return;
    delete stored[key];
    window.localStorage.setItem(TERMINAL_VIEW_STATE_KEY, JSON.stringify(stored));
  } catch {
    // Ignore corrupt or unavailable storage.
  }
}

function fitTerminalView(view: TerminalView, restore?: TerminalViewState | null): void {
  const current = restore ?? (() => {
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
      try { addon.dispose(); } catch { /* already released by xterm */ }
      if (view.webgl === addon) view.webgl = null;
      // A lost context normally means this window cannot sustain the WebGL
      // renderer. Keep xterm's built-in DOM renderer for the rest of the view
      // instead of repeatedly allocating contexts on every tab attach.
      view.webglUnavailable = true;
    });
    view.term.loadAddon(addon);
    view.webgl = addon;
  } catch {
    contextLossDisposable?.dispose();
    try { addon.dispose(); } catch { /* constructor/load failure */ }
    // WebGL2 can be unavailable under remote desktop, VM, safe-mode, or a
    // blacklisted driver. xterm remains fully functional on its DOM renderer.
    view.webglUnavailable = true;
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
    theme: TERMINAL_THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const created = {
    id: null,
    term,
    fit,
    webgl: null,
    webglUnavailable: false,
    writer: new TerminalWritePump(
      (data, complete) => term.write(data, complete),
      (id, charCount) => window.mixdogDesktop.termAcknowledge?.(id, charCount),
    ),
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
    void document.fonts.load('400 13px "JetBrains Mono Variable"').then(() => {
      for (const view of terminalViews.values()) {
        try { view.webgl?.clearTextureAtlas(); } catch { /* atlas rebuilds lazily */ }
        try {
          view.fit.fit();
          view.term.refresh(0, Math.max(0, view.term.rows - 1));
        } catch { /* a detached terminal refits on its next mount */ }
      }
    }).catch(() => undefined);
  } catch { /* font readiness stays cosmetic */ }
}

export async function disposeTerminalPane(id: string): Promise<void> {
  const view = terminalViews.get(id);
  terminalViews.delete(id);
  clearTerminalViewState(id);
  view?.writer.dispose();
  try { view?.term.dispose(); } catch { /* already detached */ }
  await window.mixdogDesktop.termDispose?.(id);
}

// Terminals stay DARK on both app themes (Cursor grammar): ANSI palettes —
// PSReadLine yellows included — assume a dark background, and a light sheet
// made typed input and the cursor unreadable (user-flagged).
// The 16 ANSI slots are pinned to the VS Code Dark+ set instead of xterm's
// built-in Tango defaults: Tango's blue (#3465a4) and bright black sit near
// this canvas and made paths/prompts hard to read. Background stays in sync
// with --mx-terminal-bg (desktop.css).
const TERMINAL_THEME = {
  background: '#131313',
  foreground: '#e9e9e9',
  cursor: '#e9e9e9',
  cursorAccent: '#131313',
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

export default function TerminalPane({
  cwd,
  terminalId,
  active = true,
  onReady,
}: {
  cwd: string | null;
  terminalId?: string;
  active?: boolean;
  onReady?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // The mount effect's ensure pipeline outlives renders; a stale captured
  // `active` skipped the boot-complete focus when the tab activated while
  // the PTY was still spawning (cold entry via Ctrl+Arrow).
  const activeRef = useRef(active);
  activeRef.current = active;
  const key = terminalId || DOCK_TERMINAL_KEY;
  const [shell, setShell] = useState(() => readShellChoice(key));
  const [profiles, setProfiles] = useState<ShellProfile[] | null>(() => shellProfilesCache);
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  beginBootSurface('terminal', key);
  reportBootSurfaceStage('terminal', key, 'module');
  // Prefetch on mount so the picker opens on a ready list; an opened menu
  // with an empty answer retries once more.
  useEffect(() => {
    if (profiles?.length) return undefined;
    if (profiles !== null && !shellMenuOpen) return undefined;
    let live = true;
    void loadShellProfiles().then((list) => {
      if (live) setProfiles(list);
    });
    return () => { live = false; };
  }, [profiles, shellMenuOpen]);
  useEffect(() => {
    if (!shellMenuOpen) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.dock-terminal-shell')) return;
      setShellMenuOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShellMenuOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown);
    };
  }, [shellMenuOpen]);
  useEffect(() => {
    const container = host.current;
    if (!container) return undefined;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let observer: ResizeObserver | undefined;
    let dataDisposable: { dispose(): void } | undefined;
    let scrollDisposable: { dispose(): void } | undefined;
    let fitFrame = 0;
    let revealTimer = 0;
    let persistTimer = 0;
    let retryTimer = 0;
    let retryDelay = 1000;
    let noticeShown = false;
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
    if (term.element) container.appendChild(term.element);
    else term.open(container);
    tryEnableWebglRenderer(view);
    // PTY ensure/replay can be slow. Revealing xterm's empty shell first let
    // the replayed scrollback visibly dump into an already-open terminal
    // (user: PANE 최초 진입 시 스크립트가 튐). Keep PaneSurfaceGate's opaque
    // cover up until the replay buffer is written and the first fit has run —
    // the ensure path fires onReady right after that. This timer only guards
    // a stalled PTY host so the gate can never hang on a blank pane.
    revealTimer = window.setTimeout(() => {
      revealTimer = 0;
      if (!disposed && term.element?.querySelector(".xterm-screen")) {
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
        try { term.reset(); } catch { /* fresh spawn repaints anyway */ }
        await window.mixdogDesktop.termDispose?.(previous);
      }
      const ensured = await window.mixdogDesktop.termEnsure?.(
        view.id ?? terminalId ?? null,
        cwd,
        shell || null,
      );
      reportBootSurfaceStage('terminal', key, 'data', ensured ? 'pty-ready' : 'shell-only');
      if (!ensured || disposed) {
        if (!disposed) onReadyRef.current?.();
        return;
      }
      const isNewPty = view.id !== ensured.id;
      view.id = ensured.id;
      view.shell = shell;
      let replayWrite: Promise<void> | null = null;
      if (isNewPty && ensured.replay) {
        pendingRestore = readTerminalViewState(key);
        if (pendingRestore) term.resize(pendingRestore.cols, pendingRestore.rows);
        replayWrite = view.writer.writeReplay(ensured.replay);
      } else if (isNewPty) {
        // A restored tab backed by a fresh PTY must not inherit the old
        // process's viewport position.
        clearTerminalViewState(key);
      }
      // A retry after a failed attempt must not stack a second subscription
      // or key handler onto the same view.
      unsubscribe ??= window.mixdogDesktop.subscribeTermData?.((event) => {
        if (event.id === view.id) view.writer.push(event.id, event.data);
      });
      dataDisposable ??= term.onData((data) => {
        if (view.id) window.mixdogDesktop.termWrite?.(view.id, data);
      });
      if (replayWrite) await replayWrite;
      if (disposed) return;
      const scheduleFit = () => {
        if (disposed || fitFrame) return;
        fitFrame = window.requestAnimationFrame(() => {
          fitFrame = 0;
          if (disposed) return;
          try {
            fitTerminalView(view, pendingRestore);
            pendingRestore = null;
            if (view.id) window.mixdogDesktop.termResize?.(view.id, term.cols, term.rows);
            writeTerminalViewState(key, view);
            if (term.element?.querySelector(".xterm-screen")) onReadyRef.current?.();
          } catch { /* container hidden mid-measure */ }
        });
      };
      // Restored split ratios settle in the commit before this frame. Fitting
      // earlier leaves xterm with the startup pane's stale row count and a
      // malformed viewport scrollbar.
      scheduleFit();
      if (!observer) {
        observer = new ResizeObserver(scheduleFit);
        observer.observe(container);
      }
      if (activeRef.current) term.focus();
    };
    // The PTY host can be down (worker exit, ensure timeout, spawn failure).
    // Surface it once, reveal the pane, and keep retrying: TerminalHost
    // lazily respawns its worker on the next ensure().
    const attemptEnsure = () => {
      void runEnsure().catch(() => {
        if (disposed) return;
        // Notice/reveal are best-effort (the terminal may already be
        // disposed); retry scheduling must always run.
        if (!noticeShown) {
          noticeShown = true;
          try {
            term.write("\r\n\x1b[31mterminal backend unavailable — retrying…\x1b[0m\r\n");
          } catch { /* xterm disposed mid-failure */ }
        }
        try {
          onReadyRef.current?.();
        } catch { /* gate consumer threw */ }
        retryTimer = window.setTimeout(() => {
          retryTimer = 0;
          if (!disposed) attemptEnsure();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 5000);
      });
    };
    attemptEnsure();
    return () => {
      disposed = true;
      if (fitFrame) window.cancelAnimationFrame(fitFrame);
      window.clearTimeout(revealTimer);
      window.clearTimeout(persistTimer);
      if (retryTimer) window.clearTimeout(retryTimer);
      writeTerminalViewState(key, view);
      unsubscribe?.();
      observer?.disconnect();
      dataDisposable?.dispose();
      scrollDisposable?.dispose();
      // The xterm DOM node stays alive for the next attach; only detach it.
      if (term.element?.parentElement === container) container.removeChild(term.element);
    };
  }, [cwd, key, shell, terminalId]);
  useEffect(() => {
    if (!active) return undefined;
    const frame = window.requestAnimationFrame?.(() => {
      const view = terminalViews.get(key);
      try {
        if (view) {
          fitTerminalView(view);
          writeTerminalViewState(key, view);
          if (view.id) window.mixdogDesktop.termResize?.(view.id, view.term.cols, view.term.rows);
          if (view.term.element?.querySelector(".xterm-screen")) onReadyRef.current?.();
        }
      } catch { /* hidden while the active tab changes */ }
      // Focus must not die with a failed fit: a still-covered surface throws
      // in the measure above, which used to skip term.focus() entirely
      // (user: 터미널 커서가 안 들어온다).
      try { view?.term.focus(); } catch { /* disposed mid-activation */ }
    });
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame?.(frame);
    };
  }, [active, key]);
  // Surface WHAT the default actually spawns (user: 기본 OS 터미널이 나와야).
  const defaultProfile = profiles?.find((profile) => profile.default) ?? null;
  const defaultShellLabel = defaultProfile
    ? t('Default ({{label}})', { label: defaultProfile.label })
    : t('Default shell');
  const shellLabel = shell
    ? profiles?.find((profile) => profile.id === shell)?.label || shell
    : defaultShellLabel;
  return <div className="dock-terminal-surface">
    {/* File-breadcrumb strip grammar (user: TASK나 파일처럼 띠 하나): a 30px
        band above the terminal with the shell switcher on the right edge.
        NO title text — every host (workspace tab, bottom panel) already
        labels the surface "Terminal" one row above (user: 터미널 아래
        터미널이 왜 또 있어야 하는지 모르겠다). */}
    <header className="dock-terminal-strip">
      <div className="dock-terminal-shell">
        <button type="button" className="dock-terminal-shell-trigger"
          aria-haspopup="menu" aria-expanded={shellMenuOpen}
          title={t('Change terminal shell')}
          onClick={() => setShellMenuOpen((open) => !open)}>
          <span>{shellLabel}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {shellMenuOpen && <div className="dock-terminal-shell-menu" role="menu"
          aria-label={t('Terminal shells')}>
          {profiles === null
            && <span className="dock-terminal-shell-note">{t('Detecting shells…')}</span>}
          {profiles?.length === 0
            && <span className="dock-terminal-shell-note">{t('No shells detected')}</span>}
          {(profiles?.length ?? 0) > 0 && <button type="button" role="menuitemradio"
            aria-checked={!shell} title={defaultProfile?.path || t('OS default shell')}
            onClick={() => {
              setShellMenuOpen(false);
              if (!shell) return;
              writeShellChoice(key, '');
              setShell('');
            }}>
            <span>{defaultShellLabel}</span>
            {!shell && <Check size={14} aria-hidden="true" />}
          </button>}
          {(profiles ?? []).map((profile) => <button type="button" role="menuitemradio"
            key={profile.id} aria-checked={profile.id === shell} title={profile.path}
            onClick={() => {
              setShellMenuOpen(false);
              if (profile.id === shell) return;
              writeShellChoice(key, profile.id);
              setShell(profile.id);
            }}>
            <span>{profile.label}</span>
            {profile.id === shell && <Check size={14} aria-hidden="true" />}
          </button>)}
        </div>}
      </div>
    </header>
    <div className="dock-terminal" ref={host} />
  </div>;
}
