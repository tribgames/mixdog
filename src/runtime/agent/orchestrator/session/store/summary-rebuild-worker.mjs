import { parentPort, workerData } from 'node:worker_threads';

const dataDir = String(workerData?.dataDir || '');
if (dataDir) process.env.MIXDOG_DATA_DIR = dataDir;

try {
  const [{ _scanStoredSessionSummaryRowsAsync }, { _writeSummaryIndex }] = await Promise.all([
    import('./summary-cache.mjs'),
    import('../store-summary-index.mjs'),
  ]);
  const { rows } = await _scanStoredSessionSummaryRowsAsync();
  const indexedRows = await _writeSummaryIndex(rows);
  parentPort?.postMessage({ ok: true, dataDir, rows: indexedRows });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    dataDir,
    error: error?.message || String(error),
  });
}
