// Scoped scratch directories for tests: every directory this module creates is
// named `mixdog-<prefix>-*` in the system temp dir and is removed whether the
// test passed or failed. Removal retries a bounded number of times, because on
// Windows a just-closed file or a just-exited child can hold a path for a
// moment (EBUSY / EPERM / ENOTEMPTY).
//
// Pick the narrowest scope that fits the test:
//   tempDirFor(t, prefix)            removed after the node:test context `t`
//   scopedTempDir(prefix)            `.path` + dispose; use `await using` on
//                                    Node 24+, or `try { } finally { await d.remove() }`
//   withTempDir(prefix, fn)          removed when `fn` settles
//   makeTempDirSync(prefix)          removed by removeTempDirSync, and always swept at
//                                    process exit (a late write may recreate it)
// Close anything holding files inside the directory (sqlite handles, servers,
// child processes) before the removal runs.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { removeTempDirSync as removeDirWithRetrySync } from './stale-temp.mjs';

const live = new Set();
let exitHookInstalled = false;

function directoryPrefix(prefix) {
  const bare = String(prefix)
    .replace(/^mixdog-/, '')
    .replace(/-+$/, '');
  return `mixdog-${bare}-`;
}

function removeAllAtExit() {
  for (const dir of live) removeDirWithRetrySync(dir);
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', removeAllAtExit);
  // A module under test may add its own exit handler (a final flush can
  // recreate its directory), so keep this one the last to run.
  process.on('newListener', (event, listener) => {
    if (event !== 'exit' || listener === removeAllAtExit) return;
    queueMicrotask(() => {
      process.removeListener('exit', removeAllAtExit);
      process.on('exit', removeAllAtExit);
    });
  });
}

/** Creates `mixdog-<prefix>-*` in the system temp dir; removed at process exit unless removed sooner. */
export function makeTempDirSync(prefix) {
  const dir = mkdtempSync(join(tmpdir(), directoryPrefix(prefix)));
  live.add(dir);
  installExitHook();
  return dir;
}

/**
 * Registers a directory its creator made as test-owned, so it is swept again
 * as the last exit step (a late write by the code under test can recreate it
 * after the creator's own exit handler ran). Only an exact `mixdog-*` child of
 * the system temp dir is accepted; nothing is ever inferred from an env var.
 */
export function registerOwnedTempDir(dir) {
  const resolved = resolve(dir);
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!basename(resolved).startsWith('mixdog-') || !same(dirname(resolved), resolve(tmpdir()))) {
    throw new Error(`refusing to own a directory outside the system temp root: ${dir}`);
  }
  live.add(resolved);
  installExitHook();
  return resolved;
}

/**
 * For code under test that makes its own mixdog-* directories in the system
 * temp dir: points TEMP/TMP/TMPDIR at one scoped directory for the rest of the
 * process, so everything created there is removed with it at exit.
 */
export function redirectSystemTemp(prefix = 'temp-root') {
  const dir = makeTempDirSync(prefix);
  process.env.TEMP = dir;
  process.env.TMP = dir;
  process.env.TMPDIR = dir;
  return dir;
}

export function removeTempDirSync(dir) {
  if (!removeDirWithRetrySync(dir)) process.stderr.write(`scratch folder ${dir} could not be removed\n`);
}

export async function removeTempDir(dir) {
  removeTempDirSync(dir);
}

/** A directory removed after the node:test context (test or suite) `t` finishes, pass or fail. */
export function tempDirFor(t, prefix) {
  const dir = makeTempDirSync(prefix);
  t.after(() => removeTempDir(dir));
  return dir;
}

/** A directory with `.path`, `join()` and `remove()`; also `await using` / `using` disposable. */
export function scopedTempDir(prefix) {
  const path = makeTempDirSync(prefix);
  return {
    path,
    join: (...parts) => join(path, ...parts),
    remove: () => removeTempDir(path),
    removeSync: () => removeTempDirSync(path),
    [Symbol.asyncDispose]: () => removeTempDir(path),
    [Symbol.dispose]: () => removeTempDirSync(path),
  };
}

/** Runs `fn(dir)` with a fresh directory and removes it when `fn` settles. */
export async function withTempDir(prefix, fn) {
  const dir = makeTempDirSync(prefix);
  try {
    return await fn(dir);
  } finally {
    await removeTempDir(dir);
  }
}
