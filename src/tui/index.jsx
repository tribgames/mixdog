/**
 * src/tui/index.jsx — entry that mounts the React/ink TUI.
 *
 * Creates the engine session (runs OUR agentLoop outside React) and ink-renders
 * <App store={...}/>. Resolves when the app exits (/exit or /quit).
 */
import React from 'react';
import { render } from 'ink';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { App } from './App.jsx';
import { normalizeStatusLine } from './components/StatusLine.jsx';
import { createEngineSession } from './engine.mjs';

const STATUSLINE_MODULE = import.meta.url.replace(/\\/g, '/').includes('/tui/dist/')
  ? '../../ui/statusline.mjs'
  : '../ui/statusline.mjs';

const TERMINAL_MODE_RESET = '\x1b[?1006l\x1b[?1005l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[?25h';
const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const BOOT_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_BOOT_PROFILE || ''));
const BOOT_PROFILE_START = globalThis.__mixdogBootProfileStart || (globalThis.__mixdogBootProfileStart = performance.now());
const EXIT_WAIT_TIMEOUT_MS = positiveIntEnv('MIXDOG_TUI_EXIT_WAIT_MS', 2500);
const EXIT_HARD_DELAY_MS = positiveIntEnv('MIXDOG_TUI_HARD_EXIT_DELAY_MS', 500);
const EXIT_HARD_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.MIXDOG_TUI_HARD_EXIT || '1'));
const EXIT_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_TUI_EXIT_DEBUG || ''));

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function readWindowsCodePage() {
  if (process.platform !== 'win32') return null;
  try {
    const result = spawnSync('chcp.com', [], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 1000,
    });
    const text = Buffer.isBuffer(result.stdout)
      ? result.stdout.toString('latin1')
      : String(result.stdout || '');
    const match = text.match(/(\d+)/);
    const page = match ? Number(match[1]) : 0;
    return Number.isFinite(page) && page > 0 ? page : null;
  } catch {
    return null;
  }
}

function setWindowsCodePage(page) {
  if (process.platform !== 'win32' || !page) return false;
  try {
    const result = spawnSync('chcp.com', [String(page)], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 1000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function installWindowsUtf8Console() {
  if (process.platform !== 'win32') return () => {};
  if (/^(0|false|no|off)$/i.test(String(process.env.MIXDOG_TUI_FORCE_UTF8_CONSOLE || '1'))) {
    return () => {};
  }
  const restoreCodePage = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_TUI_RESTORE_CODEPAGE || ''));
  try { process.stdout.setDefaultEncoding?.('utf8'); } catch {}
  try { process.stderr.setDefaultEncoding?.('utf8'); } catch {}
  const previousCodePage = readWindowsCodePage();
  if (previousCodePage && previousCodePage !== 65001) setWindowsCodePage(65001);
  return () => {
    if (restoreCodePage && previousCodePage && previousCodePage !== 65001) setWindowsCodePage(previousCodePage);
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
    try { process.stdout.write(TERMINAL_MODE_RESET); } catch { /* ignore */ }
    process.exit(code);
  }, EXIT_HARD_DELAY_MS);
  timer.unref?.();
}

function resolveTuiStderrLogPath() {
  return process.env.MIXDOG_TUI_STDERR_LOG
    || join(process.env.MIXDOG_RUNTIME_ROOT || join(tmpdir(), 'mixdog'), 'mixdog-cli-tui.stderr.log');
}

function installTuiStderrGuard() {
  if (process.env.MIXDOG_TUI_ALLOW_STDERR === '1') return () => {};
  const originalWrite = process.stderr.write.bind(process.stderr);
  const logPath = resolveTuiStderrLogPath();
  try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* ignore */ }

  process.stderr.write = ((chunk, encoding, callback) => {
    try {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      appendFileSync(logPath, text, 'utf8');
    } catch {
      // Last-resort fallback: if the log file is unavailable, drop diagnostics
      // while the fullscreen TUI owns the terminal.
    }
    if (typeof encoding === 'function') {
      try { encoding(); } catch { /* ignore */ }
    } else if (typeof callback === 'function') {
      try { callback(); } catch { /* ignore */ }
    }
    return true;
  });

  return () => {
    process.stderr.write = originalWrite;
  };
}

