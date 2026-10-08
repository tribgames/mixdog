import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

import { executeListTool, executeTreeTool } from './list-tool.mjs';

function readdirError(code, message = 'injected readdir failure') {
  const error = new Error(message);
  error.code = code;
  return error;
}

test('aborted list work cannot poison the result cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-list-abort-'));
  try {
    await writeFile(join(root, 'entry.txt'), 'ok');
    const controller = new AbortController();
    controller.abort(new Error('probe abort'));
    await assert.rejects(
      executeListTool({ path: root, hidden: true }, process.cwd(), { signal: controller.signal }),
      /aborted|probe abort/i
    );
    assert.match(await executeListTool({ path: root, hidden: true }, process.cwd()), /entry\.txt\tfile/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list defaults to a 100-entry page with an offset continuation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-list-default-page-'));
  try {
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        writeFile(join(root, `entry-${String(index).padStart(3, '0')}.txt`), 'ok')
      )
    );
    const out = await executeListTool({ path: root, hidden: true }, process.cwd());
    assert.equal(out.split('\n').filter((line) => line.endsWith('\tfile')).length, 100);
    assert.match(out, /\[entries 1-100 of 101; pass offset:100 to continue\]/);
    const oversized = await executeListTool({ path: root, hidden: true, head_limit: 200 }, process.cwd());
    assert.equal(oversized.split('\n').filter((line) => line.endsWith('\tfile')).length, 100);
    assert.match(oversized, /\[entries 1-100 of 101; pass offset:100 to continue\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('root readdir failures are errors and stay uncached', async () => {
  const roots = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const root = await mkdtemp(join(tmpdir(), `mixdog-list-root-fail-${index}-`));
      roots.push(root);
      await writeFile(join(root, `entry-${index}.txt`), 'ok');
      const out = await executeListTool({ path: root, hidden: true }, process.cwd(), {
        readdirImpl: async () => {
          throw readdirError('EIO');
        },
      });
      assert.match(out, /^Error: readdir failed \(EIO\):/);
    }
    assert.match(await executeListTool({ path: roots[0], hidden: true }, process.cwd()), /entry-0\.txt\tfile/);
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test('list and tree surface skipped subdirectories and never cache partial walks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-list-partial-'));
  const child = join(root, 'child');
  try {
    await mkdir(child);
    await writeFile(join(child, 'nested.txt'), 'ok');
    const partialReaddir = async (path, options) => {
      if (resolve(path) === resolve(child)) throw readdirError('EIO');
      return readdir(path, options);
    };
    const listTelemetry = {};
    const listPartial = await executeListTool({ path: root, depth: 2, hidden: true, head_limit: 0 }, process.cwd(), {
      readdirImpl: partialReaddir,
      resultTelemetry: listTelemetry,
    });
    assert.match(listPartial, /\[warning\] readdir failed \(EIO\):/);
    assert.equal(listTelemetry.integrity?.status, 'partial');
    assert.doesNotMatch(listPartial, /nested\.txt/);
    assert.match(
      await executeListTool({ path: root, depth: 2, hidden: true, head_limit: 0 }, process.cwd()),
      /child[\\/]nested\.txt\tfile/
    );

    const treeTelemetry = {};
    const treePartial = await executeTreeTool({ path: root, depth: 2, hidden: true, head_limit: 0 }, process.cwd(), {
      readdirImpl: partialReaddir,
      resultTelemetry: treeTelemetry,
    });
    assert.match(treePartial, /\[warning\] readdir failed \(EIO\):/);
    assert.equal(treeTelemetry.integrity?.status, 'partial');
    assert.doesNotMatch(treePartial, /nested\.txt/);
    assert.match(
      await executeTreeTool({ path: root, depth: 2, hidden: true, head_limit: 0 }, process.cwd()),
      /nested\.txt/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a successful empty walk is explicitly traceable as integrity-checked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-list-empty-'));
  const resultTelemetry = {};
  try {
    assert.match(
      await executeListTool({ path: root, hidden: true }, process.cwd(), { resultTelemetry }),
      /\(empty directory\)/
    );
    assert.deepEqual(resultTelemetry.integrity, {
      kind: 'directory-walk',
      status: 'empty',
      entriesVisited: 0,
      warnings: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a paginated complete find page stays complete and is reused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-list-glob-options-'));
  try {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(join(root, name), 'ok');
    const scopedCacheOutcome = { complete: true, cacheSafe: true };
    const args = { path: join(root, '*.txt'), head_limit: 1 };
    const out = await executeListTool({ ...args }, process.cwd(), { scopedCacheOutcome });
    assert.match(out, /pass offset:1 to continue/);
    assert.equal(scopedCacheOutcome.complete, true);
    const hitOutcome = { complete: true, cacheSafe: true };
    assert.equal(await executeListTool({ ...args }, process.cwd(), { scopedCacheOutcome: hitOutcome }), out);
    assert.equal(hitOutcome.complete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function gatedPartialReaddir(child, release) {
  return async (path, options) => {
    await release;
    if (resolve(path) === resolve(child)) throw readdirError('EIO');
    return readdir(path, options);
  };
}

{
  const run = executeListTool;
  test('concurrent list subscribers all see the shared incomplete outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-list-shared-'));
    const child = join(root, 'child');
    try {
      await mkdir(child);
      await writeFile(join(child, 'nested.txt'), 'ok');
      const gate = Promise.withResolvers();
      const args = { path: root, depth: 2, hidden: true, head_limit: 0 };
      const owner = { complete: true, cacheSafe: true };
      const follower = { complete: true, cacheSafe: true };
      const first = run({ ...args }, process.cwd(), {
        readdirImpl: gatedPartialReaddir(child, gate.promise),
        scopedCacheOutcome: owner,
      });
      const second = run({ ...args }, process.cwd(), { scopedCacheOutcome: follower });
      gate.resolve();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a, b);
      assert.match(a, /\[warning\] readdir failed/);
      assert.equal(owner.complete, false);
      assert.equal(follower.complete, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('a list walk truncated by the walk deadline is incomplete and never cached', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-list-truncated-'));
  try {
    for (const name of ['a.txt', 'b.txt']) await writeFile(join(root, name), 'ok');
    const realNow = Date.now.bind(Date);
    let jump = 0;
    const mock = t.mock.method(Date, 'now', () => realNow() + jump);
    const outcome = { complete: true, cacheSafe: true };
    const out = await executeListTool({ path: root, hidden: true }, process.cwd(), {
      scopedCacheOutcome: outcome,
      readdirImpl: async (path, options) => {
        const entries = await readdir(path, options);
        jump = 3_600_000;
        return entries;
      },
    });
    mock.mock.restore();
    assert.match(out, /walk truncated/);
    assert.equal(outcome.complete, false);
    const fresh = await executeListTool({ path: root, hidden: true }, process.cwd());
    assert.doesNotMatch(fresh, /walk truncated/);
    assert.match(fresh, /a\.txt\tfile/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native deep list rows that are not cache-safe are marked unsafe and not cached', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-list-native-unsafe-'));
  try {
    await writeFile(join(root, 'a.txt'), 'ok');
    let runs = 0;
    const options = {
      __runRgWindowedLines: async () => {
        runs++;
        return { complete: true, partial: false, cacheSafe: false, lines: [join(root, 'a.txt')] };
      },
      __tryServeListMetadata: async (paths) => paths.map(() => ({ type: 'file', size: 2, mtimeMs: 1, mode: 0o644 })),
    };
    const outcome = { complete: true, cacheSafe: true };
    const args = { path: root, depth: 2, hidden: true };
    assert.match(await executeListTool({ ...args }, process.cwd(), { ...options, scopedCacheOutcome: outcome }), /a\.txt/);
    assert.equal(outcome.cacheSafe, false);
    await executeListTool({ ...args }, process.cwd(), options);
    assert.equal(runs, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a paged tree is a complete page and is reused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-tree-paged-'));
  try {
    for (const name of ['a', 'b', 'c']) await writeFile(join(root, name), 'ok');
    const args = { path: root, hidden: true, head_limit: 1 };
    const outcome = { complete: true, cacheSafe: true };
    const out = await executeTreeTool({ ...args }, process.cwd(), { scopedCacheOutcome: outcome });
    assert.match(out, /to continue/);
    assert.equal(outcome.complete, true);
    const hit = { complete: true, cacheSafe: true };
    let walked = 0;
    const readdirImpl = async (path, options) => {
      walked++;
      return readdir(path, options);
    };
    assert.equal(await executeTreeTool({ ...args }, process.cwd(), { scopedCacheOutcome: hit, readdirImpl }), out);
    assert.equal(walked, 0);
    assert.equal(hit.complete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a paged list cache hit retains completeness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-list-paged-hit-'));
  try {
    for (const name of ['a', 'b', 'c']) await writeFile(join(root, name), 'ok');
    const args = { path: root, hidden: true, head_limit: 1 };
    const first = { complete: true, cacheSafe: true };
    const out = await executeListTool({ ...args }, process.cwd(), { scopedCacheOutcome: first });
    assert.match(out, /to continue/);
    const hit = { complete: true, cacheSafe: true };
    assert.equal(await executeListTool({ ...args }, process.cwd(), { scopedCacheOutcome: hit }), out);
    assert.equal(first.complete, true);
    assert.equal(hit.complete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a byte-truncated tree render is incomplete, not persisted, and re-walks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-tree-truncated-'));
  try {
    await Promise.all(
      Array.from({ length: 400 }, (_, index) => writeFile(join(root, `${'x'.repeat(200)}${index}`), 'ok'))
    );
    const args = { path: root, hidden: true, head_limit: 0 };
    let walked = 0;
    const readdirImpl = async (path, options) => {
      walked++;
      return readdir(path, options);
    };
    const outcome = { complete: true, cacheSafe: true };
    const out = await executeTreeTool({ ...args }, process.cwd(), { scopedCacheOutcome: outcome, readdirImpl });
    assert.match(out, /output truncated at/);
    assert.equal(outcome.complete, false);
    assert.equal(walked, 1);
    await executeTreeTool({ ...args }, process.cwd(), { readdirImpl });
    assert.equal(walked, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('glob-shaped list forwards the caller outcome to the find flow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-list-glob-forward-'));
  try {
    for (const name of ['a.txt', 'b.txt']) await writeFile(join(root, name), 'ok');
    const partialRg = async () => Object.assign(new String('a.txt\nb.txt'), { partial: true });
    const partial = { complete: true, cacheSafe: true };
    const out = await executeListTool({ path: join(root, '*.txt') }, process.cwd(), {
      scopedCacheOutcome: partial,
      __runRg: partialRg,
    });
    assert.match(out, /walk INCOMPLETE/);
    assert.equal(partial.complete, false);
    const control = { complete: true, cacheSafe: true };
    const controlRoot = await mkdtemp(join(tmpdir(), 'mixdog-list-glob-control-'));
    try {
      await writeFile(join(controlRoot, 'a.txt'), 'ok');
      await executeListTool({ path: join(controlRoot, '*.txt') }, process.cwd(), {
        scopedCacheOutcome: control,
        __runRg: async () => 'a.txt',
      });
      assert.equal(control.complete, true);
    } finally {
      await rm(controlRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function flakyMetadata() {
  const state = { calls: 0, failing: true, gate: null };
  state.impl = async (paths) => {
    state.calls++;
    if (state.gate) await state.gate;
    const failing = state.failing;
    return paths.map((path) =>
      failing && basename(path) === 'b.txt'
        ? { error: 'EIO' }
        : { type: 'file', size: basename(path) === 'b.txt' ? 99 : 1, mtimeMs: 1, mode: 0o644 }
    );
  };
  return state;
}

const rgFiles = (root) => async () => ({
  complete: true,
  partial: false,
  cacheSafe: true,
  lines: [join(root, 'a.txt'), join(root, 'b.txt')],
});

for (const [label, args, native] of [
  ['JS global sort:size', { sort: 'size' }, false],
  ['JS visible-window meta:true', { meta: true }, false],
  ['native deep sort:size', { sort: 'size', depth: 2 }, true],
  ['native deep sort:name meta:false with type filter', { type: 'file', depth: 2 }, true],
]) {
  test(`${label}: failed metadata is incomplete, uncached, and the next call re-reads`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-list-meta-'));
    try {
      for (const name of ['a.txt', 'b.txt']) await writeFile(join(root, name), 'ok');
      const meta = flakyMetadata();
      const options = { __tryServeListMetadata: meta.impl };
      if (native) options.__runRgWindowedLines = rgFiles(root);
      const request = { path: root, hidden: true, head_limit: 0, ...args };
      const bad = { complete: true, cacheSafe: true };
      const first = await executeListTool({ ...request }, process.cwd(), { ...options, scopedCacheOutcome: bad });
      assert.equal(bad.complete, false);
      assert.match(first, /a\.txt/);
      const callsAfterFirst = meta.calls;
      meta.failing = false;
      const good = { complete: true, cacheSafe: true };
      const second = await executeListTool({ ...request }, process.cwd(), { ...options, scopedCacheOutcome: good });
      assert.ok(meta.calls > callsAfterFirst, 'metadata was re-read');
      assert.equal(good.complete, true);
      assert.notEqual(second, first);
      assert.match(second, /b\.txt/);
      if (args.sort === 'size') assert.ok(second.indexOf('b.txt') < second.indexOf('a.txt'), 'largest first');
      const hit = { complete: true, cacheSafe: true };
      assert.equal(await executeListTool({ ...request }, process.cwd(), { ...options, scopedCacheOutcome: hit }), second);
      assert.equal(hit.complete, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('concurrent subscribers share a metadata-incomplete outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-list-meta-shared-'));
  try {
    for (const name of ['a.txt', 'b.txt']) await writeFile(join(root, name), 'ok');
    const meta = flakyMetadata();
    const gate = Promise.withResolvers();
    meta.gate = gate.promise;
    const request = { path: root, hidden: true, sort: 'size', head_limit: 0 };
    const owner = { complete: true, cacheSafe: true };
    const follower = { complete: true, cacheSafe: true };
    const first = executeListTool({ ...request }, process.cwd(), {
      __tryServeListMetadata: meta.impl,
      scopedCacheOutcome: owner,
    });
    const second = executeListTool({ ...request }, process.cwd(), { scopedCacheOutcome: follower });
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b);
    assert.equal(meta.calls, 1);
    assert.equal(owner.complete, false);
    assert.equal(follower.complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});