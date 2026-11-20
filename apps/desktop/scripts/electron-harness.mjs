import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import electron from 'electron';
import { build } from 'esbuild';

export function electronProcessEnv(extra = {}) {
  // A harness bundle runs from a temp directory, where native modules such as
  // koffi do not resolve; this names the app they resolve from. The bundle's own
  // location also holds no checkout for native-module.ts to find the main native
  // module (built by build-test-native.mjs) in, so its target dir is named here.
  const env = {
    ...process.env,
    CARGO_TARGET_DIR:
      process.env.CARGO_TARGET_DIR ?? fileURLToPath(new URL('../../../native/mixdog-main-native/target', import.meta.url)),
    MIXDOG_HARNESS_MODULES_FROM: fileURLToPath(new URL('../package.json', import.meta.url)),
    ...extra,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function spawnElectron(entry, { env = electronProcessEnv(), args = [], stdio = 'inherit' } = {}) {
  return spawn(electron, [entry, ...args], {
    env,
    stdio,
    windowsHide: true,
  });
}

export function waitForChildExit(
  child,
  {
    timeoutMs = 0,
    timeoutMessage,
    onTimeout = 'reject',
    rejectOnSignal = true,
    signalMessage = (signal) => `process was terminated by ${signal}`,
    fallbackCode = 1,
    onTimedOut,
  } = {}
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            onTimedOut?.();
            child.kill();
            if (onTimeout === 'reject') {
              finish(reject, new Error(timeoutMessage || `process exceeded ${timeoutMs}ms`));
            }
          }, timeoutMs)
        : null;
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

/**
 * A package a harness leaves outside its bundle is imported by its bare name from the bundle's own folder, a temp
 * directory: Node then finds whatever stands in a parent folder (a years-old `ws` in the user's home sent an Origin
 * header, which the core refuses with 403). Each such package but `electron` is named by the file this app resolves.
 */
function ownPackages(external) {
  const appRequire = createRequire(new URL('../package.json', import.meta.url));
  const names = external.filter((name) => name !== 'electron');
  return {
    name: 'own-packages',
    setup(setupBuild) {
      setupBuild.onResolve({ filter: /^[^./]/ }, (args) => {
        if (!names.includes(args.path)) return undefined;
        try {
          return { path: pathToFileURL(appRequire.resolve(args.path)).href, external: true };
        } catch {
          return undefined;
        }
      });
    },
  };
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
    plugins: [...plugins, ownPackages(external)],
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    sourcemap,
    logLevel: 'warning',
  });
  // Every Browser Use page window loads the page preload from the app path
  // (the entry's own directory) under out/preload, as the built app does
  // (src/main/browser/preload-path.ts).
  await build({
    entryPoints: [fileURLToPath(new URL('../src/preload/browser-page.ts', import.meta.url))],
    outfile: join(dirname(outfile), 'out', 'preload', 'browser-page.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
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
