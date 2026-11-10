// An authoritative storage refresh awaits its reads, so local writes land while
// it runs. What it returns is storage as those writes left it: a session
// deleted (or updated) after the scan read its file is answered deleted (or
// updated), exactly as the cached listing answers it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _sessionSummary, settleSummaryIndexWrites } from '../store-summary-index.mjs';
import { listStoredSessionSummaries, listStoredSessionSummariesAsync } from './listing.mjs';
import { _queueSessionSummaryRemoval, _queueSessionSummaryUpsertRow } from './summary-cache.mjs';

const fsp = createRequire(import.meta.url)('node:fs/promises');
const previousDataDir = process.env.MIXDOG_DATA_DIR;
const root = mkdtempSync(join(tmpdir(), 'mixdog-refresh-reconcile-'));
test.after(async () => {
  await settleSummaryIndexWrites();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const record = (id, title) => ({
  id,
  owner: 'user',
  agent: 'lead',
  sourceType: 'lead',
  title,
  generation: 1,
  updatedAt: 1,
  messages: [{ role: 'user', content: `prompt ${id}` }],
});
const fileOf = (id) => join(root, 'sessions', `${id}.json`);

/** Runs `afterRead(path)` right after the scan's read of each session file
 *  has completed, before the scan goes on. */
function onSessionRead(t, afterRead) {
  const readFile = fsp.readFile;
  fsp.readFile = async function readThenAct(path, ...rest) {
    const text = await readFile.call(this, path, ...rest);
    afterRead(String(path));
    return text;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsp.readFile = readFile;
    syncBuiltinESMExports();
  });
}

test('a session deleted or updated after the scan read it is answered as that write left it', async (t) => {
  mkdirSync(join(root, 'sessions'));
  process.env.MIXDOG_DATA_DIR = root;
  writeFileSync(fileOf('victim'), JSON.stringify(record('victim', 'doomed')));
  writeFileSync(fileOf('renamed'), JSON.stringify(record('renamed', 'old title')));
  onSessionRead(t, (path) => {
    if (path === fileOf('victim')) {
      unlinkSync(fileOf('victim'));
      _queueSessionSummaryRemoval('victim');
    } else if (path === fileOf('renamed')) {
      const updated = record('renamed', 'new title');
      writeFileSync(fileOf('renamed'), JSON.stringify(updated));
      _queueSessionSummaryUpsertRow(_sessionSummary(updated));
    }
  });
  const refreshed = await listStoredSessionSummariesAsync({ refreshFromStorage: true });
  const cached = listStoredSessionSummaries();
  assert.deepEqual(
    refreshed.map((row) => row.id),
    ['renamed']
  );
  assert.deepEqual(
    cached.map((row) => row.id),
    ['renamed']
  );
  assert.equal(refreshed[0].title, 'new title');
  assert.equal(cached[0].title, 'new title');
});

// A refresh still awaiting reads of the dir it started in may finish after a
// switch to another dir: nothing it read may serve that other dir's files,
// even a file with the same name, size and mtime.
test('a refresh overtaken by a data-dir switch never serves its rows to the new dir', async (t) => {
  const pinned = new Date(Date.now() - 60_000);
  const seed = (title) => {
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-refresh-dir-switch-'));
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    mkdirSync(join(dir, 'sessions'));
    const file = join(dir, 'sessions', 'same.json');
    writeFileSync(file, JSON.stringify(record('same', title)));
    utimesSync(file, pinned, pinned);
    return { dir, file };
  };
  const before = seed('OLD');
  const after = seed('NEW');
  process.env.MIXDOG_DATA_DIR = before.dir;
  let overtaking = null;
  onSessionRead(t, (path) => {
    if (path !== before.file || overtaking) return;
    process.env.MIXDOG_DATA_DIR = after.dir;
    overtaking = listStoredSessionSummariesAsync({ refreshFromStorage: true });
  });
  await listStoredSessionSummariesAsync({ refreshFromStorage: true });
  assert.ok(overtaking, 'the switch landed while the first refresh was reading');
  const titles = (rows) => rows.map((row) => `${row.id}:${row.title}`);
  assert.deepEqual(titles(await overtaking), ['same:NEW']);
  const next = await listStoredSessionSummariesAsync({ refreshFromStorage: true });
  assert.deepEqual(titles(next), ['same:NEW']);
  await settleSummaryIndexWrites();
});
