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
// Stamps younger than the racy window are never trusted.
await new Promise((resolve) => setTimeout(resolve, 2_200));

test.after(() => rmSync(root, { recursive: true, force: true }));

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
  replace(id, record(id, { model: 'model-b' }));
  assert.equal((await reader.readStoredSessionTranscript(id, { metadataOnly: true })).model, 'model-b');
  assert.equal(reads(id), 2);
  replace(id, record(`${id}_other`));
  assert.equal(await reader.readStoredSessionTranscript(id, { metadataOnly: true }), null);
  assert.equal(reads(id), 3);
});

test('catalog rows of never-indexed records are parsed once per stamp', (t) => {
  const id = ids[2];
  const reads = countReads(t);
  const row = () => reader.listStoredSessionSummaries().find((entry) => entry.id === id);
  assert.equal(row()?.preview, `hello from ${id}`);
  const first = reads(id);
  assert.ok(first <= 1);
  for (let round = 0; round < 3; round++) assert.ok(row());
  assert.equal(reads(id), first, 'no read while the stamp is unchanged');
  replace(id, record(id, { messages: [{ role: 'user', content: 'changed preview' }] }));
  assert.equal(row()?.preview, 'changed preview');
  assert.equal(reads(id), first + 1);
  replace(id, record(`${id}_other`));
  assert.equal(row(), undefined, 'a foreign record yields no row');
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
