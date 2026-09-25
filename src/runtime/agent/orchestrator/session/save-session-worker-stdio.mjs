// Route every stray stdout/stderr print of the save worker through the parent
// as a `{ __log }` message instead of worker stdio. Piped worker stdio
// (stdout:true) keeps the parent's event loop alive for the worker's lifetime
// once read, and default (copied) stdio bypasses the TUI's
// process.stderr.write guard and prints over the terminal frame. postMessage
// does neither: the parent writes the text through its own guarded stderr.
//
// Its own module, imported FIRST by save-session-worker.mjs: ES imports
// evaluate before the importing module's body, so only a module evaluated
// ahead of store.mjs can cover prints made while the store graph loads.
import { parentPort } from 'node:worker_threads';

function forwardWrite(chunk, encoding, callback) {
  try {
    parentPort.postMessage({ __log: typeof chunk === 'string' ? chunk : String(chunk) });
  } catch {
    /* best-effort */
  }
  const cb = typeof encoding === 'function' ? encoding : callback;
  if (typeof cb === 'function') cb();
  return true;
}
try {
  process.stdout.write = forwardWrite;
  process.stderr.write = forwardWrite;
} catch {
  /* best-effort: worker still functions with default stdio */
}
