import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import { cleanMemoryText } from './lib/memory-extraction.mjs';

// Fully isolated service: temp data/home/runtime roots, no HTTP listener
// (integrated daemon host), no background cycles, and a recording fake store
// in place of PostgreSQL.
const directory = mkdtempSync(join(tmpdir(), 'mixdog-append-entry-'));
process.env.MIXDOG_DATA_DIR = join(directory, 'data');
process.env.MIXDOG_HOME = join(directory, 'home');
process.env.MIXDOG_RUNTIME_ROOT = join(directory, 'runtime');
process.env.MIXDOG_DAEMON_HOST = '1';
process.env.MIXDOG_MEMORY_DISABLE_CYCLES = '1';
process.env.MIXDOG_QUIET_MEMORY_LOG = '1';

const entryInserts = [];
const fakeDb = {
  async query(sql, params = []) {
    if (/INSERT INTO entries/.test(sql)) {
      entryInserts.push(params);
      return { rows: [{ id: entryInserts.length }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
  async exec() {},
  async transaction(fn) {
    return fn(fakeDb);
  },
  async close() {},
};

mock.module('./lib/memory.mjs', {
  namedExports: {
    init: async () => {},
    resetEmbeddingColumnsForModel: async () => false,
    ensureCurrentSchemaExtensions: async () => {},
    openDatabase: async () => fakeDb,
    getDatabase: () => null,
    closeDatabase: async () => {},
    isBootstrapComplete: async () => true,
    getMetaValue: async (_db, _key, fallback = null) => fallback,
    setMetaValue: async () => {},
    mergeMetaValue: async () => {},
    embeddingToSql: (arr) => (Array.isArray(arr) ? `[${arr.join(',')}]` : null),
    cleanMemoryText,
    VALID_CATEGORY: new Set(['fact']),
  },
});

test('appendEntry stores the same scrubbed content the HTTP /entry route stores', async (t) => {
  const memory = await import('./index.mjs');
  t.after(async () => {
    await memory.stop().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });

  const raw = 'keep this decision <system-reminder>drop this reminder</system-reminder>';
  const stored = await memory.appendEntry({ content: raw, sessionId: 's1' });
  assert.equal(stored.ok, true);
  assert.equal(entryInserts.length, 1);
  assert.equal(entryInserts[0][2], cleanMemoryText(raw));
  assert.doesNotMatch(entryInserts[0][2], /drop this reminder/);

  const noiseOnly = await memory.appendEntry({ content: '<system-reminder>only noise</system-reminder>' });
  assert.deepEqual(noiseOnly, { error: 'empty after clean' });
  assert.equal(entryInserts.length, 1, 'content that is empty after cleaning is not stored');
});
