// One save's three write-authority checks (upfront, after the scratch write,
// under the commit lock) read a file this process did not write strictly ONCE,
// and reuse that verdict only while the full stamp is identical. Any
// replacement between the checks is read strictly again and refused, and no
// verdict outlives the save that read it.
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-write-admission-attempt-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));

const { saveSession, drainSessionStore } = await import('../store.mjs');
const { _shouldDrop } = await import('./write-admission.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');

test.after(async () => {
  drainSessionStore();
  await settleSessionSummaryIndex();
  rmSync(root, { recursive: true, force: true });
});

const fileOf = (id) => join(root, 'sessions', `${id}.json`);
const record = (id, extra = {}) =>
  JSON.stringify({ id, closed: false, generation: 1, messages: [{ role: 'user', content: 'x'.repeat(4096) }], ...extra });
// Another process's writer: rename into place (never this realm's commit).
const replace = (id, text) => {
  writeFileSync(`${fileOf(id)}.other`, text);
  renameSync(`${fileOf(id)}.other`, fileOf(id));
};

function countReads(t, path) {
  const original = fs.readFileSync;
  let count = 0;
  fs.readFileSync = function (file, ...rest) {
    if (String(file) === path) count++;
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  });
  return () => count;
}

test('a save over a foreign-but-unchanged file reads it strictly exactly once', (t) => {
  const id = 'sess_attempt_once';
  replace(id, record(id));
  const session = JSON.parse(record(id));
  session.messages.push({ role: 'assistant', content: 'reply' });
  const reads = countReads(t, fileOf(id));
  saveSession(session, { sync: true, expectedGeneration: 1 });
  assert.equal(reads(), 1, 'pre-admission and three checks, one strict read');
  assert.equal(JSON.parse(readFileSync(fileOf(id), 'utf8')).messages.length, 2);
});

test('a replacement between the checks of one save is read strictly and refused', (t) => {
  const id = 'sess_attempt_replaced';
  replace(id, record(id));
  const reads = countReads(t, fileOf(id));
  const attempt = {};
  assert.equal(_shouldDrop(id, { expectedGeneration: 1 }, attempt), false);
  assert.equal(_shouldDrop(id, { expectedGeneration: 1 }, attempt), false);
  assert.equal(reads(), 1);
  // Another writer's rename lands before the commit-lock check.
  replace(id, record('sess_attempt_foreign'));
  assert.equal(_shouldDrop(id, { expectedGeneration: 1 }, attempt), true, 'foreign record refused');
  assert.equal(reads(), 2, 'the replacement was read strictly');
  // A same-id takeover (generation moved on) is also read strictly and refused.
  replace(id, record(id, { generation: 2 }));
  assert.equal(_shouldDrop(id, { expectedGeneration: 1 }, attempt), true);
  assert.equal(reads(), 3);
});

test('no verdict is reused across saves', (t) => {
  const id = 'sess_attempt_separate';
  replace(id, record(id));
  const reads = countReads(t, fileOf(id));
  assert.equal(_shouldDrop(id, { expectedGeneration: 1 }, {}), false);
  assert.equal(_shouldDrop(id, { expectedGeneration: 1 }, {}), false);
  assert.equal(_shouldDrop(id, { expectedGeneration: 1 }), false);
  assert.equal(reads(), 3, 'each save (and each unscoped check) reads strictly');
});
