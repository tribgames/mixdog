import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { writeProjectTextFileIn as save, writeProjectTextFilesIn as saveMany } from './project-files.ts';

// Actual public writers and real aliases/files. Only leaf IO completion is
// intercepted, so no scheduler delay or filesystem race is needed to reproduce
// a destination change. Windows directory junctions need no symlink privilege.
function hook(t, name, run) {
  const original = fs[name];
  const mock = t.mock.method(fs, name, (...args) => run(original, ...args));
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

async function fixture(t, outside = false, distinctCase = false) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'mixdog-forward-destination-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, 'project');
  const original = join(root, distinctCase ? 'A' : 'original');
  const other = outside ? join(base, 'outside') : join(root, distinctCase ? 'a' : 'other');
  const alias = join(root, 'alias');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.mkdir(original, { recursive: true });
  await fs.mkdir(other, { recursive: true });
  if (distinctCase && await fs.realpath(original) === await fs.realpath(other)) {
    t.skip('fixture filesystem does not support distinct case-variant directories');
    return null;
  }
  for (const dir of [original, other]) {
    await fs.writeFile(join(dir, 'b.txt'), 'B0');
  }
  await fs.writeFile(join(root, 'a.txt'), 'A0');
  await fs.symlink(original, alias, kind);
  let changed = false;
  return {
    root, original, other, alias,
    get changed() { return changed; },
    async retarget() {
      assert.equal(changed, false, 'inject exactly one alias replacement');
      await fs.unlink(alias);
      await fs.symlink(other, alias, kind);
      changed = true;
    },
    async preserved() {
      assert.equal(await fs.readFile(join(original, 'b.txt'), 'utf8'), 'B0');
      assert.equal(await fs.readFile(join(other, 'b.txt'), 'utf8'), 'B0');
      assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'A0');
      for (const dir of [root, original, other]) {
        assert.deepEqual((await fs.readdir(dir)).filter(name => name.includes('.mixdog-save-')), []);
      }
    },
  };
}

const batch = [
  { relPath: 'a.txt', content: 'A1', expectedContent: 'A0' },
  { relPath: 'alias/b.txt', content: 'B1', expectedContent: 'B0' },
];

const destinations = [['inside', false, false], ['outside', true, false], ['case-distinct', false, true]];
for (const multiple of [false, true]) for (const [label, outside, distinctCase] of destinations) {
  for (const phase of ['read', 'temp', 'recheck']) {
    test(`${multiple ? 'batch' : 'single'} save refuses ${label} alias retarget during ${phase}`, async (t) => {
      const f = await fixture(t, outside, distinctCase);
      if (!f) return;
      const file = join(f.alias, 'b.txt');
      const swaps = [];
      hook(t, 'rename', async (rename, from, to) => {
        swaps.push(to);
        return rename(from, to);
      });
      if (phase === 'temp') {
        hook(t, 'open', async (open, path, ...args) => {
          const handle = await open(path, ...args);
          if (basename(path).startsWith('b.txt.mixdog-save-')) {
            const write = handle.writeFile.bind(handle);
            t.mock.method(handle, 'writeFile', async (...args) => {
              await write(...args);
              await f.retarget();
            });
          }
          return handle;
        });
      } else {
        let reads = 0;
        // A batch has one extra preflight read before this writer's reads.
        const targetRead = (multiple ? 1 : 0) + (phase === 'read' ? 1 : 2);
        hook(t, 'readFile', async (read, path, ...args) => {
          const bytes = await read(path, ...args);
          if (path === file && ++reads === targetRead) await f.retarget();
          return bytes;
        });
      }
      await assert.rejects(multiple ? saveMany(f.root, batch) : save(f.root, 'alias/b.txt', 'B1', 'B0'), (error) => {
        assert.match(error.message, /path changed|outside the project/i);
        if (multiple) {
          assert.equal(error.code, 'EWORKSPACE_WRITE');
          assert.deepEqual(error.result, {
            failedPath: 'alias/b.txt', committedPaths: ['a.txt'], restoredPaths: ['a.txt'], unrestoredPaths: [],
          });
        }
        return true;
      });
      assert.equal(f.changed, true, 'reach the intended IO boundary');
      assert.deepEqual(swaps, multiple ? [join(f.root, 'a.txt'), join(f.root, 'a.txt')] : []);
      await f.preserved();
    });
  }
}

for (const phase of ['preflight', 'earlier commit']) for (const [label, outside, distinctCase] of destinations) {
  test(`batch preflight identity survives retarget ${label} during ${phase}`, async (t) => {
    const f = await fixture(t, outside, distinctCase);
    if (!f) return;
    if (phase === 'preflight') {
      // Change a later entry while the FIRST entry is being read. All batch
      // identities must already be owned, not collected after each await.
      hook(t, 'readFile', async (read, path, ...args) => {
        const bytes = await read(path, ...args);
        if (!f.changed && path === join(f.root, 'a.txt')) await f.retarget();
        return bytes;
      });
    } else {
      hook(t, 'rename', async (rename, from, to) => {
        await rename(from, to);
        if (!f.changed && to === join(f.root, 'a.txt')) await f.retarget();
      });
    }
    await assert.rejects(saveMany(f.root, batch), /path changed|outside the project/i);
    assert.equal(f.changed, true);
    await f.preserved();
  });
}

for (const multiple of [false, true]) {
  test(`${multiple ? 'batch' : 'single'} save through a stable directory alias remains supported`, async (t) => {
    const f = await fixture(t);
    const result = multiple ? await saveMany(f.root, batch) : await save(f.root, 'alias/b.txt', 'B1', 'B0');
    if (multiple) assert.equal(result, undefined);
    else assert.ok(Number.isFinite(result.mtimeMs));
    assert.equal(await fs.readFile(join(f.original, 'b.txt'), 'utf8'), 'B1');
    assert.equal(await fs.readFile(join(f.other, 'b.txt'), 'utf8'), 'B0');
    assert.equal((await fs.lstat(f.alias)).isSymbolicLink(), true);
  });
}
