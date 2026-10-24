import assert from 'node:assert/strict';
import fs, {
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';

import {
  copyProjectEntryIn,
  createProjectEntryIn,
  listProjectDirIn,
  moveProjectEntryIn,
  projectEntryPathIn,
  readProjectTextFileIn,
  renameProjectEntryIn,
  replaceProjectFileBytes,
  rewriteFileThrough,
  statProjectFileIn,
  writeProjectTextFileIn,
  writeProjectTextFileThrough,
  writeProjectTextFilesIn,
  writeProjectTextFilesThrough,
} from './project-files.ts';

test('stat tells a folder from a file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-stat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dir'));
  await writeFile(join(root, 'file.txt'), 'x');
  assert.equal((await statProjectFileIn(root, 'dir')).directory, true);
  const file = await statProjectFileIn(root, 'file.txt');
  assert.equal(file.directory, false);
  assert.equal(file.size, 1);
});

test('project file operations reject symlink and junction escapes', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'mixdog-project-path-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, 'project');
  const outside = join(fixture, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(join(outside, 'secret.txt'), 'secret');
  const link = join(root, 'escape');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(() => projectEntryPathIn(root, 'escape/secret.txt'), /resolves outside/);
  await assert.rejects(listProjectDirIn(root, 'escape'), /resolves outside/);
  await assert.rejects(readProjectTextFileIn(root, 'escape/secret.txt'), /resolves outside/);
  await assert.rejects(createProjectEntryIn(root, '', 'escape/created.txt', false), /resolves outside/);
});

test('the project-root guard holds when the caller passes an unresolved root', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'mixdog-project-root-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, 'project');
  await mkdir(join(root, 'dir'), { recursive: true });
  const unresolved = `${root}${sep}dir${sep}..`;
  await assert.rejects(renameProjectEntryIn(unresolved, '', 'renamed'), /Cannot rename the project root/);
  await assert.rejects(moveProjectEntryIn(unresolved, '', 'dir'), /Cannot move the project root/);
  await assert.rejects(copyProjectEntryIn(unresolved, '', 'dir'), /Cannot copy the project root/);
});

test('text over 1 MB opens read-only up to 10 MB; beyond that it falls back', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-large-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'small.txt'), 'x'.repeat(1_048_576));
  await writeFile(join(root, 'mid.txt'), 'y'.repeat(1_048_577));
  await writeFile(join(root, 'edge.txt'), 'z'.repeat(10_485_760));
  await writeFile(join(root, 'huge.txt'), 'w'.repeat(10_485_761));
  await writeFile(join(root, 'mid.bin'), Buffer.alloc(2_000_000, 0));

  const small = await readProjectTextFileIn(root, 'small.txt');
  assert.equal(small.readOnly, undefined);
  assert.equal(small.content.length, 1_048_576);
  const mid = await readProjectTextFileIn(root, 'mid.txt');
  assert.equal(mid.readOnly, true);
  assert.equal(mid.tooLarge, false);
  assert.equal(mid.content.length, 1_048_577);
  const edge = await readProjectTextFileIn(root, 'edge.txt');
  assert.equal(edge.readOnly, true);
  assert.equal(edge.tooLarge, false);
  const huge = await readProjectTextFileIn(root, 'huge.txt');
  assert.equal(huge.tooLarge, true);
  assert.equal(huge.content, '');
  const binary = await readProjectTextFileIn(root, 'mid.bin');
  assert.equal(binary.binary, true);
  assert.equal(binary.readOnly, undefined);
});

test('project directory listing does not hide entries after 500', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(
    Array.from({ length: 501 }, (_, index) => writeFile(join(root, `file-${String(index).padStart(3, '0')}.txt`), ''))
  );

  const entries = await listProjectDirIn(root, '');

  assert.equal(entries.length, 501);
  assert.equal(entries.at(-1)?.name, 'file-500.txt');
});

