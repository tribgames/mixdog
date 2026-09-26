// A pane's cold transcript read, the durable existence check and the runtime's
// resume share ONE strict read of an unchanged file: the verdict and the parsed
// record are reused only under the full stamp the bytes provably came from.
// A replacement (another writer's rename, a foreign record) is always read
// strictly again, and the handed-over record is never aliased by the cached
// projection.
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

test('pane read, existence check and resume load share one strict read of an unchanged file', async (t) => {
  const id = ids[0];
  const onDisk = JSON.parse(readFileSync(fileOf(id), 'utf8'));
  const reads = countReads(t);
  const view = await reader.readStoredSessionTranscript(id, { transcriptItemLimit: 40 });
  assert.ok(view.items.length > 0);
  assert.equal(reads(id), 1);
  assert.equal(reader.storedSessionExists(id), true);
  const session = loadSession(id);
  // Exactly the record on disk (loadSession defaults a missing `tools`).
  assert.deepEqual(session, { ...onDisk, tools: [] });
  assert.equal(reads(id), 1, 'one read served all three');
  // The loaded record is the runtime's to mutate; the cached projection
  // never sees it.
  const itemsBefore = JSON.stringify(view);
  session.messages.push({ role: 'user', content: 'runtime-only turn' });
  session.model = 'mutated';
  session.modelParameters = { temperature: 1 };
  const again = await reader.readStoredSessionTranscript(id, { transcriptItemLimit: 40 });
  assert.equal(JSON.stringify(again), itemsBefore);
  assert.equal(reads(id), 1);
});

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

test('every pane read at boot hands over to its later resume, beyond the ordinary document budget', async (t) => {
  const reads = countReads(t);
  // Desktop restores every pane first; the resumes come after all of them.
  for (const id of bulk) await reader.readStoredSessionTranscript(id, { transcriptItemLimit: 40 });
  for (const id of bulk) {
    assert.equal(reader.storedSessionExists(id), true);
    assert.equal(loadSession(id).padding.length, 1_100_000);
  }
  assert.deepEqual(
    bulk.map(reads),
    bulk.map(() => 1),
    'one read per session: pane read, existence check and load'
  );
  assert.equal(sessionLoadCacheStats().pendingHandoffs, 0, 'every hand-off was claimed');
  assert.ok(sessionLoadCacheStats().chars <= 8 * 1024 * 1024, 'claimed documents obey the ordinary budget');
});

test('the pre-load existence check hands its strict parse to the load', (t) => {
  const id = 'sess_share_exists';
  const reads = countReads(t);
  assert.equal(reader.storedSessionExists(id), true);
  assert.equal(loadSession(id).id, id);
  assert.equal(reads(id), 1);
});

test('a replacement between the existence check and the load is read strictly and refused', (t) => {
  const id = 'sess_share_exists_foreign';
  const reads = countReads(t);
  assert.equal(reader.storedSessionExists(id), true);
  replace(id, record(`${id}_x`));
  assert.equal(loadSession(id), null, 'the pending parse of the old file is never served');
  assert.equal(reads(id), 2);
  assert.equal(sessionLoadCacheStats().pendingHandoffs, 0);
});

test('a pane read with a turn checkpoint hands over to the load its recovery performs', async (t) => {
  const id = 'sess_share_ckpt';
  const reads = countReads(t);
  const view = await reader.readStoredSessionTranscript(id, { transcriptItemLimit: 40 });
  assert.ok(view.items.length > 0);
  assert.equal(reads(id), 1, 'the recovery load claimed the pane parse');
});

test('an unclaimed hand-off (a pane nobody resumes) is released after its lifetime', async (t) => {
  const [id, next] = ['sess_share_ttl', 'sess_share_ttl_next'];
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const reads = countReads(t);
  await reader.readStoredSessionTranscript(id, { transcriptItemLimit: 40 });
  assert.ok(sessionLoadCacheStats().pendingHandoffs >= 1);
  t.mock.timers.tick(20_001);
  // The next hand-off sweeps expired ones (the unref'd timer does the same
  // when nothing else happens).
  await reader.readStoredSessionTranscript(next, { transcriptItemLimit: 40 });
  assert.equal(loadSession(id).id, id);
  assert.equal(reads(id), 2, 'the expired parse was released, so the load read the file');
  assert.equal(loadSession(next).id, next);
  assert.equal(reads(next), 1, 'a live hand-off is still claimed');
});

test('dropping a closed session from the load cache announces a release to the idle collector', async () => {
  const { createIdleGc } = await import('../../../../shared/idle-gc.mjs');
  const { forgetSessionLoadCache } = await import('./load-cache.mjs');
  process.env.MIXDOG_IDLE_GC_IDLE_MS = '1000';
  process.env.MIXDOG_IDLE_GC_MIN_HEAP_MB = '0';
  try {
    const gc = createIdleGc({ isBusy: () => false });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(await gc._tickForTest(), 'swept');
    assert.equal(await gc._tickForTest(), 'unchanged');
    forgetSessionLoadCache(ids[0]);
    assert.equal(await gc._tickForTest(), 'settling');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(await gc._tickForTest(), 'swept');
  } finally {
    delete process.env.MIXDOG_IDLE_GC_IDLE_MS;
    delete process.env.MIXDOG_IDLE_GC_MIN_HEAP_MB;
  }
});

test('a completed restore batch (every hand-off claimed) arms one idle sweep', async (t) => {
  const { createIdleGc } = await import('../../../../shared/idle-gc.mjs');
  process.env.MIXDOG_IDLE_GC_IDLE_MS = '1000';
  process.env.MIXDOG_IDLE_GC_MIN_HEAP_MB = '0';
  t.after(() => {
    delete process.env.MIXDOG_IDLE_GC_IDLE_MS;
    delete process.env.MIXDOG_IDLE_GC_MIN_HEAP_MB;
  });
  const id = 'sess_share_batch';
  const gc = createIdleGc({ isBusy: () => false });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(await gc._tickForTest(), 'swept');
  assert.equal(await gc._tickForTest(), 'unchanged');
  await reader.readStoredSessionTranscript(id, { transcriptItemLimit: 40 });
  assert.equal(sessionLoadCacheStats().pendingHandoffs, 1);
  assert.equal(await gc._tickForTest(), 'unchanged', 'a batch still in progress arms nothing');
  assert.equal(loadSession(id).id, id);
  assert.equal(sessionLoadCacheStats().pendingHandoffs, 0);
  assert.equal(await gc._tickForTest(), 'settling', 'the finished batch is a release');
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(await gc._tickForTest(), 'swept');
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
  assert.deepEqual(held.map(reads), held.map(() => 1), 'no whole-file read during activity');
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

test('bytes that changed under the read are neither handed over nor vouched for', async (t) => {
  const id = ids[3];
  let raced = false;
  const reads = countReads(t, (path) => {
    // A writer renames new bytes in between the reader's stat and read.
    if (!raced && path === fileOf(id)) {
      raced = true;
      replace(id, record(id, { model: 'model-raced' }));
    }
  });
  const view = await reader.readStoredSessionTranscript(id, { transcriptItemLimit: 40 });
  assert.equal(view.model, 'model-raced');
  assert.equal(reads(id), 1);
  assert.equal(reader.storedSessionExists(id), true);
  assert.equal(loadSession(id).model, 'model-raced');
  // Nothing from the pane read was reused: the existence check read the new
  // bytes strictly, and the load claimed that check's own parse.
  assert.equal(reads(id), 2, 'the existence check re-read strictly; the load used its parse');
});
