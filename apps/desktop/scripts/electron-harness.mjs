import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import electron from 'electron';
import { build } from 'esbuild';

export function electronProcessEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function spawnElectron(entry, {
  env = electronProcessEnv(),
  args = [],
  stdio = 'inherit',
} = {}) {
  return spawn(electron, [entry, ...args], {
    env,
    stdio,
    windowsHide: true,
  });
}

export function waitForChildExit(child, {
  timeoutMs = 0,
  timeoutMessage,
  onTimeout = 'reject',
  rejectOnSignal = true,
  signalMessage = (signal) => `process was terminated by ${signal}`,
  fallbackCode = 1,
  onTimedOut,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      onTimedOut?.();
      child.kill();
      if (onTimeout === 'reject') {
        finish(reject, new Error(timeoutMessage || `process exceeded ${timeoutMs}ms`));
      }
    }, timeoutMs) : null;
    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code, signal) => {
      if (signal && rejectOnSignal && !timedOut) {
        finish(reject, new Error(signalMessage(signal)));
        return;
      }
      finish(resolve, code ?? fallbackCode);
    });
  });
}

export async function bundleElectronEntry({
  entry,
  outfile,
  plugins = [],
  external = ['electron'],
  sourcemap = false,
}) {
  await build({
    entryPoints: [entry instanceof URL ? fileURLToPath(entry) : entry],
    outfile,
    bundle: true,
    plugins,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    sourcemap,
    logLevel: 'warning',
  });
}

export async function withTempWorkspace(prefix, work, cleanup = {}) {
  const staging = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await work(staging);
  } finally {
    const options = { recursive: true, force: true };
    if (cleanup.maxRetries != null) options.maxRetries = cleanup.maxRetries;
    if (cleanup.retryDelay != null) options.retryDelay = cleanup.retryDelay;
    await rm(staging, options);
  }
}
