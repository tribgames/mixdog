// Test support for code that reads bridge discovery through its watched copy.
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { onBridgeDiscoveryChange } from './bridge-discovery.mjs';

/** The next read of `path` sees its bytes at once and returns them only on
 *  `release()`; `reached` resolves once it has read them. */
export function holdNextRead(t, path) {
  const readFile = fsp.readFile;
  let holdNext = true;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let reachedRead;
  const reached = new Promise((resolve) => {
    reachedRead = resolve;
  });
  t.mock.method(fsp, 'readFile', async (target, ...rest) => {
    const text = await readFile(target, ...rest);
    if (holdNext && String(target) === path) {
      holdNext = false;
      reachedRead();
      await held;
    }
    return text;
  });
  syncBuiltinESMExports();
  t.after(() => syncBuiltinESMExports());
  return { reached, release };
}

/** Resolves when the watched copy next changes the advertisement at `path`
 *  (subscribe before the write); rejects once `timeoutMs` passes without it. */
export function nextBridgeDiscoveryChange(path, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no discovery change of ${path} within ${timeoutMs}ms`));
    }, timeoutMs);
    const off = onBridgeDiscoveryChange((changed) => {
      if (changed !== path) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}
