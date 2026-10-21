// The cache holds the revocations asked for while the relay was away. A file
// that is damaged has lost them, and nothing older can prove otherwise: it must
// read as "repair required", never as an empty queue.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadRemoteClientCache } from './remote-client-cache.ts';

const FILE = 'remote-clients.json';
const client = (id) => ({
  id,
  name: 'Phone',
  platform: 'ios',
  browser: 'Safari',
  createdAt: 1,
  lastSeenAt: 2,
  online: true,
});

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-remote-clients-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const stored = (dir) => JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
const asideNames = (dir) => readdirSync(dir).filter((name) => name.startsWith(`${FILE}.corrupt-`));

test('a cache that was saved loads again, with nothing to repair', async (t) => {
  const dir = tempDir(t);
  const cache = await loadRemoteClientCache(dir);
  await cache.remember([client('c1')]);
  await cache.queueRevoke('c1');
  const reloaded = await loadRemoteClientCache(dir);
  assert.deepEqual(reloaded.pending(), ['c1']);
  assert.deepEqual(
    reloaded.list().map((row) => row.id),
    ['c1']
  );
  assert.equal(reloaded.repairRequired(), false);
});

test('a cache that was never written is empty and needs no repair', async (t) => {
  const dir = tempDir(t);
  const cache = await loadRemoteClientCache(dir);
  assert.equal(cache.repairRequired(), false);
  assert.deepEqual(readdirSync(dir), [], 'loading writes nothing');
});

test('a NUL-filled cache asks for repair, is kept aside, and the request survives a restart', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, FILE), Buffer.alloc(160));
  const cache = await loadRemoteClientCache(dir);
  assert.deepEqual(cache.list(), []);
  assert.deepEqual(cache.pending(), []);
  assert.equal(cache.repairRequired(), true);
  assert.deepEqual(readFileSync(join(dir, asideNames(dir)[0])), Buffer.alloc(160));
  assert.equal(stored(dir).repairRequired, true, 'the flag replaces the damaged bytes on disk');
  assert.equal((await loadRemoteClientCache(dir)).repairRequired(), true, 'a crash before the repair asks again');
});

test('truncated JSON, an empty file and a non-object root are damage', async (t) => {
  for (const content of ['{"clients":[{"id":"c1","na', '', '[]', 'null']) {
    const dir = tempDir(t);
    writeFileSync(join(dir, FILE), content);
    assert.equal((await loadRemoteClientCache(dir)).repairRequired(), true, JSON.stringify(content));
  }
});

test('a well-formed JSON object with a wrong-shaped revocation record is damage, not an empty list', async (t) => {
  const records = [
    '{}',
    '{"clients":[]}',
    '{"pendingRevokes":{}}',
    '{"pendingRevokes":"c1"}',
    '{"pendingRevokes":null}',
    '{"pendingRevokes":[1]}',
    '{"pendingRevokes":[{"id":"c1"}]}',
    '{"pendingRevokes":["c1",2]}',
    '{"pendingRevokes":["c1",null,"c2"],"clients":[]}',
    '{"pendingRevokes":[],"repairRequired":"yes"}',
  ];
  for (const content of records) {
    const dir = tempDir(t);
    writeFileSync(join(dir, FILE), content);
    const cache = await loadRemoteClientCache(dir);
    assert.equal(cache.repairRequired(), true, content);
    assert.deepEqual(cache.pending(), [], content);
    assert.equal(asideNames(dir).length, 1, `${content} is kept aside`);
    assert.equal(stored(dir).repairRequired, true, `${content} is replaced by the flag`);
  }
});

test('an older backup is never the pending queue: a damaged cache with one still asks for repair', async (t) => {
  const dir = tempDir(t);
  // The copy predates the latest revocation, which only the live file held.
  writeFileSync(join(dir, `${FILE}.bak`), JSON.stringify({ clients: [], pendingRevokes: ['c1'] }));
  writeFileSync(join(dir, FILE), '{"clients":[],"pendingRevokes":["c1","c2');
  const cache = await loadRemoteClientCache(dir);
  assert.deepEqual(cache.pending(), [], 'the stale copy is not consulted');
  assert.equal(cache.repairRequired(), true);
});

test('a cache that cannot be read is unverified, not empty', async (t) => {
  const dir = tempDir(t);
  // A directory where the file belongs cannot be read as a file (EISDIR).
  mkdirSync(join(dir, FILE));
  const cache = await loadRemoteClientCache(dir);
  assert.equal(cache.repairRequired(), true);
  assert.deepEqual(asideNames(dir), [], 'there are no bytes to keep');
});

test('changes keep the request until the pairing reset clears it', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, FILE), Buffer.alloc(32));
  const cache = await loadRemoteClientCache(dir);
  await cache.queueRevoke('c2');
  await cache.remember([client('c2')]);
  assert.equal(cache.repairRequired(), true);
  assert.deepEqual(stored(dir).pendingRevokes, ['c2']);
  assert.equal(stored(dir).repairRequired, true);
  await cache.clear();
  assert.equal(cache.repairRequired(), false);
  assert.deepEqual(cache.pending(), []);
  assert.equal((await loadRemoteClientCache(dir)).repairRequired(), false, 'cleared for good');
});

test('writes land in order and leave no temporary file', async (t) => {
  const dir = tempDir(t);
  const cache = await loadRemoteClientCache(dir);
  await Promise.all([cache.queueRevoke('c1'), cache.queueRevoke('c2'), cache.applied('c1')]);
  assert.deepEqual(stored(dir).pendingRevokes, ['c2']);
  assert.equal(
    readdirSync(dir).some((name) => name.endsWith('.tmp') || name.includes('.mixdog-tmp-')),
    false
  );
});
