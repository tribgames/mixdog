/**
 * src/tui/index.jsx — entry that mounts the React/ink TUI.
 *
 * Creates the engine session (runs OUR agentLoop outside React) and ink-renders
 * <App store={...}/>. Resolves when the app exits (/exit or /quit).
 */
import React from 'react';
import { render } from 'ink';
import { closeSync, constants as fsConstants, createWriteStream, mkdirSync, openSync, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { format } from 'node:util';
import { App } from './App.jsx';
import { createEngineSession } from './engine.mjs';
import { installProcessSignalCleanup } from '../runtime/shared/process-shutdown.mjs';
import { emitTerminalBackground, loadThemeSettingFromConfig, theme } from './theme.mjs';
import { POP_KITTY, DISABLE_MODIFY_OTHER_KEYS } from './keyboard-protocol.mjs';
import { displayWidth } from './display-width.mjs';
import { rotateBoundedLog, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../lib/mixdog-debug.cjs';

// Trailing `\x1b[>0s` restores XTSHIFTESCAPE (shift-to-select-extend) to its
// terminal default; MOUSE_TRACKING_ON opts into `\x1b[>1s`, so every mouse/alt
// screen teardown that emits this reset also undoes that opt-in.
const TERMINAL_MODE_RESET = '\x1b[?1006l\x1b[?1005l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[>0s\x1b[?25h';
const TERMINAL_OSC_RESET_BG = '\x1b]111\x07';
const TERMINAL_MODE_RESET_HIDDEN_CURSOR = TERMINAL_MODE_RESET.replace('\x1b[?25h', '\x1b[?25l');
// Trailing `\x1b[>1s` is XTSHIFTESCAPE: terminals that support it forward
// shift+click/drag to the app so our shift-extend selection paths work.
// Windows Terminal half-honors it — it forwards the shift events AND still
// paints its own native selection, so the user sees two overlapping
// highlights. Gate on WT_SESSION: in WT shift stays fully native (single
// highlight, native copy); ctrl+click/right-click remain the app-side
// extend triggers there. Restored via `\x1b[>0s` in TERMINAL_MODE_RESET.
const XTSHIFTESCAPE_ON = process.env.WT_SESSION ? '' : '\x1b[>1s';
// Trailing `\x1b[?1007l` keeps alternate-scroll OFF for the whole session:
// while mouse tracking is on it is irrelevant (wheel arrives as SGR events),
// but if tracking ever drops (failed re-enable after the ctrl+wheel zoom
// passthrough, terminal hiccup), an enabled 1007 makes the terminal convert
// wheel input into Up/Down arrows — which lands in PROMPT HISTORY instead of
// transcript scroll. With 1007 forced off the wheel degrades to a no-op, never
// to history navigation. Restored to on (`\x1b[?1007h`) at teardown so
// alt-screen apps that rely on alternate scroll (less/vim under Windows
// Terminal, whose default is on) keep working after mixdog exits.
const MOUSE_TRACKING_ON = `\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007l${XTSHIFTESCAPE_ON}`;
const ALT_SCROLL_RESTORE = '\x1b[?1007h';
// Keyboard-protocol teardown. App.jsx enables kitty + modifyOtherKeys
// synchronously at raw-mode-on (no query); here we just pop/disable them on
// exit. POP_KITTY / DISABLE_MODIFY_OTHER_KEYS come from keyboard-protocol.mjs.
const BOOT_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_BOOT_PROFILE || ''));
const BOOT_PROFILE_START = globalThis.__mixdogBootProfileStart || (globalThis.__mixdogBootProfileStart = performance.now());
const EXIT_WAIT_TIMEOUT_MS = positiveIntEnv('MIXDOG_TUI_EXIT_WAIT_MS', 2500);
const EXIT_HARD_DELAY_MS = positiveIntEnv('MIXDOG_TUI_HARD_EXIT_DELAY_MS', 500);
const EXIT_HARD_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.MIXDOG_TUI_HARD_EXIT || '1'));
const EXIT_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_TUI_EXIT_DEBUG || ''));
const PERF_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_TUI_PERF || ''));
const LOOP_PROBE_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_TUI_LOOP_PROBE || ''));
const LOOP_PROBE_INTERVAL_MS = 1000;
const LOOP_PROBE_DRIFT_THRESHOLD_MS = 200;

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// Opt-in event-loop stall probe (MIXDOG_TUI_LOOP_PROBE=1). A setInterval that
// measures its own scheduling drift: if the loop is blocked (sync file lock,
// heavy render, GC), the callback fires late and drift = actual - expected.
// Logs `[mixdog-loop] stall=NNNms` via the same stderr surface the TUI guard
// captures. unref'd so it never keeps the process alive.
function installTuiLoopProbe() {
  if (!LOOP_PROBE_ENABLED) return () => {};
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const drift = (now - last) - LOOP_PROBE_INTERVAL_MS;
    last = now;
    if (drift > LOOP_PROBE_DRIFT_THRESHOLD_MS) {
      try { process.stderr.write(`[mixdog-loop] stall=${drift.toFixed(0)}ms\n`); } catch { /* ignore */ }
    }
  }, LOOP_PROBE_INTERVAL_MS);
  timer.unref?.();
  return () => { try { clearInterval(timer); } catch { /* ignore */ } };
}

