import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectEditorCache, parseCoreMemoryEntries, readProjectMemories } from './project-editor-data.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('structured memory rows preserve full multiline text and exclude generated history', () => {
  const summary = 'First rule.\n\nSecond rule — keep this literal.';
  const rows = parseCoreMemoryEntries(
    JSON.stringify({
      entries: [
        { id: 1, element: 'Title', summary, source: 'curated', index_revision: 'scope-v1' },
        { id: 2, summary: 'History', source: 'generated' },
      ],
      nextOffset: null,
    })
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].summary, summary);
  assert.equal(rows[0].element, 'Title');
  assert.equal(rows[0].indexRevision, 'scope-v1');
});

test('prefetched project data is immediately available on open and reopen', async () => {
  const cache = new ProjectEditorCache();
  let reads = 0;
  const load = async () => {
    reads++;
    return 'instructions';
  };
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
  assert.equal(
    memories.read(null, () => assert.fail('duplicate read')),
    pending
  );
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
  await assert.rejects(
    cache.read('b', async () => {
      throw new Error('offline');
    }),
    /offline/
  );
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

const projectScopes = [
  { path: 'folder-a', projectId: 'alpha' },
  { path: 'folder-b', projectId: 'beta' },
  { path: 'empty-folder', projectId: 'empty' },
];

test('one catalog read warms common, all projects and empty scopes without mixing scoped IDs', async () => {
  const calls = [];
  const summary = 'First rule.\n\nSecond rule — keep this literal.';
  const catalog = await readProjectMemories(
    projectScopes.map(({ path }) => path),
    async (input) => {
      calls.push(input);
      return JSON.stringify({
        entries: [
          { id: 1, summary: 'Common', project_id: null, index_revision: 'common-v1' },
          { id: 1, summary, element: 'Title', project_id: 'alpha', index_revision: 'alpha-v1' },
          { id: 1, summary: 'Beta', project_id: 'beta', index_revision: 'beta-v1' },
          { id: 1, summary: 'Unregistered', project_id: 'other', index_revision: 'other-v1' },
        ],
        projectScopes,
        nextOffset: null,
      });
    }
  );
  assert.deepEqual(calls, [{
    action: 'core', op: 'list', source: 'curated', scope_only: true, format: 'json',
    project_id: '*', project_paths: ['folder-a', 'folder-b', 'empty-folder'], limit: 100, offset: 0,
  }]);
  assert.deepEqual([...catalog.keys()], [null, 'folder-a', 'folder-b', 'empty-folder']);
  assert.equal(catalog.get(null)[0].summary, 'Common');
  assert.equal(catalog.get('folder-a')[0].summary, summary);
  assert.equal(catalog.get('folder-a')[0].element, 'Title');
  assert.equal(catalog.get('folder-b')[0].indexRevision, 'beta-v1');
  assert.deepEqual(catalog.get('empty-folder'), []);
});

test('catalog pagination checks revisions per scope and retains every row', async () => {
  const offsets = [];
  const catalog = await readProjectMemories(['folder-a', 'folder-b'], async ({ offset }) => {
    offsets.push(offset);
    return {
      projectScopes,
      entries: offset === 0
        ? Array.from({ length: 100 }, (_, index) => ({
          id: index + 1, project_id: 'alpha', summary: `Rule ${index + 1}`, index_revision: 'alpha-v1',
        }))
        : [
          { id: 101, project_id: 'alpha', summary: 'Rule 101', index_revision: 'alpha-v1' },
          { id: 1, project_id: 'beta', summary: 'Beta rule', index_revision: 'beta-v3' },
        ],
      nextOffset: offset === 0 ? 100 : null,
    };
  });
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(catalog.get('folder-a').length, 101);
  assert.equal(catalog.get('folder-a')[100].summary, 'Rule 101');
  assert.equal(catalog.get('folder-b')[0].summary, 'Beta rule');
  await assert.rejects(readProjectMemories(['folder-a'], async ({ offset }) => ({
    projectScopes,
    entries: [{ id: offset + 1, project_id: 'alpha', summary: 'Changed', index_revision: `v${offset}` }],
    nextOffset: offset === 0 ? 1 : null,
  })), /Memory changed/);
});

test('an unavailable catalog never becomes a cached empty project list', async () => {
  const cache = new ProjectEditorCache();
  for (const value of [null, undefined, { entries: [] }, 'core list failed: offline']) {
    await assert.rejects(cache.read('catalog', () => readProjectMemories(['folder-a'], async () => value)));
    assert.equal(cache.peek('catalog'), undefined);
  }
});