export async function runTui({ provider, model, toolMode } = {}) {
  const startedAt = performance.now();
  bootProfile('run:start', { provider, model, toolMode });
  // The React/ink TUI needs a raw-mode-capable TTY (interactive input). In a
  // pipe/redirect/CI, ink's input hooks throw — bail with a clear hint instead.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'mixdog-cli: the TUI needs an interactive terminal (TTY).\n' +
        'Run it directly in a terminal, or use --plain for the readline REPL.\n',
    );
    return 1;
  }

  const restoreConsoleEncoding = installWindowsUtf8Console();
  let consoleEncodingRestored = false;
  const restoreConsoleEncodingOnce = () => {
    if (consoleEncodingRestored) return;
    consoleEncodingRestored = true;
    try { restoreConsoleEncoding(); } catch { /* ignore */ }
  };
  const restoreStderr = installTuiStderrGuard();
  let store;
  try {
    store = await createEngineSession({ provider, model, toolMode });
    bootProfile('store:ready', { ms: (performance.now() - startedAt).toFixed(1) });
  } catch (error) {
    restoreStderr();
    restoreConsoleEncodingOnce();
    process.stderr.write(`mixdog-cli: ${error?.message || error}\n`);
    return 1;
  }

  let initialStatusLine = '';
  try {
    const state = store.getState();
    const { renderStatusline } = await import(STATUSLINE_MODULE);
    initialStatusLine = normalizeStatusLine(await renderStatusline({
      sessionId: state.sessionId,
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fast: state.fast,
      cwd: state.cwd,
      stats: state.stats,
      contextWindow: state.contextWindow,
      rawContextWindow: state.rawContextWindow,
    }));
    bootProfile('statusline:ready');
  } catch {
    initialStatusLine = '';
  }

  // Enter the alternate screen buffer for a true fullscreen UI: the input bar
  // pins to the physical bottom (App uses height={rows}) and, on exit, the
  // shell's original screen is restored untouched. \x1b[?1049h enters alt
  // screen; then clear it and home the cursor so we start from a clean top.
  process.stdout.write(`${TERMINAL_MODE_RESET}\x1b[?1049h${TERMINAL_MODE_RESET}\x1b[2J\x1b[H`);

  // Use a blinking BAR cursor (DECSCUSR 5) — a thin caret behind the text, not a
  // fat block. PromptInput parks this hardware cursor at the insertion point via
  // useCursor; the terminal also anchors IME composition to it.
  process.stdout.write('\x1b[5 q'); // blinking bar

  // Mouse tracking lets the app handle wheel scrolling and edge-drag transcript
  // scrolling. It routes drag selection through our Ink overlay; opt out with
  // MIXDOG_TUI_MOUSE=0 when native terminal selection is preferred.
  const mouseTracking = !/^(0|false|no|off)$/i.test(String(process.env.MIXDOG_TUI_MOUSE || '1'));
  if (mouseTracking) {
    process.stdout.write(MOUSE_TRACKING_ON);
  }

  let restored = false;
  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    try { process.stdout.write(`${TERMINAL_MODE_RESET}\x1b[0 q\x1b[?1049l${TERMINAL_MODE_RESET}`); } catch { /* ignore */ }
    restoreConsoleEncodingOnce();
  };
  process.on('exit', restoreTerminal);
  const restoreAndSignal = (signal) => {
    restoreTerminal();
    process.removeListener('SIGINT', restoreAndSignal);
    process.removeListener('SIGTERM', restoreAndSignal);
    process.kill(process.pid, signal);
  };
  process.once('SIGINT', restoreAndSignal);
  process.once('SIGTERM', restoreAndSignal);

  // exitOnCtrlC:false — keep Ctrl+C available for terminal copy behavior.
  // Explicit exits go through /exit or /quit so teardown still restores the
  // cursor, mouse mode, and alternate screen cleanly.
  try {
    const instance = render(<App store={store} initialStatusLine={initialStatusLine} />, { exitOnCtrlC: false, maxFps: 120 });
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
    await waitUntilExit();
  } finally {
    try {
      await waitWithTimeout(store.dispose?.(), EXIT_WAIT_TIMEOUT_MS);
    } catch (error) {
      tuiExitDebug('store:dispose:failed', { error: error?.message || String(error) });
    }
    process.removeListener('SIGINT', restoreAndSignal);
    process.removeListener('SIGTERM', restoreAndSignal);
    restoreTerminal();
    dumpActiveHandles('after-restore');
    restoreStderr();
    restoreConsoleEncodingOnce();
  }
  scheduleHardExit(0);
  return 0;
}
