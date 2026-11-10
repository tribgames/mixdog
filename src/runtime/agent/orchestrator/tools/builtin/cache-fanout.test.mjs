import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve, join } from 'node:path';
import {
  cacheGet,
  cacheSet,
  invalidateBuiltinResultCache,
  runRawContentInFlight,
  runReadOnlyStatInFlight,
} from './cache-layers.mjs';

const root = resolve(`cache-fanout-virtual-${process.pid}`);
const tick = () => new Promise((done) => setImmediate(done));
const variants = [
  ['read', runRawContentInFlight],
  ['stat', runReadOnlyStatInFlight],
  ['lstat', (path, loader) => runReadOnlyStatInFlight(path, loader, 'lstat')],
];

for (const [kind, run] of variants) {
  test(`${kind}: fan-out shares one operation without serializing different files`, async (t) => {
    invalidateBuiltinResultCache();
    t.after(() => invalidateBuiltinResultCache());
    const finish = Promise.withResolvers();
    let calls = 0;
    const loader = async (path) => {
      calls++;
      await finish.promise;
      return path;
    };
    const first = join(root, 'first.txt');
    const second = join(root, 'second.txt');
    const pending = Array.from({ length: 32 }, () => run(first, loader));
    pending.push(run(second, loader));
    await tick();
    assert.equal(calls, 2, 'independent files both start; duplicate readers share the first');
    finish.resolve();
    assert.deepEqual(await Promise.all(pending), [...Array(32).fill(first), second]);
  });

  test(`${kind}: unrelated changes preserve sharing; related changes detach only the old operation`, async (t) => {
    invalidateBuiltinResultCache();
    t.after(() => invalidateBuiltinResultCache());
    const path = join(root, 'scope', 'file.txt');
    const oldFinish = Promise.withResolvers();
    const newFinish = Promise.withResolvers();
    let calls = 0;
    const old = run(path, async () => {
      calls++;
      return oldFinish.promise;
    });
    await tick();
    invalidateBuiltinResultCache([join(root, 'scope-other', 'file.txt')]);
    const sibling = run(path, async () => {
      throw new Error('unrelated changes must not duplicate work');
    });
    invalidateBuiltinResultCache([join(root, 'scope')]);
    const fresh = run(path, async () => {
      calls++;
      return newFinish.promise;
    });
    await tick();
    assert.equal(calls, 2);
    oldFinish.resolve('old snapshot');
    assert.deepEqual(await Promise.all([old, sibling]), ['old snapshot', 'old snapshot']);
    const joined = run(path, async () => {
      throw new Error('an older completion must not remove the replacement operation');
    });
    newFinish.resolve('new snapshot');
    assert.deepEqual(await Promise.all([fresh, joined]), ['new snapshot', 'new snapshot']);
  });

  test(`${kind}: full invalidation detaches outstanding work without cancelling its subscribers`, async (t) => {
    invalidateBuiltinResultCache();
    t.after(() => invalidateBuiltinResultCache());
    const finish = Promise.withResolvers();
    const path = join(root, 'global.txt');
    const old = run(path, () => finish.promise);
    await tick();
    invalidateBuiltinResultCache();
    assert.equal(await run(path, async () => 'fresh'), 'fresh');
    finish.resolve('old');
    assert.equal(await old, 'old');
  });
}

test('precise watcher paths invalidate directory searches but preserve sibling-file results', (t) => {
  invalidateBuiltinResultCache();
  t.after(() => invalidateBuiltinResultCache());
  const changed = join(root, 'changed.txt');
  const sibling = join(root, 'sibling.txt');
  cacheSet('directory', 'old listing', { scopes: [root] });
  cacheSet('changed', 'old content', { paths: [changed] });
  cacheSet('sibling', 'unchanged content', { paths: [sibling] });
  invalidateBuiltinResultCache([changed]);
  assert.equal(cacheGet('directory'), null);
  assert.equal(cacheGet('changed'), null);
  assert.equal(cacheGet('sibling'), 'unchanged content');
});

test('canonical aliases share work and stat kinds remain independent', async (t) => {
  invalidateBuiltinResultCache();
  t.after(() => invalidateBuiltinResultCache());
  const path = join(root, 'alias.txt');
  const alias = process.platform === 'win32' ? path.toUpperCase() : join(root, '.', 'alias.txt');
  const finish = Promise.withResolvers();
  let calls = 0;
  const loader = async () => {
    calls++;
    return finish.promise;
  };
  const pending = [
    runReadOnlyStatInFlight(path, loader),
    runReadOnlyStatInFlight(alias, loader),
    runReadOnlyStatInFlight(path, loader, 'lstat'),
  ];
  await tick();
  assert.equal(calls, 2);
  invalidateBuiltinResultCache([alias]);
  assert.equal(await runReadOnlyStatInFlight(path, async () => 'fresh'), 'fresh');
  finish.resolve('shared');
  assert.deepEqual(await Promise.all(pending), ['shared', 'shared', 'shared']);
});
