// Test support for code that reads bridge discovery through its watched copy.
import { onBridgeDiscoveryChange } from './bridge-discovery.mjs';

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
