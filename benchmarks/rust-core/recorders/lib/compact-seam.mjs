// Loaded into the embedding worker thread (`--import`): `node:child_process` as the embedding worker and the cache
// compression import it becomes a seam whose `execFile` reports each call to the parent (a `seam` message on the
// worker's own port, in order with the worker's messages) and answers it: `compact.exe` as `MIXDOG_SEAM_COMPACT` says
// (`ok`, or `fail` with an error), anything else (the load's CPU-affinity PowerShell) as done, so the host is untouched.
import { registerHooks } from 'node:module';
import { parentPort } from 'node:worker_threads';

const SEAM = 'mixdog-seam:child_process';
registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? '';
    if ((specifier === 'node:child_process' || specifier === 'child_process') && /embedding-(worker|model-cache-compression)\.mjs$/.test(parent)) {
      return { url: SEAM, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === SEAM) return { format: 'module', source: `export { execFile } from ${JSON.stringify(import.meta.url)};`, shortCircuit: true };
    return next(url, context);
  },
});

export function execFile(command, args, options, callback) {
  const { timeout, windowsHide, maxBuffer } = options ?? {};
  parentPort.postMessage({ type: 'seam', command, args, options: { timeout, windowsHide, maxBuffer } });
  const failed = command === 'compact.exe' && process.env.MIXDOG_SEAM_COMPACT === 'fail';
  queueMicrotask(() => (failed ? callback(new Error('Command failed: compact.exe')) : callback(null, '', '')));
}
