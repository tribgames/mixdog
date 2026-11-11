#!/usr/bin/env node
// `memory` `action:"status"` and the cycle state file the statusline reads, from Node's memory runtime: a throwaway profile
// whose store is seeded (`seedSql`, run on `openDatabase` of src/runtime/memory/lib/memory.mjs, then closed), then `init()` of
// src/runtime/memory/index.mjs (which starts the cycles: the ledger writes `memory-cycle-state.json` and hydrates the last
// cycle1 success from the store), then `handleToolCall('memory', { action: 'status' })` (maintenance-actions.mjs:25).
// Recorded: the tool result and the state file once the hydration wrote it (awaited on the file, with a deadline).
// `Date.now()` stands still at `clockMs`; nothing waits on time.
//
//   node benchmarks/rust-core/recorders/record-memory-status.mjs --tree <dir>
import { mkdtempSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { begin, capture, finish, freezeClock, importFrom, within } from './lib/mc-record.mjs';

const ctx = begin();
const CLOCK_MS = Date.parse('2025-06-01T00:00:00Z');
freezeClock(CLOCK_MS);
const SCRATCH = process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:/mixdog-build/tmp/w23/rec';
const dataDir = mkdtempSync(join(SCRATCH, 'status-')).replaceAll('\\', '/');
Object.assign(process.env, { MIXDOG_DATA_DIR: dataDir, MIXDOG_HOME: dataDir, MIXDOG_MEMORY_DISABLE_LLM_WORKER: '1' });
delete process.env.MIXDOG_MEMORY_DISABLE_CYCLES;

const LAST_CYCLE1 = CLOCK_MS - 5 * 60_000 - 20_000;
const seedSql = [
  ...Array.from({ length: 10 }, (_, i) => `INSERT INTO entries (ts, role, content, source_ref, is_root) VALUES (${i}, 'user', 'x', 'ref-${i}', ${i < 4 ? 1 : 0})`),
  'UPDATE entries SET chunk_root = id WHERE is_root = 1',
  // One status only: Node's `GROUP BY status` has no ORDER BY, so two statuses come in the hash aggregate's order.
  "UPDATE entries SET category = CASE WHEN id <= 3 THEN 'decision' ELSE 'fact' END, status = 'pending'::entry_status WHERE is_root = 1",
  "INSERT INTO core_entries (element, summary, category, project_id, agent_id, created_at, updated_at) VALUES ('tone', 'Answer briefly', 'rule', NULL, NULL, 0, 0)",
  `INSERT INTO meta (key, value) VALUES ('state.cycle_last_run', '{"cycle1": ${LAST_CYCLE1}, "cycle1_heartbeat": ${LAST_CYCLE1}}'::jsonb)`,
].join(';\n');

const { openDatabase, closeDatabase } = await importFrom(ctx.tree, 'src/runtime/memory/lib/memory.mjs');
const pgAdapter = await importFrom(ctx.tree, 'src/runtime/memory/lib/pg/adapter.mjs');
const seeded = await openDatabase(dataDir, 384, null);
await seeded.exec(seedSql);
await closeDatabase(dataDir);

const stateFile = join(dataDir, 'memory-cycle-state.json');
const hydrated = () => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')).cycles.cycle1.last_success_at === LAST_CYCLE1;
  } catch {
    return false;
  }
};
// The hydration's write, awaited on the file (the ledger writes it by rename).
const hydration = new Promise((resolve) => {
  const watcher = watch(dataDir, () => {
    if (hydrated()) {
      watcher.close();
      resolve();
    }
  });
});

const memory = await importFrom(ctx.tree, 'src/runtime/memory/index.mjs');
await memory.init();
if (!hydrated()) await within('the ledger hydration', hydration);
const stateFileText = readFileSync(stateFile, 'utf8');
const status = await capture(() => memory.handleToolCall('memory', { action: 'status' }));

finish(ctx, {
  url: import.meta.url,
  set: 'memory-status',
  flags: '',
  golden: { clockMs: CLOCK_MS, seedSql, args: { action: 'status' }, status, stateFile: JSON.parse(stateFileText) },
  extra: {
    entry: 'src/runtime/memory/index.mjs init() (its cycle start writes memory-cycle-state.json), handleToolCall("memory", { action: "status" })',
    replay: 'native/core/crates/mixdog-services/src/memory/tests/status.rs',
    exclusions: 'none',
    normalised: 'none',
  },
});
await memory.stop().catch(() => {});
await pgAdapter.shutdownOwnedPg({ timeoutMs: 20_000 }).catch(() => {});
process.exit(0);