// Lightweight render-frame profiler. Forked ink calls options.onRender with the
// per-frame render() wall time (renderNodeToOutput serialization). We aggregate
// and emit a rolling summary every PERF_REPORT_EVERY frames so typing latency
// can be measured without flooding output. Entirely no-op unless
// MIXDOG_TUI_PERF=1, so it costs nothing in normal runs.
const PERF_REPORT_EVERY = positiveIntEnv('MIXDOG_TUI_PERF_EVERY', 60);
const PERF_STALL_INTERVAL_MS = positiveIntEnv('MIXDOG_TUI_PERF_STALL_INTERVAL_MS', 100);
const PERF_STALL_THRESHOLD_MS = positiveIntEnv('MIXDOG_TUI_PERF_STALL_MS', 80);
const PERF_RENDER_GAP_MS = positiveIntEnv('MIXDOG_TUI_PERF_RENDER_GAP_MS', 120);

function perfLog(event, fields = {}) {
  if (!PERF_ENABLED) return;
  const elapsedMs = performance.now() - BOOT_PROFILE_START;
  const parts = [`[mixdog-perf] +${elapsedMs.toFixed(1)}ms`, event];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${String(value).replace(/\s+/g, '_')}`);
  }
  try { process.stderr.write(`${parts.join(' ')}\n`); } catch { /* ignore */ }
}

function installTuiPerfProbe() {
  if (!PERF_ENABLED) return () => {};
  let last = performance.now();
  let lastCpu = process.cpuUsage();
  perfLog('probe:start', {
    intervalMs: PERF_STALL_INTERVAL_MS,
    stallMs: PERF_STALL_THRESHOLD_MS,
    renderGapMs: PERF_RENDER_GAP_MS,
  });
  const timer = setInterval(() => {
    const now = performance.now();
    const elapsed = now - last;
    const lagMs = elapsed - PERF_STALL_INTERVAL_MS;
    const cpu = process.cpuUsage(lastCpu);
    last = now;
    lastCpu = process.cpuUsage();
    if (lagMs < PERF_STALL_THRESHOLD_MS) return;
    const mem = process.memoryUsage();
    perfLog('event-loop-stall', {
      lagMs: lagMs.toFixed(1),
      elapsedMs: elapsed.toFixed(1),
      cpuUserMs: (cpu.user / 1000).toFixed(1),
      cpuSystemMs: (cpu.system / 1000).toFixed(1),
      rssMb: (mem.rss / 1048576).toFixed(1),
      heapMb: (mem.heapUsed / 1048576).toFixed(1),
    });
  }, PERF_STALL_INTERVAL_MS);
  timer.unref?.();
  return () => {
    try { clearInterval(timer); } catch { /* ignore */ }
  };
}

function makeRenderProfiler() {
  if (!PERF_ENABLED) return undefined;
  let count = 0;
  let sum = 0;
  let max = 0;
  let slow = 0;
  let maxGap = 0;
  let lastFrameAt = 0;
  return ({ renderTime } = {}) => {
    const now = performance.now();
    const ms = Number(renderTime) || 0;
    const gap = lastFrameAt ? now - lastFrameAt : 0;
    lastFrameAt = now;
    count += 1;
    sum += ms;
    if (ms > max) max = ms;
    if (gap > maxGap) maxGap = gap;
    if (ms >= 16) slow += 1;
    if (gap >= PERF_RENDER_GAP_MS) {
      perfLog('render-gap', {
        gapMs: gap.toFixed(1),
        renderMs: ms.toFixed(2),
      });
    }
    if (count >= PERF_REPORT_EVERY) {
      const avg = sum / count;
      perfLog('render-summary', {
        frames: count,
        avgMs: avg.toFixed(2),
        maxMs: max.toFixed(2),
        maxGapMs: maxGap.toFixed(1),
        slow16: slow,
      });
      count = 0; sum = 0; max = 0; slow = 0; maxGap = 0;
    }
  };
}

function bootProfile(event, fields = {}) {
  if (!BOOT_PROFILE_ENABLED) return;
  const elapsedMs = performance.now() - BOOT_PROFILE_START;
  const parts = [`[mixdog-boot] +${elapsedMs.toFixed(1)}ms`, `tui:${event}`];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${String(value).replace(/\s+/g, '_')}`);
  }
  try { process.stderr.write(`${parts.join(' ')}\n`); } catch {}
}

