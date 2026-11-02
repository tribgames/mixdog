// Reads and parses one call-site sidecar off the daemon main thread and posts
// it back in small chunks: `{ entries: [[rel, [fp, calls], bytes], …] }` …
// `{ done: true }`. A chunk is a few thousand call tuples, so receiving one is
// a short main-thread stretch, where one 30+ MB JSON.parse (or a single
// structured clone of the whole parsed payload) held it for hundreds of ms.
// `bytes` is each call list's retained size under the graph size estimator.
// After each chunk the worker waits for the receiver's ack, so chunks arrive
// one per main-thread event-loop turn instead of being read back to back.
import { parentPort, workerData } from 'node:worker_threads';
import { readCallsSidecarPayload } from './calls-cache.mjs';
import { _estimateValueBytes } from './graph-model.mjs';

const CHUNK_TUPLES = 20_000;
const ack = () => new Promise((resolve) => parentPort.once('message', resolve));
const payload = readCallsSidecarPayload(workerData.file);
let entries = [];
let tuples = 0;
for (const [rel, entry] of Object.entries(payload?.files || {})) {
  const calls = Array.isArray(entry) ? entry[1] : null;
  entries.push([rel, entry, Array.isArray(calls) ? _estimateValueBytes(calls) : 0]);
  tuples += Array.isArray(calls) ? calls.length + 1 : 1;
  if (tuples >= CHUNK_TUPLES) {
    parentPort.postMessage({ entries });
    entries = [];
    tuples = 0;
    await ack();
  }
}
if (entries.length) {
  parentPort.postMessage({ entries });
  await ack();
}
parentPort.postMessage({ done: true, found: Boolean(payload) });
