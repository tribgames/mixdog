// The Lead pool index file: read the normalized rows, or rewrite them through
// one locked atomic update keyed by worker row.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { updateJsonAtomicSync } from '../../../runtime/shared/atomic-file.mjs';
import { workerRowKey } from '../worker-rows.mjs';
import { LEAD_WORKER_INDEX_FILE } from '../tool-def.mjs';
import { normalizeLeadRows } from './lead-rows.mjs';

export function createLeadIndexFile({ dataDir }) {
  const path = () => (dataDir ? resolve(dataDir, LEAD_WORKER_INDEX_FILE) : null);

  function read() {
    const file = path();
    if (!file) return [];
    try {
      return normalizeLeadRows(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return [];
    }
  }

  function write(mutator) {
    const file = path();
    if (!file || typeof mutator !== 'function') return null;
    try {
      return updateJsonAtomicSync(
        file,
        (current) => {
          const byKey = new Map();
          for (const row of normalizeLeadRows(current)) byKey.set(workerRowKey(row), row);
          mutator(byKey);
          const workers = {};
          for (const row of byKey.values()) workers[workerRowKey(row)] = row;
          return { version: 1, updatedAt: new Date().toISOString(), workers };
        },
        { lock: true }
      );
    } catch {
      return null;
    }
  }

  return { path, read, write };
}
