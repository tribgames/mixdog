// Code-graph prewarm worker. Runs the heavy CPU/sync-fs traversal in a
// dedicated worker thread so the main event loop (Claude stream readers,
// MCP socket pumps, aiWrapped worker startup) is never starved
// by a cold build (~3s typical, 90s outlier observed in PG telemetry).
//
// Contract:
//  - cwd arrives via workerData.cwd.
//  - On success: the graph is posted in ack-paced chunks
//    (_postCodeGraphWorkerSuccess) and reassembled by the main thread, which
//    seeds _codeGraphCache directly. Maps/Sets of plain objects only.
//  - On any failure: postMessage({ ok: false, error }). Main thread propagates
//    the worker error — find_symbol / code_graph tools throw. No sync fallback.
import { parentPort, workerData } from 'node:worker_threads';
import { _buildCodeGraph, _postCodeGraphWorkerSuccess } from './code-graph.mjs';

const cwd = workerData?.cwd ? workerData.cwd : null;

if (!parentPort) {
  // Standalone execution makes no sense for this entry; bail silently so
  // the main thread sees a worker exit without a message and treats it as
  // "prewarm never ran".
  process.exit(0);
}

try {
  if (!cwd) {
    parentPort.postMessage({ ok: false });
  } else {
    const buildOptions = {
      manifest: Array.isArray(workerData.manifest) ? workerData.manifest : null,
      signature: typeof workerData.signature === 'string' ? workerData.signature : null,
      ...(workerData.buildOptions && typeof workerData.buildOptions === 'object' ? workerData.buildOptions : {}),
    };
    const graph = await _buildCodeGraph(cwd, buildOptions);
    if (graph && typeof graph.signature === 'string') {
      await _postCodeGraphWorkerSuccess(graph, (message) => parentPort.postMessage(message), undefined, {
        cache: buildOptions.cache,
        // Chunks are paced by the main thread's ack (see build.mjs).
        nextChunk: () => new Promise((resolve) => parentPort.once('message', resolve)),
      });
    } else {
      parentPort.postMessage({ ok: false });
    }
  }
} catch (error) {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  parentPort.postMessage(message ? { ok: false, error: `${message} (cwd=${cwd})` } : { ok: false });
}