/** A real handle whose methods can be intercepted: `fault` replaces a method's behaviour. */
function faultyHandle(handle, fault) {
  return new Proxy(handle, {
    get(target, prop) {
      if (fault[prop]) return (...args) => fault[prop](target, ...args);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('a failure after the current file was modified restores it with the earlier files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'alpha');
  await writeFile(join(root, 'b.txt'), 'bravo');
  const writes = [
    { relPath: 'a.txt', content: 'alpha edited', expectedContent: 'alpha' },
    { relPath: 'b.txt', content: 'bravo edited', expectedContent: 'bravo' },
  ];
  // b's bytes are already written and truncated when its sync fails (once).
  let failed = false;
  const openFile = async (absolute) => {
    const handle = await open(absolute, 'r+');
    if (!absolute.endsWith('b.txt')) return handle;
    return faultyHandle(handle, {
      datasync: async (target) => {
        if (!failed) {
          failed = true;
          throw new Error('disk fault');
        }
        await target.datasync();
      },
    });
  };
  await assert.rejects(writeProjectTextFilesThrough(root, writes, openFile), /disk fault/);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'alpha');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'bravo');
});

test('a single-file save that fails part-way leaves the original intact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-single-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = 'a much longer original text';
  await writeFile(join(root, 'a.txt'), original);
  // The new bytes are written and the file truncated when the sync fails (once).
  let failed = false;
  const openFile = async (absolute) =>
    faultyHandle(await open(absolute, 'r+'), {
      datasync: async (target) => {
        if (!failed) {
          failed = true;
          throw new Error('disk fault');
        }
        await target.datasync();
      },
    });
  await assert.rejects(
    writeProjectTextFileThrough(root, 'a.txt', 'edited', original, undefined, openFile),
    /disk fault/
  );
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), original);

  await writeProjectTextFileThrough(root, 'a.txt', 'edited', original, undefined, openFile);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'edited');
});

test('a single-file save whose restore also fails says so', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-single-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'alpha');
  const openFile = async (absolute) =>
    faultyHandle(await open(absolute, 'r+'), {
      datasync: async () => {
        throw new Error('disk fault');
      },
    });
  await assert.rejects(
    writeProjectTextFileThrough(root, 'a.txt', 'edited', 'alpha', undefined, openFile),
    /disk fault\. The original could not be restored/
  );
});

test('a restore that fails is reported', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'alpha');
  const openFile = async (absolute) =>
    faultyHandle(await open(absolute, 'r+'), {
      datasync: async () => {
        throw new Error('disk fault');
      },
    });
  await assert.rejects(
    writeProjectTextFilesThrough(root, [{ relPath: 'a.txt', content: 'edited', expectedContent: 'alpha' }], openFile),
    /Not restored: \["a\.txt"\]/
  );
});

test('a partial write is completed before the file is truncated', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-short-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'a.txt');
  await writeFile(file, 'a much longer original text');
  const handle = await open(file, 'r+');
  t.after(() => handle.close());
  const calls = [];
  const short = faultyHandle(handle, {
    write: async (target, buffer, offset, length, position) => {
      calls.push([offset, length, position]);
      return target.write(buffer, offset, Math.min(length, 3), position);
    },
  });
  await rewriteFileThrough(short, Buffer.from('replacement'));
  assert.equal(await readFile(file, 'utf8'), 'replacement');
  assert.equal(calls.length, 4);

  const stalled = faultyHandle(handle, { write: async () => ({ bytesWritten: 0 }) });
  await assert.rejects(rewriteFileThrough(stalled, Buffer.from('never')), /no progress/);
});

test('a save is flushed through the file own handle before it is reported committed', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'mixdog-project-sync-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const file = join(fixture, 'source.ts');
  await writeFile(file, 'old');
  const probe = await open(file, 'r');
  const handlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const datasync = handlePrototype.datasync;
  const events = [];
  t.mock.method(handlePrototype, 'datasync', async function (...args) {
    events.push(`flush:${await readFile(file, 'utf8')}`);
    return datasync.apply(this, args);
  });
  await replaceProjectFileBytes(file, Buffer.from('new'), Buffer.from('old'), () => {
    events.push('committed');
  });
  assert.deepEqual(events, ['flush:new', 'committed'], 'the new bytes are in place and flushed before the commit');
  assert.equal(await readFile(file, 'utf8'), 'new');
});

// The desktop editor save (writeProjectFile -> writeProjectTextFileIn) and the
// batch writer must rewrite a file in place: a temp file renamed over it gives
// the path a new file ID, orphans its hard links and drops its ACLs/attributes.
const OLD_TEXT = 'a much longer old content';

