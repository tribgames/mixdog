// Test helpers for caches built on watched-file-cache.mjs.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const SYNC_FS = ['statSync', 'lstatSync', 'readFileSync', 'existsSync', 'openSync', 'readSync', 'readdirSync', 'mkdirSync'];

/** Records every synchronous fs call (named imports included) until the test
 *  ends; set `calls.paused` to ignore a stretch. */
export function spySyncFs(t) {
  const calls = [];
  for (const name of SYNC_FS) {
    const original = fs[name];
    t.mock.method(fs, name, function (...args) {
      if (!calls.paused) calls.push(name);
      return original.apply(this, args);
    });
  }
  syncBuiltinESMExports();
  t.after(() => syncBuiltinESMExports());
  return calls;
}

/** Directories with an `fs.watch` opened since this call and not yet closed. */
export function trackWatchers(t) {
  const original = fs.watch;
  const open = [];
  t.mock.method(fs, 'watch', (dir, ...rest) => {
    const watcher = original(dir, ...rest);
    const entry = { dir: String(dir) };
    open.push(entry);
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      const index = open.indexOf(entry);
      if (index >= 0) open.splice(index, 1);
      return close();
    };
    return watcher;
  });
  return () => open.map((entry) => entry.dir).sort();
}

/** Holds the next fs/promises stat until the returned release is called. */
export function gateFirstAsyncStat(t) {
  const original = fsp.stat;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  t.mock.method(fsp, 'stat', async (...args) => {
    if (first) {
      first = false;
      await gate;
    }
    return original(...args);
  });
  return () => release();
}

export const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

export async function eventually(check, { timeoutMs = 5_000 } = {}) {
  for (let waited = 0; ; waited += 10) {
    if (check()) return;
    if (waited >= timeoutMs) throw new Error('condition not reached');
    await settle(10);
  }
}
