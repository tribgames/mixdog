// A pane's cold transcript read and the runtime's resume each read a legacy
// record strictly: a parse is reused only under the full stamp the bytes
// provably came from, and a replacement (another writer's rename, a foreign
// record) is always read strictly again.
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-strict-read-share-'));
process.env.MIXDOG_DATA_DIR = root;
const sessionsDir = join(root, 'sessions');
mkdirSync(sessionsDir);

const ids = [
  'sess_share_boot',
  'sess_share_foreign',
  'sess_share_rewrite',
  'sess_share_racing',
  'sess_share_exists',
  'sess_share_exists_foreign',
  'sess_share_ckpt',
  'sess_share_ttl',
  'sess_share_ttl_next',
  'sess_share_batch',
];
// More pane reads than the ordinary eight-document / 8M-character budget holds.
const bulk = Array.from({ length: 12 }, (_, index) => `sess_share_bulk_${index}`);
// Live sessions held by their runtimes, more than the document budget holds.
const held = Array.from({ length: 10 }, (_, index) => `sess_share_held_${index}`);
const fileOf = (id) => join(sessionsDir, `${id}.json`);
const record = (id, extra = {}) =>
  JSON.stringify({
    id,
    owner: 'user',
    agent: 'lead',
    closed: false,
    generation: 1,
    model: 'model-a',
    updatedAt: 1,
    messages: [
      { role: 'user', content: `hello from ${id}` },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ],
    ...extra,
  });
// Another writer: every session writer replaces the file by rename.
const replace = (id, text) => {
  writeFileSync(`${fileOf(id)}.other`, text);
  renameSync(`${fileOf(id)}.other`, fileOf(id));
};
for (const id of ids) replace(id, record(id));
for (const id of bulk) replace(id, record(id, { padding: 'x'.repeat(1_100_000) }));
for (const id of held) replace(id, record(id, { padding: 'y'.repeat(1_100_000) }));
// A turn checkpoint makes the pane projection recover through loadSession.
mkdirSync(join(root, 'turn-checkpoints'));
writeFileSync(join(root, 'turn-checkpoints', 'sess_share_ckpt.json'), '{}');
// Stamps younger than the racy windows (2 s lifecycle, 2.5 s projection) are
// never trusted.
await new Promise((resolve) => setTimeout(resolve, 2_700));

const { loadSession } = await import('../store.mjs');
const reader = await import('../store-summary-reader.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');
const { sessionLoadCacheStats, forgetSessionLoadCache } = await import('./load-cache.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  rmSync(root, { recursive: true, force: true });
});

function countReads(t, onRead = null) {
  const original = fs.readFileSync;
  const counts = new Map();
  fs.readFileSync = function (file, ...rest) {
    const path = String(file);
    if (path.startsWith(sessionsDir)) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
      onRead?.(path);
    }
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  });
  return (id) => counts.get(fileOf(id)) ?? 0;
}

test('a foreign replacement after the shared read is read strictly and refused', async (t) => {
  const id = ids[1];
  const reads = countReads(t);
  await reader.readStoredSessionTranscript(id, { transcriptItemLimit: 40 });
  assert.equal(reads(id), 1);
  replace(id, record(`${id}_other`));
  assert.equal(reader.storedSessionExists(id), false);
  assert.equal(loadSession(id), null);
  assert.ok(reads(id) >= 3, 'both authorities read the replacement strictly');
});

test('another writer’s same-id rewrite after the shared read is loaded from its own bytes', async (t) => {
  const id = ids[2];
  const reads = countReads(t);
  await reader.readStoredSessionTranscript(id, { transcriptItemLimit: 40 });
  replace(id, record(id, { model: 'model-b', generation: 2 }));
  const session = loadSession(id);
  assert.equal(session.model, 'model-b');
  assert.equal(session.generation, 2);
  assert.equal(reads(id), 2);
});

test('dropping a closed session from the load cache announces a release to the idle collector', async (t) => {
  const { createIdleGc } = await import('../../../../shared/idle-gc.mjs');
  const { forgetSessionLoadCache } = await import('./load-cache.mjs');
  process.env.MIXDOG_IDLE_GC_IDLE_MS = '1000';
  process.env.MIXDOG_IDLE_GC_MIN_HEAP_MB = '0';
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const gc = createIdleGc({ isBusy: () => false });
    t.mock.timers.tick(1_100);
    assert.equal(await gc._tickForTest(), 'swept');
    assert.equal(await gc._tickForTest(), 'unchanged');
    forgetSessionLoadCache(ids[0]);
    assert.equal(await gc._tickForTest(), 'settling');
    t.mock.timers.tick(1_100);
    assert.equal(await gc._tickForTest(), 'swept');
  } finally {
    delete process.env.MIXDOG_IDLE_GC_IDLE_MS;
    delete process.env.MIXDOG_IDLE_GC_MIN_HEAP_MB;
  }
});

test('a live session released from the document budget is reloaded without a read while its file is unchanged', async (t) => {
  const { collectGarbageNow } = await import('../../../../shared/idle-gc.mjs');
  const reads = countReads(t);
  // Ten runtimes load and hold their sessions: more than eight documents.
  let sessions = held.map((id) => loadSession(id));
  assert.ok(sessionLoadCacheStats().documents <= 8, 'the cache itself stays within budget');
  const again = held.map((id) => loadSession(id));
  assert.ok(
    again.every((session, index) => session === sessions[index]),
    'the same owned objects come back'
  );
  assert.deepEqual(
    held.map(reads),
    held.map(() => 1),
    'no whole-file read during activity'
  );
  // A closed/unloaded session is forgotten: its next load reads the file.
  forgetSessionLoadCache(held[0]);
  assert.equal(loadSession(held[0]).id, held[0]);
  assert.equal(reads(held[0]), 2);
  // Nothing is retained for its own sake: once no owner holds a released
  // document it is collected and the file is read again.
  sessions = null;
  again.length = 0;
  await new Promise((resolve) => setImmediate(resolve));
  await collectGarbageNow();
  await new Promise((resolve) => setImmediate(resolve));
  await collectGarbageNow();
  const before = held.slice(1).reduce((sum, id) => sum + reads(id), 0);
  for (const id of held.slice(1)) loadSession(id);
  const after = held.slice(1).reduce((sum, id) => sum + reads(id), 0);
  assert.ok(after > before, 'released documents without an owner were collected');
});
