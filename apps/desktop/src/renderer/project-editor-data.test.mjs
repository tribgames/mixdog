import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectEditorCache, parseCoreMemoryEntries } from './project-editor-data.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('structured memory rows preserve full multiline text and exclude generated history', () => {
  const summary = 'First rule.\n\nSecond rule — keep this literal.';
  const rows = parseCoreMemoryEntries(JSON.stringify({ entries: [
    { id: 1, element: 'Title', summary, source: 'curated', index_revision: 'scope-v1' },
    { id: 2, summary: 'History', source: 'generated' },
  ], nextOffset: null }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].summary, summary);
  assert.equal(rows[0].element, 'Title');
  assert.equal(rows[0].indexRevision, 'scope-v1');
});

test('prefetched project data is immediately available on open and reopen', async () => {
  const cache = new ProjectEditorCache();
  let reads = 0;
  const load = async () => { reads++; return 'instructions'; };
  await cache.read('project-a', load);
  assert.equal(cache.peek('project-a'), 'instructions');
  assert.equal(await cache.read('project-a', load), 'instructions');
  assert.equal(await cache.read('project-a', load), 'instructions');
  assert.equal(reads, 1);
  assert.equal(cache.peek('project-b'), undefined);
  assert.equal(cache.peek(null), undefined);
});

test('opening during prefetch shares its request; independent fields do not wait', async () => {
  const instructions = new ProjectEditorCache();
  const memories = new ProjectEditorCache();
  const slow = deferred();
  const pending = memories.read(null, () => slow.promise);
  assert.equal(memories.read(null, () => assert.fail('duplicate read')), pending);
  await instructions.read(null, async () => '');
  assert.equal(instructions.peek(null), '');
  assert.equal(memories.peek(null), undefined);
  slow.resolve([]);
  assert.deepEqual(await pending, []);
});

test('refresh retains the displayed value and failed reads can be retried', async () => {
  const cache = new ProjectEditorCache();
  cache.set('a', 'old');
  const slow = deferred();
  const refresh = cache.read('a', () => slow.promise, true);
  assert.equal(cache.peek('a'), 'old');
  assert.equal(await cache.read('a', () => assert.fail('duplicate read')), 'old');
  slow.reject(new Error('offline'));
  await assert.rejects(refresh, /offline/);
  assert.equal(cache.peek('a'), 'old');
  await assert.rejects(cache.read('b', async () => { throw new Error('offline'); }), /offline/);
  assert.equal(cache.peek('b'), undefined);
  assert.equal(await cache.read('b', async () => 'recovered'), 'recovered');
  assert.equal(await cache.read('a', async () => 'new', true), 'new');
  assert.equal(cache.peek('a'), 'new');
});

test('successful saves supersede older background reads', async () => {
  const cache = new ProjectEditorCache();
  const slow = deferred();
  const read = cache.read('a', () => slow.promise);
  cache.set('a', 'saved');
  slow.resolve('old');
  await read;
  assert.equal(cache.peek('a'), 'saved');
});
