import { parentPort, workerData } from 'worker_threads';

const dataDir = String(workerData?.dataDir || '');
if (dataDir) process.env.MIXDOG_DATA_DIR = dataDir;

try {
    const [{ _scanStoredSessionSummaryRows }, { _writeSummaryIndex }] = await Promise.all([
        import('./summary-cache.mjs'),
        import('../store-summary-index.mjs'),
    ]);
    const { rows } = _scanStoredSessionSummaryRows();
    const indexedRows = _writeSummaryIndex(rows);
    parentPort?.postMessage({ ok: true, dataDir, rows: indexedRows });
} catch (error) {
    parentPort?.postMessage({
        ok: false,
        dataDir,
        error: error?.message || String(error),
    });
}
