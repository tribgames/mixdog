'use strict';

import {
  finishProcessLifecycle,
  finishProcessLifecycleAsync,
  recordCatchableFatal,
} from './process-lifecycle.mjs';

const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

function errorText(error) {
  return error?.stack || error?.message || String(error);
}

function writeStderr(line) {
  try { process.stderr.write(`${line}\n`); } catch {}
}

export function signalExitCode(signal, fallback = 1) {
  return SIGNAL_EXIT_CODES[signal] || fallback;
}

export function waitWithTimeout(promise, timeoutMs, label = 'cleanup') {
  const ms = Math.max(1, Math.floor(Number(timeoutMs) || 1));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    Promise.resolve(promise)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

export function installProcessSignalCleanup({
  name = 'mixdog',
  signals = ['SIGINT', 'SIGTERM', 'SIGHUP'],
  timeoutMs = 6500,
  exit = true,
  fatal = true,
  beforeCleanup,
  cleanup,
  afterCleanup,
  restoreTerminal,
  log = writeStderr,
} = {}) {
  let installed = true;
  let running = false;
  let hardExitTimer = null;
  const handlers = [];

  const removeHandlers = () => {
    for (const [event, handler] of handlers.splice(0)) {
      try { process.removeListener(event, handler); } catch {}
    }
  };

  const hardExit = (code) => {
    try { restoreTerminal?.('forced-cleanup', { code }); } catch {}
    finishProcessLifecycle('forced-cleanup', code);
    try { process.exit(code); } catch {}
  };

  const run = async (reason = 'process-exit', {
    code = 0,
    shouldExit = false,
    error = null,
  } = {}) => {
    if (running) {
      if (shouldExit) hardExit(code);
      return false;
    }
    running = true;
    removeHandlers();
    let cleanupFailed = false;

    if (error) recordCatchableFatal(code);

    if (shouldExit) {
      hardExitTimer = setTimeout(() => hardExit(code), Math.max(1000, Number(timeoutMs) + 1000));
      if (typeof hardExitTimer.unref === 'function') hardExitTimer.unref();
    }

    if (error && typeof log === 'function') {
      log(`[${name}] ${reason}: ${errorText(error)}`);
    }

    try { globalThis.__mixdogShutdownProviderAdmission?.(reason); } catch {}
    try { globalThis.__mixdogDrainProviderConnections?.(reason); } catch {}
    try { beforeCleanup?.(reason, { code, error }); } catch (cleanupError) {
      cleanupFailed = true;
      if (typeof log === 'function') log(`[${name}] cleanup failed: ${errorText(cleanupError)}`);
    }
    try {
      if (typeof cleanup === 'function') {
        await waitWithTimeout(cleanup(reason, { code, error }), timeoutMs, `${name} shutdown`);
      }
    } catch (cleanupError) {
      cleanupFailed = true;
      if (typeof log === 'function') log(`[${name}] cleanup failed: ${errorText(cleanupError)}`);
    }
    try { afterCleanup?.(reason, { code, error }); } catch (cleanupError) {
      cleanupFailed = true;
      if (typeof log === 'function') log(`[${name}] cleanup failed: ${errorText(cleanupError)}`);
    }
    if (hardExitTimer) {
      clearTimeout(hardExitTimer);
      hardExitTimer = null;
    }
    running = false;
    if (shouldExit) {
      await finishProcessLifecycleAsync(
        cleanupFailed ? 'forced-cleanup' : error ? 'catchable-fatal-error' : 'clean-shutdown',
        code,
      );
      try { process.exit(code); } catch {}
    }
    return true;
  };

  const add = (event, handler) => {
    try {
      process.once(event, handler);
      handlers.push([event, handler]);
    } catch {}
  };

  for (const signal of signals) {
    if (!signal) continue;
    add(signal, () => {
      void run(signal, { code: signalExitCode(signal), shouldExit: exit });
    });
  }

  if (fatal) {
    add('uncaughtException', (error) => {
      // Run terminal restoration synchronously, before the async cleanup path
      // or its hard-exit fallback can be interrupted by another fatal error.
      try { restoreTerminal?.('uncaughtException', { code: 1, error }); } catch {}
      void run('uncaughtException', { code: 1, shouldExit: exit, error });
    });
    add('unhandledRejection', (error) => {
      try { restoreTerminal?.('unhandledRejection', { code: 1, error }); } catch {}
      void run('unhandledRejection', { code: 1, shouldExit: exit, error });
    });
  }

  return {
    run,
    uninstall() {
      if (!installed) return;
      installed = false;
      removeHandlers();
      if (hardExitTimer) {
        clearTimeout(hardExitTimer);
        hardExitTimer = null;
      }
    },
  };
}
