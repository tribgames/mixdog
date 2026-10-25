// The cold catalog reads a session file only when its content can have
// changed: existence, metadata, catalog rows and transcript projections of an
// unchanged, settled file are answered from its full stat stamp, while a
// changed or foreign file is always read and strictly parsed again.
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-reader-stamps-'));
process.env.MIXDOG_DATA_DIR = root;
const sessionsDir = join(root, 'sessions');
mkdirSync(sessionsDir);

const reader = await import('./store-summary-reader.mjs');

const ids = ['sess_stamp_exists', 'sess_stamp_meta', 'sess_stamp_list', 'sess_stamp_view'];
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
    messages: [{ role: 'user', content: `hello from ${id}` }],
    ...extra,
  });
// Every writer replaces the file by rename.
const replace = (id, text) => {
  writeFileSync(`${fileOf(id)}.tmp`, text);
  renameSync(`${fileOf(id)}.tmp`, fileOf(id));
};
for (const id of ids) replace(id, record(id));
// Stamps younger than the racy windows (2 s lifecycle, 2.5 s projection) are
// never trusted.
await new Promise((resolve) => setTimeout(resolve, 2_700));

test.after(async () => {
  // The cold projection loads the store, whose summary-index writes land in
  // the data dir after the read returns; let them finish before removing it.
  const { settleSessionSummaryIndex } = await import('./store/listing.mjs');
  await settleSessionSummaryIndex();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  // Modules the projection loaded flush into the data dir from their own exit
  // hooks and recreate it; this hook is registered after theirs, so it runs last.
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
});

function countReads(t) {
  const original = fs.readFileSync;
  const counts = new Map();
  fs.readFileSync = function (file, ...rest) {
    const path = String(file);
    if (path.startsWith(sessionsDir)) counts.set(path, (counts.get(path) ?? 0) + 1);
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  });
  return (id) => counts.get(fileOf(id)) ?? 0;
}

test('existence of an unchanged record is a stat; a foreign replacement is read and refused', (t) => {
  const id = ids[0];
  const reads = countReads(t);
  assert.equal(reader.storedSessionExists(id), true);
  const first = reads(id);
  assert.ok(first <= 1);
  for (let round = 0; round < 3; round++) assert.equal(reader.storedSessionExists(id), true);
  assert.equal(reads(id), first, 'no read while the stamp is unchanged');
  replace(id, record(`${id}_other`));
  assert.equal(reader.storedSessionExists(id), false, 'a foreign record is not this session');
  assert.equal(reads(id), first + 1, 'the replacement was read strictly');
  assert.equal(reader.storedSessionExists(id), false);
  assert.equal(reads(id), first + 2, 'and a fresh stamp is never trusted');
});

test('metadata of an unchanged record is served from its stamp; a change or a foreign file is read', async (t) => {
  const id = ids[1];
  const reads = countReads(t);
  const first = await reader.readStoredSessionTranscript(id, { metadataOnly: true });
  assert.equal(first.model, 'model-a');
  assert.equal(reads(id), 1);
  first.model = 'mutated by a caller';
  const again = await reader.readStoredSessionTranscript(id, { metadataOnly: true });
  assert.equal(again.model, 'model-a', 'callers cannot edit the cached value');
  assert.equal(reads(id), 1, 'no read while the stamp is unchanged');
  assert.equal(first.title, null);
  replace(id, record(id, { model: 'model-b', title: 'Stored title' }));
  const changed = await reader.readStoredSessionTranscript(id, { metadataOnly: true });
  assert.equal(changed.model, 'model-b');
  assert.equal(changed.title, 'Stored title', 'the record title is part of its metadata');
  assert.equal(reads(id), 2);
  replace(id, record(`${id}_other`));
  assert.equal(await reader.readStoredSessionTranscript(id, { metadataOnly: true }), null);
  assert.equal(reads(id), 3);
});

test('catalog rows of never-indexed records are parsed once per stamp', async (t) => {
  const id = ids[2];
  const reads = countReads(t);
  const row = () => reader.listStoredSessionSummaries().find((entry) => entry.id === id);
  assert.equal(row()?.preview, `hello from ${id}`);
  const first = reads(id);
  assert.ok(first <= 1);
  for (let round = 0; round < 3; round++) assert.ok(row());
  assert.equal(reads(id), first, 'no read while the stamp is unchanged');
  // A replacement under the same name by a writer that skips the index is
  // found by the catalog's background pass.
  replace(id, record(id, { messages: [{ role: 'user', content: 'changed preview' }] }));
  await reader.verifyStoredSessionCatalog();
  assert.equal(row()?.preview, 'changed preview');
  assert.equal(reads(id), first + 1);
  replace(id, record(`${id}_other`));
  await reader.verifyStoredSessionCatalog();
  assert.equal(row(), undefined, 'a foreign record yields no row');
});

test('one catalog row is read by id, only for a session the catalog lists', () => {
  const id = 'sess_stamp_row';
  replace(id, record(id, { title: 'Row title', lastUsedAt: 7 }));
  const row = reader.readStoredSessionCatalogRow(id);
  assert.deepEqual([row.id, row.title, row.preview, row.lastUsedAt], [id, 'Row title', `hello from ${id}`, 7]);
  replace(id, record(id, { sourceType: 'exec' }));
  assert.equal(reader.readStoredSessionCatalogRow(id), null, 'an exec run is never listed');
  replace(id, record(`${id}_other`));
  assert.equal(reader.readStoredSessionCatalogRow(id), null, 'a foreign record yields no row');
  assert.equal(reader.readStoredSessionCatalogRow('sess_stamp_absent'), null);
});

test('the cold-view projection of an unchanged record is not re-read', async (t) => {
  const id = ids[3];
  reader.clearStoredTranscriptCache();
  const reads = countReads(t);
  const first = await reader.readStoredSessionTranscript(id, { transcriptItemLimit: 40 });
  assert.equal(reads(id), 1);
  for (let round = 0; round < 3; round++) {
    assert.equal(await reader.readStoredSessionTranscript(id, { transcriptItemLimit: 40 }), first);
  }
  assert.equal(reads(id), 1);
  replace(id, record(id, { messages: [{ role: 'user', content: 'new turn' }] }));
  const changed = await reader.readStoredSessionTranscript(id, { transcriptItemLimit: 40 });
  assert.notEqual(changed, first);
  assert.equal(reads(id), 2);
});