async function identityFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-project-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fileId(path) {
  const info = await stat(path, { bigint: true });
  return `${info.dev}:${info.ino}`;
}

function hookFs(t, name, run) {
  const original = fs[name];
  const mock = t.mock.method(fs, name, (...args) => run(original, ...args));
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
}

test('a save rewrites the file in place: file ID and hard links survive', async (t) => {
  const root = await identityFixture(t);
  const file = join(root, 'hl.txt');
  const alias = join(root, 'hl-link.txt');
  await writeFile(file, OLD_TEXT);
  await link(file, alias);
  const before = await fileId(file);

  const saved = await writeProjectTextFileIn(root, 'hl.txt', 'new', OLD_TEXT);

  assert.ok(Number.isFinite(saved.mtimeMs));
  assert.equal(await fileId(file), before);
  assert.equal(await fileId(alias), before);
  assert.equal((await stat(file)).nlink, 2);
  assert.equal(await readFile(file, 'utf8'), 'new');
  assert.equal(await readFile(alias, 'utf8'), 'new');
  assert.deepEqual((await readdir(root)).sort(), ['hl-link.txt', 'hl.txt']);
});

test('a save through a symlink writes the target and keeps the link', async (t) => {
  const root = await identityFixture(t);
  const target = join(root, 'target.txt');
  const linkPath = join(root, 'link.txt');
  await writeFile(target, OLD_TEXT);
  try {
    await symlink(target, linkPath, 'file');
  } catch (error) {
    if (error?.code === 'EPERM') return t.skip('symlinks need privileges on this machine');
    throw error;
  }
  const before = await fileId(target);

  await writeProjectTextFileIn(root, 'link.txt', 'new', OLD_TEXT);

  assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
  assert.equal(await fileId(target), before);
  assert.equal(await readFile(target, 'utf8'), 'new');
  assert.deepEqual((await readdir(root)).sort(), ['link.txt', 'target.txt']);
});

test('a save over an externally changed file is still refused and changes nothing', async (t) => {
  const root = await identityFixture(t);
  const file = join(root, 'hl.txt');
  const alias = join(root, 'hl-link.txt');
  await writeFile(file, OLD_TEXT);
  await link(file, alias);
  await writeFile(file, 'edited elsewhere');
  const before = await fileId(file);

  await assert.rejects(writeProjectTextFileIn(root, 'hl.txt', 'mine', OLD_TEXT), /changed on disk/);

  assert.equal(await fileId(file), before);
  assert.equal(await readFile(file, 'utf8'), 'edited elsewhere');
  assert.equal(await readFile(alias, 'utf8'), 'edited elsewhere');
});

test('a save that fails while writing puts the original back in the same file', async (t) => {
  const root = await identityFixture(t);
  const file = join(root, 'hl.txt');
  const alias = join(root, 'hl-link.txt');
  await writeFile(file, OLD_TEXT);
  await link(file, alias);
  const before = await fileId(file);
  // The new bytes are written and the file truncated when the flush fails (once).
  let failed = false;
  hookFs(t, 'open', async (openFile, path, ...args) =>
    String(path) === file && args[0] === 'r+'
      ? faultyHandle(await openFile(path, ...args), {
          datasync: async (target) => {
            if (!failed) {
              failed = true;
              throw new Error('disk fault');
            }
            await target.datasync();
          },
        })
      : openFile(path, ...args)
  );

  await assert.rejects(writeProjectTextFileIn(root, 'hl.txt', 'new', OLD_TEXT), /disk fault/);

  assert.equal(await fileId(file), before);
  assert.equal(await readFile(alias, 'utf8'), OLD_TEXT);
  await writeProjectTextFileIn(root, 'hl.txt', 'new', OLD_TEXT);
  assert.equal(await readFile(alias, 'utf8'), 'new');
});

test('a save whose restore also fails says so', async (t) => {
  const root = await identityFixture(t);
  await writeFile(join(root, 'a.txt'), 'alpha');
  hookFs(t, 'open', async (openFile, path, ...args) =>
    faultyHandle(await openFile(path, ...args), {
      datasync: async () => {
        throw new Error('disk fault');
      },
    })
  );
  await assert.rejects(
    writeProjectTextFileIn(root, 'a.txt', 'edited', 'alpha'),
    /disk fault\. The original could not be restored/
  );
});

