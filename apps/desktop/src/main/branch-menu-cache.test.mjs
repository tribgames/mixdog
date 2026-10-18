import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBranchMenuCache } from './branch-menu-cache.ts';

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

async function repository(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mixdog-branch-menu-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  execFileSync('git', ['init', '-q', '-b', 'main', project]);
  git(project, 'config', 'user.email', 'test@example.com');
  git(project, 'config', 'user.name', 'Test');
  await writeFile(join(project, 'a.txt'), 'a\n');
  git(project, 'add', '.');
  git(project, 'commit', '-qm', 'first');
  const registry = join(root, 'registry.json');
  await writeFile(registry, '{"version":1,"entries":{}}');
  const commonDir = git(project, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return { root, project, registry, commonDir };
}

/** A cache whose clock runs ahead, so files written by the test a moment ago
 *  are not "racy"; the racy rule has its own test. */
function harness(repo) {
  let loads = 0;
  const cache = createBranchMenuCache({ registry: repo.registry, now: () => Date.now() + 60_000 });
  const load = async () => {
    loads += 1;
    return {
      value: { workspace: { repoCommonDir: repo.commonDir, projectPath: repo.project, cwd: repo.project } },
      snapshot: { loads },
    };
  };
  return {
    cache,
    read: (guard = 'g') => cache.read('session:s1', guard, load),
    loads: () => loads,
  };
}

test('a branch menu is reused until a branch, checkout, worktree or retention changes', async (t) => {
  const repo = await repository(t);
  const h = harness(repo);
  await h.read();
  await h.read();
  assert.equal(h.loads(), 1, 'nothing changed: the answer is reused');

  const changes = [
    ['a new branch', () => git(repo.project, 'branch', 'feature/nested')],
    ['a checkout', () => git(repo.project, 'switch', '-q', 'feature/nested')],
    ['a deleted branch', () => git(repo.project, 'branch', '-q', '-D', 'main')],
    ['packed refs', () => git(repo.project, 'pack-refs', '--all')],
    ['a linked worktree', () => git(repo.project, 'worktree', 'add', '-q', '-b', 'side', join(repo.root, 'side'))],
    ['a linked checkout moving', () => git(join(repo.root, 'side'), 'switch', '-q', '--detach')],
    ['a vanished worktree folder', () => rm(join(repo.root, 'side'), { recursive: true, force: true })],
    ['the retention registry', () => writeFile(repo.registry, '{"version":1,"entries":{"x":{}}}')],
  ];
  for (const [label, change] of changes) {
    const before = h.loads();
    await change();
    await h.read();
    assert.equal(h.loads(), before + 1, `${label} is read again`);
    await h.read();
    assert.equal(h.loads(), before + 1, `${label}: then reused again`);
  }
});

test('the workspace guard, a null guard and clear() force a fresh read', async (t) => {
  const repo = await repository(t);
  const h = harness(repo);
  await h.read('revision-1');
  await h.read('revision-2');
  assert.equal(h.loads(), 2, 'the session moved');
  await h.read(null);
  await h.read(null);
  assert.equal(h.loads(), 4, 'without a projection nothing is reused');
  await h.read('revision-2');
  h.cache.clear();
  await h.read('revision-2');
  assert.equal(h.loads(), 6, 'a mutation through the host drops the answer');
});

test('concurrent identical reads share one load; a file changed during the read is never reused', async (t) => {
  const repo = await repository(t);
  const h = harness(repo);
  const [first, second] = await Promise.all([h.read(), h.read()]);
  assert.equal(h.loads(), 1);
  assert.deepEqual(first.value, second.value);

  // A real clock: the registry was written moments before this read began.
  let loads = 0;
  const cache = createBranchMenuCache({ registry: repo.registry });
  const load = async () => {
    loads += 1;
    return { value: { workspace: { repoCommonDir: repo.commonDir, projectPath: repo.project, cwd: repo.project } } };
  };
  await writeFile(repo.registry, '{"version":1,"entries":{}}');
  await cache.read('k', 'g', load);
  await cache.read('k', 'g', load);
  assert.equal(loads, 2, 'a just-written file may not be in the answer yet');
});

test('a read after an invalidation never shares a load that began before it', async (t) => {
  const repo = await repository(t);
  const cache = createBranchMenuCache({ registry: repo.registry, now: () => Date.now() + 60_000 });
  const gates = [];
  const read = (guard, tag) =>
    cache.read('session:s1', guard, async () => {
      const gate = Promise.withResolvers();
      gates.push(gate);
      await gate.promise;
      return {
        value: { workspace: { repoCommonDir: repo.commonDir, projectPath: repo.project, cwd: repo.project } },
        tag,
      };
    });
  /** Opens each load as it arrives until every read has answered. */
  const settle = async (...reads) => {
    let done = false;
    Promise.allSettled(reads).then(() => {
      done = true;
    });
    while (!done) {
      gates.shift()?.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  // The workspace moves while a read for the old one (and a follower) is in flight.
  const old = read('revision-1', 'old');
  const follower = read('revision-1', 'old-follower');
  const moved = read('revision-2', 'moved');
  await settle(old, follower, moved);
  assert.equal((await old).tag, 'old');
  assert.ok((await follower).tag.startsWith('old'));
  assert.equal((await moved).tag, 'moved', 'the new workspace is read for itself');

  // clear() while a read and its follower are in flight.
  const before = read('revision-3', 'before');
  const queued = read('revision-3', 'before-follower');
  cache.clear();
  const after = read('revision-3', 'after');
  await settle(before, queued, after);
  assert.equal((await before).tag, 'before');
  assert.ok((await queued).tag.startsWith('before'));
  assert.equal((await after).tag, 'after', 'a read after clear() gets its own load');
});

test('kept answers are bounded by count and size, least recently used first', async (t) => {
  const repo = await repository(t);
  const cache = createBranchMenuCache({
    registry: repo.registry,
    now: () => Date.now() + 60_000,
    maxEntries: 3,
    maxBytes: 4_000,
  });
  const loads = new Map();
  const read = (key, padding = 0) =>
    cache.read(key, 'g', async () => {
      loads.set(key, (loads.get(key) || 0) + 1);
      return {
        value: { workspace: { repoCommonDir: repo.commonDir, projectPath: repo.project, cwd: repo.project } },
        padding: 'x'.repeat(padding),
      };
    });
  for (const key of ['a', 'b', 'c']) await read(key);
  await read('a'); // a is now the most recently used
  await read('d'); // evicts b, the least recently used
  assert.equal(cache.stats().entries, 3);
  await read('a');
  await read('b');
  assert.equal(loads.get('a'), 1, 'a stayed');
  assert.equal(loads.get('b'), 2, 'b was evicted and read again');

  await read('big', 3_000); // over the byte budget together with the others
  assert.ok(cache.stats().bytes <= 4_000);
  await read('huge', 5_000); // larger than the whole budget: never kept
  await read('huge', 5_000);
  assert.equal(loads.get('huge'), 2);
  assert.ok(cache.stats().bytes <= 4_000);
});

test('outside a repository nothing is kept', async (t) => {
  const repo = await repository(t);
  const cache = createBranchMenuCache({ registry: repo.registry, now: () => Date.now() + 60_000 });
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { value: { workspace: { repoCommonDir: null, projectPath: repo.root, cwd: repo.root } } };
  };
  await cache.read('k', 'g', load);
  await cache.read('k', 'g', load);
  assert.equal(loads, 2);
});
