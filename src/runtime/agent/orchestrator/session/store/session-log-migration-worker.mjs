// Startup migration's off-thread half: builds and proves each legacy base
// (prepareLegacyBase) so the parse, serialize and verify work never runs on
// the daemon's event loop. Publishing stays with the claim holder.
import { parentPort, workerData } from 'node:worker_threads';
import { prepareLegacyBase } from './session-log-writer.mjs';

const loaderModule = await import(workerData.loaderUrl);
const loadLegacy = loaderModule[workerData.loaderExport];
if (typeof loadLegacy !== 'function') {
  throw new TypeError(`[session-log-migration] ${workerData.loaderExport} is not a function`);
}

parentPort.on('message', async ({ seq, jsonPath, logPath }) => {
  try {
    const prepared = await prepareLegacyBase({ jsonPath, logPath, loadLegacy });
    parentPort.postMessage({ seq, ok: true, prepared });
  } catch (err) {
    parentPort.postMessage({ seq, ok: false, code: err?.code || 'EUNKNOWN', message: String(err?.message || err) });
  }
});
