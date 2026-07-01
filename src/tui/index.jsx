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
import { App } from './App.jsx';
import { createEngineSession } from './engine.mjs';
import { installProcessSignalCleanup } from '../runtime/shared/process-shutdown.mjs';
import { emitTerminalBackground, loadThemeSettingFromConfig, theme } from './theme.mjs';
import { POP_KITTY, DISABLE_MODIFY_OTHER_KEYS } from './keyboard-protocol.mjs';

const TERMINAL_MODE_RESET = '\x1b[?1006l\x1b[?1005l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[?25h';
const TERMINAL_OSC_RESET_BG = '\x1b]111\x07';
const TERMINAL_MODE_RESET_HIDDEN_CURSOR = TERMINAL_MODE_RESET.replace('\x1b[?25h', '\x1b[?25l');
const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
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

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// Lightweight render-frame profiler. Forked ink calls options.onRender with the
// per-frame render() wall time (renderNodeToOutput serialization). We aggregate
// and emit a rolling summary every PERF_REPORT_EVERY frames so typing latency
// can be measured without flooding output. Entirely no-op unless
// MIXDOG_TUI_PERF=1, so it costs nothing in normal runs.
const PERF_REPORT_EVERY = positiveIntEnv('MIXDOG_TUI_PERF_EVERY', 60);
function makeRenderProfiler() {
  if (!PERF_ENABLED) return undefined;
  let count = 0;
  let sum = 0;
  let max = 0;
  let slow = 0;
  return ({ renderTime } = {}) => {
    const ms = Number(renderTime) || 0;
    count += 1;
    sum += ms;
    if (ms > max) max = ms;
    if (ms >= 16) slow += 1;
    if (count >= PERF_REPORT_EVERY) {
      const avg = sum / count;
      try {
        process.stderr.write(
          `[mixdog-perf] frames=${count} avg=${avg.toFixed(2)}ms max=${max.toFixed(2)}ms slow16+=${slow}\n`,
        );
      } catch { /* ignore */ }
      count = 0; sum = 0; max = 0; slow = 0;
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

export async function runTui({ provider, model, toolMode, remote } = {}) {
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
        `${TERMINAL_MODE_RESET}\x1b[0 q${POP_KITTY}${DISABLE_MODIFY_OTHER_KEYS}\x1b[?1049l${TERMINAL_MODE_RESET}${TERMINAL_OSC_RESET_BG}`,
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

  let store;
  try {
    store = await createEngineSession({ provider, model, toolMode, remote });
    bootProfile('store:ready', { ms: (performance.now() - startedAt).toFixed(1) });
  } catch (error) {
    restoreTerminal();
    try { process.off('exit', restoreTerminal); } catch { /* ignore */ }
    restoreStderr();
    process.stderr.write(`mixdog: ${error?.message || error}\n`);
    return 1;
  }

  // Keep mouse handling app-owned by default: native terminal selections are
  // cleared by the fullscreen redraws that happen while a turn streams. Users
  // who prefer their terminal's native mouse behavior can opt out with
  // MIXDOG_TUI_MOUSE=0.
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
      restoreStderr();
    },
  });

  // exitOnCtrlC:false — App handles Ctrl+C as an interrupt/line-clear so Ink
  // does not exit abruptly. Explicit exits go through /exit or /quit so teardown
  // still restores the cursor, mouse mode, and alternate screen cleanly.
  try {
    const instance = render(<App store={store} />, { exitOnCtrlC: false, maxFps: 120, onRender: makeRenderProfiler() });
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
    await waitUntilExit();
  } finally {
    signalCleanup.uninstall();
    try {
      await disposeStoreOnce('cli-react-exit');
    } catch (error) {
      tuiExitDebug('store:dispose:failed', { error: error?.message || String(error) });
    }
    restoreTerminal();
    dumpActiveHandles('after-restore');
    restoreStderr();
  }
  scheduleHardExit(0);
  return 0;
}
