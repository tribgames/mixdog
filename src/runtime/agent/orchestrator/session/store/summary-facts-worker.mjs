// Reads a log as the facts its summary row is made of, off the daemon's main
// thread (summary-cache.mjs, offload): a log of hundreds of megabytes is
// assembled and parsed here, so the event loop of the thread that awaits the
// storage refresh is never held by it. The scan state it keeps in memory
// (session-log-reader.mjs) lives as long as this worker does.
import { workerData } from 'node:worker_threads';
import { serveWorkerRequests } from '../../../../shared/worker-requests.mjs';

if (workerData?.dataDir) process.env.MIXDOG_DATA_DIR = String(workerData.dataDir);

const { readStoredRecordAsFacts } = await import('./summary-cache.mjs');
const { STORED_SESSION_UNREADABLE } = await import('./serialize.mjs');

serveWorkerRequests(async ({ storageId }) => {
  const record = await readStoredRecordAsFacts(storageId);
  // A symbol does not cross a thread boundary.
  return record.session === STORED_SESSION_UNREADABLE ? { unreadable: true } : record;
});