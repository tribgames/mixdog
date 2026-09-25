import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createCanonicalSessionReader, CANONICAL_RECORD_UNREADABLE } from './canonical-reader.mjs';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');

function sessionFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-canonical-reader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'session.json');
  // Every session writer replaces the file by rename.
  const replace = (text) => {
    writeFileSync(`${target}.tmp`, text);
    renameSync(`${target}.tmp`, target);
  };
  return { target, replace };
}

test('lifecycle cache keeps parsed fields only, never the file text, and misses on a same-size replacement', (t) => {
  const { target, replace } = sessionFile(t);
  const big = 'x'.repeat(20 * 1024 * 1024);
  replace(JSON.stringify({ id: 'mine', closed: false, generation: 1, messages: [{ content: big }] }));
  let reads = 0;
  const read = createCanonicalSessionReader({
    readText: (path) => {
      reads++;
      return readFileSync(path, 'utf-8');
    },
    // Every stamp is past the racy window.
    nowNs: () => BigInt(Date.now() + 60_000) * 1_000_000n,
  });
  gc();
  const baseline = process.memoryUsage().heapUsed;
  assert.deepEqual(read(target, true), { id: 'mine', closed: false, generation: 1 });
  gc();
  assert.ok(process.memoryUsage().heapUsed - baseline < 8 * 1024 * 1024, 'the 20 MB file text is not retained');
  assert.deepEqual(read.stats(), { entries: 1, retainedChars: 0 });
  assert.equal(read(target, true).generation, 1);
  assert.equal(reads, 1, 'unchanged stamp reuses the parsed verdict');
  assert.equal(read(target, true, { ownCommitsOnly: true }).generation, 1);
  assert.equal(reads, 2, 'own-commit-only reads never use the observation cache');
  replace(JSON.stringify({ id: 'them', closed: false, generation: 2, messages: [{ content: big }] }));
  assert.deepEqual(read(target, true), { id: 'them', closed: false, generation: 2 });
  assert.equal(reads, 3);
});

test('a freshly changed file is racy and is re-read until its stamp settles', (t) => {
  const { target, replace } = sessionFile(t);
  replace('{"id":"mine","closed":false,"generation":1}');
  let reads = 0;
  const read = createCanonicalSessionReader({
    readText: (path) => {
      reads++;
      return readFileSync(path, 'utf-8');
    },
  });
  read(target, true);
  read(target, true);
  assert.equal(reads, 2);
  assert.equal(read.stats().entries, 0);
});

test('cached authority reads current content and rejects tampering rather than serving stale ownership', () => {
  let raw = '{"id":"mine","closed":false,"generation":1,"messages":[]}';
  let reads = 0;
  const read = createCanonicalSessionReader({
    readText: () => {
      reads++;
      return raw;
    },
  });
  assert.equal(read('record', true).id, 'mine');
  assert.equal(read('record', true).generation, 1);
  assert.equal(reads, 2);
  raw = raw.replace('mine', 'them'); // identical length, different authority
  assert.equal(read('record', true).id, 'them');
  for (const invalid of [
    '{"id":"mine","id":"them"}',
    '{"id":"mine","messages":[],"messages":[]}',
    '{"id":"mine","closed":false,"clo\\u0073ed":true}',
    '{"id":"mine"} trailing',
    '{"id":"mine",',
  ]) {
    raw = invalid;
    assert.equal(read('record', true), CANONICAL_RECORD_UNREADABLE);
  }
  raw = '{"id":"mine","closed":true,"generation":2}';
  assert.deepEqual(read('record', true), { id: 'mine', closed: true, generation: 2 });
});

test('full lifecycle documents stay privately owned and cannot mutate cached authority', () => {
  const read = createCanonicalSessionReader({
    readText: () => '{"id":"mine","messages":[{"content":"original"}],"generation":1}',
  });
  read('record', true);
  const first = read('record');
  first.doc.messages[0].content = 'changed';
  first.doc.id = 'them';
  assert.equal(read('record').doc.messages[0].content, 'original');
  assert.equal(read('record', true).id, 'mine');
});

test('read failures discard authority and cache storage obeys both limits', () => {
  let code;
  const read = createCanonicalSessionReader({
    maxEntries: 2,
    maxTextChars: 60,
    readText: (id) => {
      if (code) throw Object.assign(new Error(code), { code });
      return JSON.stringify({ id });
    },
  });
  for (let index = 0; index < 20; index++) read(`record-${index}`, true);
  assert.ok(read.stats().entries <= 2);
  assert.ok(read.stats().retainedChars <= 60);
  code = 'EACCES';
  assert.equal(read('record-19', true), CANONICAL_RECORD_UNREADABLE);
  code = 'ENOENT';
  assert.equal(read('record-18', true), null);
  read.clear();
  assert.deepEqual(read.stats(), { entries: 0, retainedChars: 0 });
});