// Network and cloud-sync drives (e.g. the MYBOX case, #138) refuse fsync; the
// save is then best-effort durable instead of failing. A real I/O error is not
// tolerated.
for (const code of ['ENOTSUP', 'EPERM', 'EINVAL']) {
  test(`a save succeeds on a filesystem that refuses fsync (${code})`, async (t) => {
    const root = await identityFixture(t);
    const file = join(root, 'a.txt');
    await writeFile(file, OLD_TEXT);
    const before = await fileId(file);
    let flushes = 0;
    hookFs(t, 'open', async (openFile, path, ...args) =>
      String(path) === file && args[0] === 'r+'
        ? faultyHandle(await openFile(path, ...args), {
            datasync: async () => {
              flushes++;
              throw Object.assign(new Error(`fsync refused: ${code}`), { code });
            },
          })
        : openFile(path, ...args)
    );

    const saved = await writeProjectTextFileIn(root, 'a.txt', 'new', OLD_TEXT);

    assert.ok(Number.isFinite(saved.mtimeMs));
    assert.ok(flushes > 0, 'the flush was attempted');
    assert.equal(await readFile(file, 'utf8'), 'new');
    assert.equal(await fileId(file), before);
    assert.deepEqual(await readdir(root), ['a.txt']);
  });
}

test('the paired-device save and the batch write also tolerate a refused fsync', async (t) => {
  const root = await identityFixture(t);
  await writeFile(join(root, 'a.txt'), 'alpha');
  await writeFile(join(root, 'b.txt'), 'bravo');
  const refuse = async () => {
    throw Object.assign(new Error('fsync unsupported'), { code: 'ENOTSUP' });
  };
  const openFile = async (absolute) => faultyHandle(await open(absolute, 'r+'), { datasync: refuse });

  await writeProjectTextFileThrough(root, 'a.txt', 'alpha edited', 'alpha', undefined, openFile);
  await writeProjectTextFilesThrough(
    root,
    [{ relPath: 'b.txt', content: 'bravo edited', expectedContent: 'bravo' }],
    openFile
  );

  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'alpha edited');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'bravo edited');
});

test('a real I/O error on flush fails the save and the original is put back', async (t) => {
  const root = await identityFixture(t);
  const file = join(root, 'hl.txt');
  const alias = join(root, 'hl-link.txt');
  await writeFile(file, OLD_TEXT);
  await link(file, alias);
  const before = await fileId(file);
  // The new bytes are written and the file truncated when the flush fails (once).
  let failed = false;
  hookFs(t, 'open', async (openFile, path, ...args) =>
    String(path) === file && args[0] === 'r+'
      ? faultyHandle(await openFile(path, ...args), {
          datasync: async (target) => {
            if (!failed) {
              failed = true;
              throw Object.assign(new Error('disk fault'), { code: 'EIO' });
            }
            await target.datasync();
          },
        })
      : openFile(path, ...args)
  );

  await assert.rejects(writeProjectTextFileIn(root, 'hl.txt', 'new', OLD_TEXT), { code: 'EIO' });

  assert.equal(failed, true);
  assert.equal(await readFile(file, 'utf8'), OLD_TEXT);
  assert.equal(await readFile(alias, 'utf8'), OLD_TEXT);
  assert.equal(await fileId(file), before);
});

test('a batch rewrites files in place and rolls back in place, keeping file IDs and hard links', async (t) => {
  const root = await identityFixture(t);
  const a = join(root, 'a.txt');
  const alias = join(root, 'a-link.txt');
  await writeFile(a, 'A0');
  await link(a, alias);
  await writeFile(join(root, 'b.txt'), 'B0');
  const before = await fileId(a);
  const writes = [
    { relPath: 'a.txt', content: 'A1', expectedContent: 'A0' },
    { relPath: 'b.txt', content: 'B1', expectedContent: 'B0' },
  ];

  await writeProjectTextFilesIn(root, writes);
  assert.equal(await fileId(a), before);
  assert.equal(await readFile(alias, 'utf8'), 'A1');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'B1');

  // The second file cannot be opened for writing: the first is rolled back.
  await writeFile(join(root, 'b.txt'), 'B0');
  hookFs(t, 'open', async (openFile, path, ...args) => {
    if (String(path) === join(root, 'b.txt') && args[0] === 'r+') {
      throw Object.assign(new Error('write denied'), { code: 'EACCES' });
    }
    return openFile(path, ...args);
  });
  await assert.rejects(
    writeProjectTextFilesIn(root, [
      { relPath: 'a.txt', content: 'A2', expectedContent: 'A1' },
      { relPath: 'b.txt', content: 'B2', expectedContent: 'B0' },
    ]),
    /write denied/
  );
  assert.equal(await fileId(a), before);
  assert.equal((await stat(a)).nlink, 2);
  assert.equal(await readFile(alias, 'utf8'), 'A1');
});

