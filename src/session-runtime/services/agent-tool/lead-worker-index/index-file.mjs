// The Lead pool index file: read the normalized rows, or rewrite them through
// the single in-process writer queue (index-write-queue.mjs) keyed by worker row.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createIndexWriteQueue } from '../index-write-queue.mjs';
import { workerRowKey } from '../worker-rows.mjs';
import { LEAD_WORKER_INDEX_FILE } from '../tool-def.mjs';
import { normalizeLeadRows } from './lead-rows.mjs';

function rewriteLeadDocument(current, mutator) {
  const byKey = new Map();
  for (const row of normalizeLeadRows(current)) byKey.set(workerRowKey(row), row);
  mutator(byKey);
  const workers = {};
  for (const row of byKey.values()) workers[workerRowKey(row)] = row;
  return { version: 1, updatedAt: new Date().toISOString(), workers };
}

function readDocument(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function createLeadIndexFile({ dataDir }) {
  const path = () => (dataDir ? resolve(dataDir, LEAD_WORKER_INDEX_FILE) : null);
  const file = path();
  const queue = createIndexWriteQueue({
    file,
    rewrite: rewriteLeadDocument,
    readDoc: () => readDocument(file),
  });

  // Reads see this process's own unpersisted writes.
  function read() {
    if (!file) return [];
    const doc = queue.projection();
    if (doc) return normalizeLeadRows(doc);
    const parsed = readDocument(file);
    return parsed ? normalizeLeadRows(parsed) : [];
  }

  const write = (mutator, options) => queue.write(mutator, options);

  return { path, read, write, flush: queue.flush, flushSync: queue.flushSync };
}