function tuiExitDebug(event, fields = {}) {
  if (!EXIT_DEBUG_ENABLED) return;
  const parts = [`[mixdog-tui-exit] ${event}`];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${String(value).replace(/\s+/g, '_')}`);
  }
  try { process.stderr.write(`${parts.join(' ')}\n`); } catch { /* ignore */ }
}

function describeActiveHandle(handle) {
  if (!handle) return 'unknown';
  const parts = [handle.constructor?.name || typeof handle];
  if (typeof handle.pid === 'number') parts.push(`pid=${handle.pid}`);
  if (typeof handle.fd === 'number') parts.push(`fd=${handle.fd}`);
  if (handle.remoteAddress || handle.remotePort) parts.push(`remote=${handle.remoteAddress || '?'}:${handle.remotePort || '?'}`);
  if (handle.localAddress || handle.localPort) parts.push(`local=${handle.localAddress || '?'}:${handle.localPort || '?'}`);
  if (handle.killed === true) parts.push('killed=true');
  return parts.join(':');
}

function dumpActiveHandles(label) {
  if (!EXIT_DEBUG_ENABLED) return;
  try {
    const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
    const requests = typeof process._getActiveRequests === 'function' ? process._getActiveRequests() : [];
    tuiExitDebug(label, {
      handles: handles.length,
      requests: requests.length,
      detail: handles.map(describeActiveHandle).join(','),
    });
  } catch (error) {
    tuiExitDebug(`${label}:failed`, { error: error?.message || String(error) });
  }
}

function waitWithTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function scheduleHardExit(code = 0) {
  if (!EXIT_HARD_ENABLED) return;
  const timer = setTimeout(() => {
    dumpActiveHandles('hard-exit');
    try { process.stdout.write(`${TERMINAL_MODE_RESET}${TERMINAL_OSC_RESET_BG}`); } catch { /* ignore */ }
    process.exit(code);
  }, EXIT_HARD_DELAY_MS);
  timer.unref?.();
}

function resolveTuiStderrLogPath() {
  return process.env.MIXDOG_TUI_STDERR_LOG
    || join(process.env.MIXDOG_RUNTIME_ROOT || join(tmpdir(), 'mixdog'), 'mixdog-tui.stderr.log');
}

/** `rgb(r,g,b)` → truecolor SGR prefix ('' when unparsable). */
function ansiFg(rgb) {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(String(rgb || ''));
  return m ? `\x1b[38;2;${m[1]};${m[2]};${m[3]}m` : '';
}

/**
 * Paint a static boot splash into the (already-entered) alternate screen so
 * the seconds between alt-screen entry and the first ink frame are not a blank
 * void. The logo is drawn at the SAME rows/columns as App.jsx's welcome banner
 * (marginTop 3 + 5 logo rows + blank + subtitle), so ink's first real frame
 * overprints it in place with no visible jump. Do NOT pre-paint the bottom
 * picker/prompt frame here: the first ink frame may hide or move those rows
 * while the initial project picker settles, and stale raw borders look like a
 * broken frame. Returns { stop } — call it right before ink mounts.
 */
function paintBootSplash() {
  try {
    const cols = Math.max(1, Number(process.stdout.columns) || 80);
    const rows = Math.max(1, Number(process.stdout.rows) || 24);
    const windowsLikeTerminal = process.platform === 'win32' || Boolean(process.env.WT_SESSION);
    const frameCols = Math.max(1, cols - (windowsLikeTerminal ? 1 : 0));
    const center = (s) => `${' '.repeat(Math.max(0, Math.floor((frameCols - displayWidth(s)) / 2)))}${s}`;
    const logo = [
      '███╗   ███╗██╗██╗  ██╗██████╗  ██████╗  ██████╗ ',
      '████╗ ████║██║╚██╗██╔╝██╔══██╗██╔═══██╗██╔════╝ ',
      '██╔████╔██║██║ ╚███╔╝ ██║  ██║██║   ██║██║  ███╗',
      '██║╚██╔╝██║██║ ██╔██╗ ██║  ██║██║   ██║██║   ██║',
      '██║ ╚═╝ ██║██║██╔╝ ██╗██████╔╝╚██████╔╝╚██████╔╝',
    ];
    const textFg = ansiFg(theme.text);
    const logoFg = ansiFg(theme.logo ?? theme.claude) || textFg;
    const subtleFg = ansiFg(theme.inactive);
    const bold = '\x1b[1m';
    const reset = '\x1b[0m';
    let out = '\x1b[4;1H'; // row 4 == App banner's marginTop={3}
    for (let i = 0; i < logo.length; i++) {
      const fg = i < 2 ? textFg : logoFg;
      out += `${bold}${fg}${center(logo[i])}${reset}\r\n`;
    }
    out += '\r\n';
    out += `${subtleFg}${center(`mixdog coding agent · ${process.cwd()}`)}${reset}`;

    // Park the cursor at home so ink's first frame paints top-down over the
    // splash instead of starting at the bottom row and scrolling the screen.
    out += '\x1b[H';
    process.stdout.write(out);

    return { stop: () => {} };
  } catch { /* cosmetic only — never block boot */ }
  return { stop: () => {} };
}

/** Drain stdin so queued key/mouse bytes do not leak into the shell after exit. */
function drainStdin(stdin = process.stdin) {
  if (!stdin.isTTY) return;
  try {
    while (stdin.read() !== null) {
      /* discard */
    }
  } catch {
    /* stream may be destroyed */
  }
  if (process.platform === 'win32') return;
  const tty = stdin;
  const wasRaw = tty.isRaw === true;
  let fd = -1;
  try {
    if (!wasRaw) tty.setRawMode?.(true);
    fd = openSync('/dev/tty', fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const buf = Buffer.alloc(1024);
    for (let i = 0; i < 64; i++) {
      if (readSync(fd, buf, 0, buf.length, null) <= 0) break;
    }
  } catch {
    /* EAGAIN, ENXIO, ENOENT, EBADF, EIO */
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (!wasRaw) {
      try {
        tty.setRawMode?.(false);
      } catch {
        /* TTY may be gone */
      }
    }
  }
}

function installTuiStderrGuard() {
  if (process.env.MIXDOG_TUI_ALLOW_STDERR === '1') return () => {};
  const originalWrite = process.stderr.write.bind(process.stderr);
  const logPath = resolveTuiStderrLogPath();
  try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* ignore */ }
  // One-shot bound before the append stream opens: this TUI process never
  // passes through the channels-worker rotation path, so cap it writer-side.
  rotateBoundedLog(logPath, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES);
  let logStream = null;
  try {
    logStream = createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', () => {});
  } catch {
    logStream = null;
  }

  process.stderr.write = ((chunk, encoding, callback) => {
    const done = typeof encoding === 'function' ? encoding : callback;
    const enc = typeof encoding === 'string' ? encoding : undefined;
    try {
      if (logStream) {
        logStream.write(Buffer.isBuffer(chunk) ? chunk : String(chunk ?? ''), enc, () => {
          if (typeof done === 'function') {
            try { done(); } catch { /* ignore */ }
          }
        });
        return true;
      }
    } catch {
      // Last-resort fallback: if the log file is unavailable, drop diagnostics
      // while the fullscreen TUI owns the terminal.
    }
    if (typeof done === 'function') {
      try { done(); } catch { /* ignore */ }
    }
    return true;
  });

  return () => {
    process.stderr.write = originalWrite;
    try { logStream?.end(); } catch { /* ignore */ }
  };
}

/**
 * Route console.* to the guarded stderr (→ mixdog-tui.stderr.log) while the
 * fullscreen TUI owns the terminal, and mount ink with patchConsole:false.
 *
 * Why: ink's patchConsole path (writeToStdout/writeToStderr) handles an
 * intercepted console line by erasing the whole frame (log.clear()), writing
 * the line, then re-writing the last frame RELATIVE to the cursor. On a
 * fullscreen alt-screen frame that relative rewrite overflows the bottom row
 * by exactly the stray line's height, so the terminal scrolls one line and
 * the next incremental frame snaps it back — the visible "+1 line / -1 line"
 * bounce during streaming (reproduced in a VT harness: one console.log mid-
 * stream = scrollDelta 1, with or without the spinner). The stray text itself
 * was already invisible (stderr guard files it), so the only user-visible
 * effect of the whole dance WAS the bounce. Routing console output straight
 * to the guarded stderr keeps the diagnostics AND skips ink's repaint dance.
 */
function installTuiConsoleGuard() {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const original = new Map();
  for (const m of methods) {
    original.set(m, console[m]);
    console[m] = (...args) => {
      try { process.stderr.write(`[console.${m}] ${format(...args)}\n`); } catch { /* ignore */ }
    };
  }
  return () => {
    for (const [m, fn] of original) console[m] = fn;
  };
}

export async function runTui({ provider, model, toolMode, remote, forceOnboarding } = {}) {
  const startedAt = performance.now();
  bootProfile('run:start', { provider, model, toolMode, remote });
  // The React/ink TUI needs a raw-mode-capable TTY (interactive input). In a
  // pipe/redirect/CI, ink's input hooks throw — bail with a clear hint instead.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'mixdog: the TUI needs an interactive terminal (TTY).\n' +
        'Run it directly in a terminal, or use --plain for the readline REPL.\n',
    );
    return 1;
  }

  const restoreStderr = installTuiStderrGuard();
  const restoreConsole = installTuiConsoleGuard();
  const stopPerfProbe = installTuiPerfProbe();
  const stopLoopProbe = installTuiLoopProbe();
  const restorePrimedInput = () => drainStdin(process.stdin);
  let restored = false;
  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    restorePrimedInput();
    try {
      process.stdout.write(
        // Pop kitty + disable modifyOtherKeys BEFORE leaving the alt screen.
        // Both are no-ops if nothing was enabled, so this is always safe.
        `${TERMINAL_MODE_RESET}${ALT_SCROLL_RESTORE}\x1b[0 q${POP_KITTY}${DISABLE_MODIFY_OTHER_KEYS}\x1b[?1049l${TERMINAL_MODE_RESET}${TERMINAL_OSC_RESET_BG}`,
      );
    } catch { /* ignore */ }
  };

  // Enter the alternate screen buffer before session/runtime boot so no stale
  // shell rows are visible while the statusline/TUI data warms up. The first
  // real Ink frame may still arrive after createEngineSession(), but the user
  // sees a clean fullscreen surface immediately instead of the previous terminal
  // contents bleeding through the bottom status area.
  process.stdout.write(`${TERMINAL_MODE_RESET_HIDDEN_CURSOR}\x1b[?1049h${TERMINAL_MODE_RESET_HIDDEN_CURSOR}\x1b[2J\x1b[H`);

  // Use a blinking BAR cursor (DECSCUSR 5) — a thin caret behind the text, not a
  // fat block. PromptInput parks this hardware cursor at the insertion point via
  // useCursor; the terminal also anchors IME composition to it.
  process.stdout.write('\x1b[5 q'); // blinking bar
  // NOTE: extended-keys enabling (kitty + modifyOtherKeys) is done by App.jsx's
  // mount effect, SYNCHRONOUSLY at ink's raw-mode-on — no query, no round-trip —
  // so the first Ctrl+Enter is already covered. Only teardown lives here (see
  // restoreTerminal above).

  process.on('exit', restoreTerminal);

  // Apply the persisted UI theme (ui.theme in mixdog-config.json) before the
  // first React frame so the whole tree paints in the chosen palette. Unknown
  // or missing values leave the default Mixdog dark palette in place; a failed
  // config read never blocks boot.
  try { await loadThemeSettingFromConfig(); } catch { /* default theme stays */ }
  emitTerminalBackground(theme.background);

  // Static splash + loading spinner while createEngineSession() warms up
  // (config, providers, sessions). Without this the user stares at an empty
  // alt screen for the whole boot, then the UI "pops in" — the splash makes
  // the first ink frame an in-place repaint instead.
  const splash = paintBootSplash() || { stop: () => {} };

  let store;
  try {
    store = await createEngineSession({ provider, model, toolMode, remote });
    bootProfile('store:ready', { ms: (performance.now() - startedAt).toFixed(1) });
  } catch (error) {
    splash.stop();
    stopPerfProbe();
    stopLoopProbe();
    restoreTerminal();
    try { process.off('exit', restoreTerminal); } catch { /* ignore */ }
    restoreConsole();
    restoreStderr();
    process.stderr.write(`mixdog: ${error?.message || error}\n`);
    return 1;
  }
  // Stop the spinner BEFORE ink mounts so no stray splash write can land
  // between (or after) ink's first frames.
  splash.stop();

  // Keep mouse handling app-owned by default: native terminal selections are
  // cleared by the fullscreen redraws that happen while a turn streams. Users
  // who prefer their terminal's native mouse behavior can opt out with
  // MIXDOG_TUI_MOUSE=0 (mouse capture stays off at boot, no runtime toggle).
  const mouseTracking = !/^(0|false|no|off)$/i.test(String(process.env.MIXDOG_TUI_MOUSE || '1'));
  if (mouseTracking) {
    process.stdout.write(MOUSE_TRACKING_ON);
  }
  let storeDisposed = false;
  const disposeStoreOnce = async (reason = 'cli-react-exit') => {
    if (storeDisposed) return;
    storeDisposed = true;
    await waitWithTimeout(store.dispose?.(reason), EXIT_WAIT_TIMEOUT_MS);
  };
  const signalCleanup = installProcessSignalCleanup({
    name: 'mixdog-tui',
    signals: ['SIGINT', 'SIGTERM', 'SIGHUP'],
    timeoutMs: EXIT_WAIT_TIMEOUT_MS + 1000,
    beforeCleanup: restoreTerminal,
    cleanup: disposeStoreOnce,
    afterCleanup: (reason) => {
      restoreTerminal();
      dumpActiveHandles(`after-${reason}`);
      restoreConsole();
      restoreStderr();
    },
  });

  // Zombie-Lead repro (2026-07-02): stdio can die (TTY hangup, EPIPE on a
  // detached/piped stdout) without the process ever receiving SIGHUP/SIGTERM,
  // leaving a zombie renderer looping forever with nothing left to draw to.
  // Treat a dead stdio surface as fatal and route it through the same
  // signalCleanup teardown used for signals.
  // 'error' whitelist: only codes that mean the stream is truly gone.
  // Transient EAGAIN (backpressure) or terminal-resize noise must NOT be
  // treated as fatal here — only EPIPE / ERR_STREAM_DESTROYED / EIO.
  const STDIO_DEATH_FATAL_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'EIO']);
  const stdioDeathListeners = [];
  const registerStdioDeath = (stream, event, { requireCode = false } = {}) => {
    if (!stream || typeof stream.on !== 'function') return;
    const handler = (err) => {
      if (requireCode && !(err && STDIO_DEATH_FATAL_CODES.has(err.code))) return;
      void signalCleanup.run('stdio-dead', {
        code: 1,
        shouldExit: true,
        error: err || new Error(`stdio ${event} (source: ${stream === process.stdin ? 'stdin' : stream === process.stdout ? 'stdout' : 'stderr'})`),
      });
    };
    stream.on(event, handler);
    stdioDeathListeners.push([stream, event, handler]);
  };
  // stdin end/close/error: TTY/pipe on the input side is gone — nothing left
  // to read from, no point keeping the renderer alive.
  registerStdioDeath(process.stdin, 'end');
  registerStdioDeath(process.stdin, 'close');
  registerStdioDeath(process.stdin, 'error', { requireCode: true });
  // stdout/stderr: 'close' always means the fd is gone (fatal); 'error' is
  // filtered to the whitelist above so resize/EAGAIN noise doesn't kill us.
  registerStdioDeath(process.stdout, 'error', { requireCode: true });
  registerStdioDeath(process.stdout, 'close');
  registerStdioDeath(process.stderr, 'error', { requireCode: true });
  registerStdioDeath(process.stderr, 'close');

  // exitOnCtrlC:false — App handles Ctrl+C as an interrupt/line-clear so Ink
  // does not exit abruptly. Explicit exits go through /exit or /quit so teardown
  // still restores the cursor, mouse mode, and alternate screen cleanly.
  try {
    // [render] incrementalRendering: line-diff repaint (only changed rows are
    // rewritten) instead of erase-all+rewrite per frame — removes the whole-
    // frame flash on surface transitions and slash palette open/close.
    // patchConsole:false — console.* is already routed to the stderr log by
    // installTuiConsoleGuard above. Letting ink intercept it instead triggers
    // its clear-frame → write → relative re-render dance, which scrolls the
    // alt screen one line per stray console line (the streaming newline
    // bounce). See installTuiConsoleGuard.
    const instance = render(<App store={store} forceOnboarding={forceOnboarding === true} />, { exitOnCtrlC: false, maxFps: 60, incrementalRendering: true, patchConsole: false, onRender: makeRenderProfiler() });
    bootProfile('render:mounted', { ms: (performance.now() - startedAt).toFixed(1) });
    const { waitUntilExit } = instance;
    // [mixdog fork] Hand the ink renderer's drag-selection setter to the store so
    // App's mouse handler can push selection rectangles (absolute terminal cells)
    // that ink paints as an inverse highlight. render() returns synchronously
    // after the first mount, while the mouse handler only fires on user drag, so
    // wiring it here (post-render) is in time.
    if (mouseTracking && typeof instance.setSelection === 'function') {
      store.setRenderSelection = instance.setSelection;
    }
    if (mouseTracking && typeof instance.getSelectionText === 'function') {
      store.getRenderSelectionText = instance.getSelectionText;
    }
    if (mouseTracking && typeof instance.getWordRectAt === 'function') {
      store.getWordRectAt = instance.getWordRectAt;
    }
    if (mouseTracking && typeof instance.getLineRectAt === 'function') {
      store.getLineRectAt = instance.getLineRectAt;
    }
    if (mouseTracking && typeof instance.getSelectionRows === 'function') {
      store.getRenderSelectionRows = instance.getSelectionRows;
    }
    // [mixdog] One-shot full clear+repaint. The app's mouse handler fires it on
    // every button press under Windows Terminal to dismiss WT's persistent
    // NATIVE (shift+drag) selection overlay, which survives incremental
    // repaints and would otherwise sit on top of the app-drawn selection.
    if (mouseTracking && typeof instance.forceFullRepaint === 'function') {
      store.forceRenderRepaint = instance.forceFullRepaint;
    }
    await waitUntilExit();
  } finally {
    stopPerfProbe();
    stopLoopProbe();
    for (const [stream, event, handler] of stdioDeathListeners.splice(0)) {
      try { stream.off(event, handler); } catch { /* ignore */ }
    }
    signalCleanup.uninstall();
    try {
      await disposeStoreOnce('cli-react-exit');
    } catch (error) {
      tuiExitDebug('store:dispose:failed', { error: error?.message || String(error) });
    }
    restoreTerminal();
    dumpActiveHandles('after-restore');
    restoreConsole();
    restoreStderr();
  }
  scheduleHardExit(0);
  return 0;
}