// Two hard links are two paths for one file. The path claims cannot see that,
// so cooperating saves are also serialized by the file's identity, taken from
// the open handle: the loser must be refused, never interleaved with the winner.
const A_TEXT = 'A'.repeat(OLD_TEXT.length);
const B_TEXT = 'B'.repeat(OLD_TEXT.length);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The three in-place writers: the desktop editor save, and a paired device's
// single-file save and batch save (both through an authorized opener).
const SAVERS = {
  in: (root, relPath, content, expected) => writeProjectTextFileIn(root, relPath, content, expected),
  through: (root, relPath, content, expected, openFile) =>
    writeProjectTextFileThrough(root, relPath, content, expected, undefined, openFile),
  batch: (root, relPath, content, expected, openFile) =>
    writeProjectTextFilesThrough(root, [{ relPath, content, expectedContent: expected }], openFile),
};

// Wraps every file a saver opens for writing. `in` opens through fs.open, the
// paired-device writers through the opener returned here.
function instrument(t, kind, { faultsFor = () => undefined, onOpen = () => {} }) {
  const opened = async (openFile, path, ...args) => {
    const handle = await openFile(path, ...args);
    onOpen(String(path));
    const faults = faultsFor(String(path));
    return faults ? faultyHandle(handle, faults) : handle;
  };
  if (kind === 'in') {
    hookFs(t, 'open', (openFile, path, ...args) =>
      args[0] === 'r+' ? opened(openFile, path, ...args) : openFile(path, ...args)
    );
    return undefined;
  }
  return (absolute) => opened(open, absolute, 'r+');
}

// The first write lands half of its bytes, and every write waits first: a
// window in which an unserialized writer on the other link interleaves.
function slowHalves() {
  let calls = 0;
  return {
    write: async (target, buffer, offset, length, position) => {
      await sleep(25);
      return target.write(buffer, offset, calls++ === 0 ? length >> 1 : length, position);
    },
  };
}

// The forward write fails before changing a byte; the restore that follows then
// lands in two slow halves.
function failThenSlowRestore(failing) {
  let calls = 0;
  return {
    write: async (target, buffer, offset, length, position) => {
      if (calls++ === 0) {
        failing.resolve();
        throw new Error('disk fault');
      }
      await sleep(40);
      return target.write(buffer, offset, calls === 2 ? length >> 1 : length, position);
    },
  };
}

async function linkedFixture(t) {
  const root = await identityFixture(t);
  const file = join(root, 'hl.txt');
  const alias = join(root, 'hl-link.txt');
  await writeFile(file, OLD_TEXT);
  await link(file, alias);
  return { root, file, alias, id: await fileId(file) };
}

for (const kind of Object.keys(SAVERS)) {
  test(`${kind}: concurrent saves through hard-link aliases run one at a time; the loser is refused`, async (t) => {
    const { root, file, alias, id } = await linkedFixture(t);
    const openFile = instrument(t, kind, { faultsFor: () => slowHalves() });

    const results = await Promise.allSettled([
      SAVERS[kind](root, 'hl.txt', A_TEXT, OLD_TEXT, openFile),
      SAVERS[kind](root, 'hl-link.txt', B_TEXT, OLD_TEXT, openFile),
    ]);

    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1, 'exactly one save wins');
    assert.match(String(losers[0].reason?.message), /changed on disk/);
    const winning = results[0].status === 'fulfilled' ? A_TEXT : B_TEXT;
    assert.equal(await readFile(file, 'utf8'), winning, "the bytes are the winner's, never a mix");
    assert.equal(await readFile(alias, 'utf8'), winning);
    assert.equal(await fileId(file), id);
  });

  test(`${kind}: a failed save's restore cannot interleave with a save through another alias`, async (t) => {
    const { root, file, alias } = await linkedFixture(t);
    const failing = Promise.withResolvers();
    const openFile = instrument(t, kind, {
      faultsFor: (path) => (path === file ? failThenSlowRestore(failing) : undefined),
    });

    const failed = SAVERS[kind](root, 'hl.txt', A_TEXT, OLD_TEXT, openFile);
    await failing.promise;
    const other = SAVERS[kind](root, 'hl-link.txt', B_TEXT, OLD_TEXT, openFile);
    const [first, second] = await Promise.allSettled([failed, other]);

    assert.equal(first.status, 'rejected');
    assert.match(String(first.reason?.message), /disk fault/);
    assert.equal(second.status, 'fulfilled', 'the other save waited for the restore, then saw the original');
    assert.equal(await readFile(file, 'utf8'), B_TEXT, 'the restore did not overwrite or mix into the other save');
    assert.equal(await readFile(alias, 'utf8'), B_TEXT);
  });

  test(`${kind}: a save that waited for the file re-checks that its path still names it`, async (t) => {
    const { root, file, alias } = await linkedFixture(t);
    const flushing = Promise.withResolvers();
    const release = Promise.withResolvers();
    const aliasOpened = Promise.withResolvers();
    const openFile = instrument(t, kind, {
      faultsFor: (path) =>
        path === file
          ? {
              datasync: async (target) => {
                flushing.resolve();
                await release.promise;
                await target.datasync();
              },
            }
          : undefined,
      onOpen: (path) => path === alias && aliasOpened.resolve(),
    });

    const first = SAVERS[kind](root, 'hl.txt', A_TEXT, OLD_TEXT, openFile);
    await flushing.promise; // its bytes are written and it still holds the file
    const waiting = SAVERS[kind](root, 'hl-link.txt', B_TEXT, A_TEXT, openFile);
    await aliasOpened.promise;
    // While it waits, the alias's name moves to a different file with the same text.
    await rename(alias, join(root, 'moved.txt'));
    await writeFile(alias, A_TEXT);
    const refused = assert.rejects(waiting, /path changed/i);
    release.resolve();

    await first;
    await refused;
    assert.equal(await readFile(file, 'utf8'), A_TEXT, 'nothing was written through the stale handle');
    assert.equal(await readFile(join(root, 'moved.txt'), 'utf8'), A_TEXT);
    assert.equal(await readFile(alias, 'utf8'), A_TEXT);
  });
}

test('saves to different files are not serialized by file identity', async (t) => {
  const root = await identityFixture(t);
  await writeFile(join(root, 'a.txt'), OLD_TEXT);
  await writeFile(join(root, 'b.txt'), OLD_TEXT);
  const stalled = Promise.withResolvers();
  const release = Promise.withResolvers();
  instrument(t, 'in', {
    faultsFor: (path) =>
      path === join(root, 'a.txt')
        ? {
            write: async (target, ...args) => {
              stalled.resolve();
              await release.promise;
              return target.write(...args);
            },
          }
        : undefined,
  });

  const slow = writeProjectTextFileIn(root, 'a.txt', A_TEXT, OLD_TEXT);
  await stalled.promise;
  await writeProjectTextFileIn(root, 'b.txt', B_TEXT, OLD_TEXT);
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), B_TEXT, 'b finished while a was still writing');
  release.resolve();
  await slow;
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), A_TEXT);
});

test('a paired-device batch naming two links of one file is refused before anything is written', async (t) => {
  const { root, file, alias } = await linkedFixture(t);
  const openFile = instrument(t, 'batch', {});

  await assert.rejects(
    writeProjectTextFilesThrough(
      root,
      [
        { relPath: 'hl.txt', content: A_TEXT, expectedContent: OLD_TEXT },
        { relPath: 'hl-link.txt', content: B_TEXT, expectedContent: OLD_TEXT },
      ],
      openFile
    ),
    /duplicate files/
  );

  assert.equal(await readFile(file, 'utf8'), OLD_TEXT);
  assert.equal(await readFile(alias, 'utf8'), OLD_TEXT);
});
