import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { writeProjectTextFilesIn } from './project-files.ts';
import { projectRecoveryIn } from './project-recovery.ts';
import {
  beginProjectRecovery,
  projectRecoveryStorePath,
  readRecoveryRecord,
  recoveryIdentity,
  recoveryLocation,
  releaseRecoveryDirectory,
  writeRecoveryState,
  recoveryDigest,
  RECOVERY_MAX_RECORDS,
} from './project-recovery-store.ts';

const execute = promisify(execFile);
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'mixdog-journal-test-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, 'project');
  const data = join(base, 'data');
  await fs.mkdir(root);
  await fs.mkdir(data);
  await fs.writeFile(join(root, 'a.txt'), 'A0');
  await fs.writeFile(join(root, 'b.txt'), 'B0');
  return { base, root, data };
}
const writes = [
  { relPath: 'a.txt', expectedContent: 'A0', content: 'A1' },
  { relPath: 'b.txt', expectedContent: 'B0', content: 'B1' },
];
function hook(t, method, impl) {
  const original = fs[method];
  const replacement = t.mock.method(fs, method, (...args) => impl(original, ...args));
  syncBuiltinESMExports();
  const restore = () => {
    replacement.mock.restore();
    syncBuiltinESMExports();
  };
  t.after(restore);
  return restore;
}
async function record(f, phase = 'failed') {
  const prepared = [];
  for (const write of writes) {
    const destination = join(f.root, write.relPath);
    prepared.push({
      relPath: write.relPath,
      destination,
      parent: recoveryIdentity(dirname(destination)),
      mode: (await fs.stat(destination)).mode,
      before: Buffer.from(write.expectedContent),
      after: Buffer.from(write.content),
    });
  }
  const journal = await beginProjectRecovery(f.data, f.root, prepared);
  await writeRecoveryState(journal.directory, { phase, message: '', restored: [] });
  await releaseRecoveryDirectory(journal.directory);
  return journal.id;
}
async function inspect(f, id) {
  return (await projectRecoveryIn(f.data, f.root, { action: 'inspect', id })).detail;
}

test('successful journaled writes preserve the void contract and clear completed backups', async (t) => {
  const f = await fixture(t);
  assert.equal(await writeProjectTextFilesIn(f.root, writes, f.data), undefined);
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A1');
  assert.deepEqual((await projectRecoveryIn(f.data, f.root, { action: 'list' })).records, []);
});

test('failed batches retain structured per-file recovery evidence', async (t) => {
  const f = await fixture(t);
  hook(t, 'rename', (rename, from, to) => {
    if (to === join(f.root, 'b.txt')) throw new Error('test second-write failure');
    return rename(from, to);
  });
  await assert.rejects(writeProjectTextFilesIn(f.root, writes, f.data), { name: 'ProjectTextBatchWriteError' });
  const { records } = await projectRecoveryIn(f.data, f.root, { action: 'list' });
  assert.equal(records.length, 1);
  assert.equal(records[0].phase, 'failed');
  const result = await inspect(f, records[0].id);
  assert.deepEqual(
    result.files.map((file) => file.status),
    ['restored', 'original']
  );
});

test('a later confirmed retry restores only bytes still owned by the failed batch', async (t) => {
  const f = await fixture(t);
  let rollback = false;
  const restoreHook = hook(t, 'rename', (rename, from, to) => {
    if (to === join(f.root, 'b.txt')) {
      rollback = true;
      throw new Error('write denied');
    }
    if (rollback && to === join(f.root, 'a.txt')) throw new Error('rollback denied');
    return rename(from, to);
  });
  await assert.rejects(writeProjectTextFilesIn(f.root, writes, f.data));
  restoreHook();
  const { records } = await projectRecoveryIn(f.data, f.root, { action: 'list' });
  const before = await inspect(f, records[0].id);
  assert.deepEqual(
    before.files.map((file) => file.status),
    ['written', 'original']
  );
  const result = await projectRecoveryIn(f.data, f.root, {
    action: 'restore',
    id: before.id,
    revision: before.revision,
  });
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A0');
  assert.equal(result.detail.files[0].status, 'restored');
});

test('external edits are preserved while unchanged batch files can be restored', async (t) => {
  const f = await fixture(t);
  const id = await record(f);
  await fs.writeFile(join(f.root, 'a.txt'), 'A1');
  await fs.writeFile(join(f.root, 'b.txt'), 'BX');
  const before = await inspect(f, id);
  assert.deepEqual(
    before.files.map((file) => file.status),
    ['written', 'external']
  );
  const result = await projectRecoveryIn(f.data, f.root, { action: 'restore', id, revision: before.revision });
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A0');
  assert.equal(await fs.readFile(join(f.root, 'b.txt'), 'utf8'), 'BX');
  assert.equal(result.detail.phase, 'failed');
});

test('an old inspection never authorizes a changed file version', async (t) => {
  const f = await fixture(t);
  const id = await record(f);
  await fs.writeFile(join(f.root, 'a.txt'), 'A1');
  const before = await inspect(f, id);
  await fs.writeFile(join(f.root, 'a.txt'), 'AX');
  await assert.rejects(
    projectRecoveryIn(f.data, f.root, { action: 'restore', id, revision: before.revision }),
    /changed since inspection/
  );
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'AX');
});

test('corrupted backups do not become restoration authority', async (t) => {
  const f = await fixture(t);
  const id = await record(f);
  await fs.writeFile(join(f.root, 'a.txt'), 'A1');
  const before = await inspect(f, id);
  const location = await recoveryLocation(f.data, f.root, id);
  await fs.writeFile(join(location, '0.before'), 'XX');
  await assert.rejects(
    projectRecoveryIn(f.data, f.root, { action: 'restore', id, revision: before.revision }),
    /changed since inspection/
  );
  assert.equal((await inspect(f, id)).files[0].status, 'unavailable');
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A1');
});

test('replacing the project directory does not redirect an approved restoration', async (t) => {
  const f = await fixture(t);
  const id = await record(f);
  await fs.writeFile(join(f.root, 'a.txt'), 'A1');
  const before = await inspect(f, id);
  await fs.rename(f.root, join(f.base, 'original-project'));
  await fs.mkdir(f.root);
  await fs.writeFile(join(f.root, 'a.txt'), 'A1');
  await fs.writeFile(join(f.root, 'b.txt'), 'B0');
  await assert.rejects(
    projectRecoveryIn(f.data, f.root, { action: 'restore', id, revision: before.revision }),
    /changed since inspection/
  );
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A1');
});

test('completed records are not an undo command and require approval even for discard', async (t) => {
  const f = await fixture(t);
  const id = await record(f, 'complete');
  await fs.writeFile(join(f.root, 'a.txt'), 'A1');
  const before = await inspect(f, id);
  await assert.rejects(
    projectRecoveryIn(f.data, f.root, { action: 'restore', id, revision: before.revision }),
    /not an undo command/
  );
  await assert.rejects(projectRecoveryIn(f.data, f.root, { action: 'discard', id }), /revision/);
  await projectRecoveryIn(f.data, f.root, { action: 'discard', id, revision: before.revision });
  assert.deepEqual((await projectRecoveryIn(f.data, f.root, { action: 'list' })).records, []);
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A1');
});

test('a real process exit after the first rename leaves a usable restart journal', async (t) => {
  const f = await fixture(t);
  const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { writeProjectTextFilesIn } from ${JSON.stringify(new URL('./project-files.ts', import.meta.url).href)};
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      await rename(from, to);
      if (to === ${JSON.stringify(join(f.root, 'a.txt'))}) process.exit(23);
    };
    syncBuiltinESMExports();
    await writeProjectTextFilesIn(${JSON.stringify(f.root)}, ${JSON.stringify(writes)}, ${JSON.stringify(f.data)});
  `;
  await assert.rejects(
    execute(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: new URL('../../', import.meta.url),
      timeout: 20000,
    }),
    (error) => error.code === 23
  );
  const { records } = await projectRecoveryIn(f.data, f.root, { action: 'list' });
  assert.equal(records.length, 1);
  assert.equal(records[0].phase, 'interrupted');
  const before = await inspect(f, records[0].id);
  assert.deepEqual(
    before.files.map((file) => file.status),
    ['written', 'original']
  );
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A1', 'inspection never restores implicitly');
  await projectRecoveryIn(f.data, f.root, { action: 'restore', id: before.id, revision: before.revision });
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A0');
  assert.equal(await fs.readFile(join(f.root, 'b.txt'), 'utf8'), 'B0');
});

test('invalid record IDs cannot address a host filesystem path', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    projectRecoveryIn(f.data, f.root, { action: 'inspect', id: '../project/a.txt' }),
    /Invalid recovery ID/
  );
});

test('partial successful cleanup never re-enables restoration and can be retried', async (t) => {
  const f = await fixture(t);
  const restoreHook = hook(t, 'rm', async (rm, path, options) => {
    if (options?.recursive && String(path).includes('editor-recovery')) {
      await fs.unlink(join(path, 'state.json'));
      throw Object.assign(new Error('locked payload during cleanup'), { code: 'EBUSY' });
    }
    return rm(path, options);
  });
  await writeProjectTextFilesIn(f.root, writes, f.data);
  restoreHook();
  const { records } = await projectRecoveryIn(f.data, f.root, { action: 'list' });
  assert.equal(records[0].phase, 'retired');
  const before = await inspect(f, records[0].id);
  assert.deepEqual(before.files, []);
  await assert.rejects(
    projectRecoveryIn(f.data, f.root, { action: 'restore', id: before.id, revision: before.revision }),
    /not an undo command/
  );
  await projectRecoveryIn(f.data, f.root, { action: 'discard', id: before.id, revision: before.revision });
  assert.deepEqual((await projectRecoveryIn(f.data, f.root, { action: 'list' })).records, []);
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A1');
});

test('partial explicit discard retires the record even when its manifest is deleted first', async (t) => {
  const f = await fixture(t);
  const id = await record(f);
  await fs.writeFile(join(f.root, 'a.txt'), 'A1');
  const before = await inspect(f, id);
  const restoreHook = hook(t, 'rm', async (rm, path, options) => {
    if (options?.recursive && String(path).includes('editor-recovery')) {
      await fs.unlink(join(path, 'manifest.json'));
      throw new Error('partial discard');
    }
    return rm(path, options);
  });
  await assert.rejects(
    projectRecoveryIn(f.data, f.root, { action: 'discard', id, revision: before.revision }),
    /partial discard/
  );
  restoreHook();
  const after = await inspect(f, id);
  assert.equal(after.phase, 'retired');
  await assert.rejects(
    projectRecoveryIn(f.data, f.root, { action: 'restore', id, revision: after.revision }),
    /not an undo command/
  );
  await projectRecoveryIn(f.data, f.root, { action: 'discard', id, revision: after.revision });
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A1');
});

for (const replaceRoot of [true, false]) {
  test(`replacement of the ${replaceRoot ? 'root' : 'parent'} between commits cannot redirect saving or rollback`, async (t) => {
    const f = await fixture(t);
    const target = replaceRoot ? f.root : join(f.root, 'sub');
    if (!replaceRoot) {
      await fs.mkdir(target);
      await fs.writeFile(join(target, 'a.txt'), 'A0');
      await fs.writeFile(join(target, 'b.txt'), 'B0');
    }
    let moved = false;
    hook(t, 'rename', async (rename, from, to) => {
      await rename(from, to);
      if (!moved && to === join(target, 'a.txt')) {
        moved = true;
        await rename(target, target + '-old');
        await fs.mkdir(target);
        await fs.writeFile(join(target, 'a.txt'), 'A1');
        await fs.writeFile(join(target, 'b.txt'), 'B0');
      }
    });
    const input = writes.map((write) => ({ ...write, relPath: replaceRoot ? write.relPath : `sub/${write.relPath}` }));
    await assert.rejects(writeProjectTextFilesIn(f.root, input, f.data), { name: 'ProjectTextBatchWriteError' });
    assert.equal(await fs.readFile(join(target, 'b.txt'), 'utf8'), 'B0');
    assert.equal(
      await fs.readFile(join(target, 'a.txt'), 'utf8'),
      'A1',
      'rollback must not write to the replacement directory'
    );
    assert.equal(await fs.readFile(join(target + '-old', 'b.txt'), 'utf8'), 'B0');
    assert.equal((await projectRecoveryIn(f.data, f.root, { action: 'list' })).records.length, 1);
  });
}

test('invalid records can be inspected and discarded without any restoration authority', async (t) => {
  const f = await fixture(t);
  const parent = join(f.data, 'editor-recovery', recoveryDigest(f.root));
  await fs.mkdir(parent, { recursive: true });
  for (let i = 0; i < RECOVERY_MAX_RECORDS; i++) await fs.mkdir(join(parent, randomUUID()));
  await assert.rejects(writeProjectTextFilesIn(f.root, writes, f.data), /storage is full/);
  const { records } = await projectRecoveryIn(f.data, f.root, { action: 'list' });
  const detail = await inspect(f, records[0].id);
  assert.equal(detail.phase, 'invalid');
  assert.deepEqual(detail.files, []);
  await assert.rejects(
    projectRecoveryIn(f.data, f.root, { action: 'restore', id: detail.id, revision: detail.revision }),
    /not an undo command/
  );
  const directory = await recoveryLocation(f.data, f.root, detail.id);
  await fs.writeFile(join(directory, 'manifest.json'), 'broken');
  await assert.rejects(
    projectRecoveryIn(f.data, f.root, { action: 'discard', id: detail.id, revision: detail.revision }),
    /changed since inspection/
  );
  const refreshed = await inspect(f, detail.id);
  await projectRecoveryIn(f.data, f.root, { action: 'discard', id: detail.id, revision: refreshed.revision });
  await writeProjectTextFilesIn(f.root, writes, f.data);
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A1');
});

test('concurrent preparations cannot overbook the last recovery slot', async (t) => {
  const f = await fixture(t);
  const parent = join(f.data, 'editor-recovery', recoveryDigest(f.root));
  await fs.mkdir(parent, { recursive: true });
  for (let i = 0; i < RECOVERY_MAX_RECORDS - 1; i++) await fs.mkdir(join(parent, randomUUID()));
  const results = await Promise.allSettled([record(f), record(f)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.match(rejected.reason.message, /storage is full/);
  assert.equal((await projectRecoveryIn(f.data, f.root, { action: 'list' })).records.length, RECOVERY_MAX_RECORDS);
});

test('an active journal cannot be discarded or restored by another request', async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const restoreHook = hook(t, 'rename', async (rename, from, to) => {
    if (to === join(f.root, 'a.txt')) {
      entered.resolve();
      await release.promise;
    }
    return rename(from, to);
  });
  const writing = writeProjectTextFilesIn(f.root, writes, f.data);
  try {
    await entered.promise;
    const { records } = await projectRecoveryIn(f.data, f.root, { action: 'list' });
    const detail = await inspect(f, records[0].id);
    assert.equal(detail.active, true);
    for (const action of ['restore', 'discard']) {
      await assert.rejects(
        projectRecoveryIn(f.data, f.root, { action, id: detail.id, revision: detail.revision }),
        /running operation/
      );
    }
  } finally {
    release.resolve();
    await writing;
    restoreHook();
  }
});

test('a root change after a prepared file read is rejected before any target mutation', async (t) => {
  const f = await fixture(t);
  let moved = false;
  hook(t, 'open', async (open, path, ...args) => {
    const handle = await open(path, ...args);
    if (path === join(f.root, 'a.txt') && !moved) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        // Windows cannot rename an ancestor with an open child handle. Swap
        // after closing but before the preparation caller validates identity.
        if (!moved) {
          moved = true;
          await fs.rename(f.root, f.root + '-old');
          await fs.mkdir(f.root);
          await fs.writeFile(join(f.root, 'a.txt'), 'A0');
          await fs.writeFile(join(f.root, 'b.txt'), 'B0');
        }
      };
    }
    return handle;
  });
  await assert.rejects(writeProjectTextFilesIn(f.root, writes, f.data), /changed/);
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A0');
  assert.equal(await fs.readFile(join(f.root + '-old', 'a.txt'), 'utf8'), 'A0');
  assert.deepEqual((await projectRecoveryIn(f.data, f.root, { action: 'list' })).records, []);
});


test('list reports bounded metadata, unknown sizes and resolved slots without reading payloads', async (t) => {
  const f = await fixture(t);
  await record(f);
  await record(f, 'recovered');
  const damaged = await record(f);
  const dir = await recoveryLocation(f.data, f.root, damaged);
  await fs.writeFile(join(dir, 'manifest.json'), '{}');
  hook(t, 'open', (open, file, ...args) => {
    assert.doesNotMatch(String(file), /\.(before|after)$/);
    return open(file, ...args);
  });
  const result = await projectRecoveryIn(f.data, f.root, { action: 'list' });
  assert.deepEqual(result.storage, {
    usedRecords: 3, maxRecords: 20, unresolvedRecords: 2, resolvedRecords: 1,
    payloadBytes: 16, unknownSizeRecords: 1, maxBatchBytes: 16777216, maxBatchFiles: 100,
  });
  assert.equal(result.rootAvailable, true);
});

test('missing project keeps its inventory and supports only inspected backup disposal', async (t) => {
  const f = await fixture(t);
  const id = await record(f);
  await fs.rename(f.root, f.root + '-moved');
  const listed = await projectRecoveryIn(f.data, f.root, { action: 'list' });
  assert.equal(listed.rootAvailable, false);
  assert.equal(listed.records.length, 1);
  const detail = await inspect(f, id);
  assert.ok(detail.files.every((file) => file.status === 'missing'));
  const result = await projectRecoveryIn(f.data, f.root, { action: 'discard', id, revision: detail.revision });
  assert.equal(result.records.length, 0);
  assert.equal(await fs.readFile(join(f.root + '-moved', 'a.txt'), 'utf8'), 'A0');
});

for (const method of ['writeFile', 'sync', 'close']) {
  test(`state ${method} failure cleans only the temp file this write created`, async (t) => {
    const f = await fixture(t);
    const id = await record(f);
    const directory = await recoveryLocation(f.data, f.root, id);
    const before = await fs.readdir(directory);
    hook(t, 'open', async (open, file, ...args) => {
      const handle = await open(file, ...args);
      if (String(file).endsWith('.tmp')) {
        const close = handle.close.bind(handle);
        handle[method] = async () => { if (method === 'close') await close(); throw new Error('injected state failure'); };
      }
      return handle;
    });
    await assert.rejects(writeRecoveryState(directory, { phase: 'failed', message: '', restored: [] }), /injected/);
    assert.deepEqual(await fs.readdir(directory), before);
  });
}

test('capacity errors retain all records and leave target bytes unchanged', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < RECOVERY_MAX_RECORDS; i++) await record(f, i % 2 ? 'recovered' : 'failed');
  const before = await fs.readdir(projectRecoveryStorePath(f.data, f.root));
  await assert.rejects(writeProjectTextFilesIn(f.root, writes, f.data), { code: 'RECOVERY_CAPACITY' });
  assert.deepEqual(await fs.readdir(projectRecoveryStorePath(f.data, f.root)), before);
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A0');
});


test('a failed exclusive temp creation does not delete another owner’s file', async (t) => {
  const f = await fixture(t);
  const id = await record(f);
  const directory = await recoveryLocation(f.data, f.root, id);
  let foreign;
  hook(t, 'open', async (open, file, ...args) => {
    if (String(file).endsWith('.tmp')) {
      foreign = file;
      const handle = await open(file, ...args);
      await handle.writeFile('foreign');
      await handle.close();
      throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
    }
    return open(file, ...args);
  });
  await assert.rejects(writeRecoveryState(directory, { phase: 'failed', message: '', restored: [] }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign');
});

test('storage exhaustion is actionable and never starts target mutation', async (t) => {
  const f = await fixture(t);
  hook(t, 'mkdir', (mkdir, path, ...args) => {
    if (String(path).includes('editor-recovery')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return mkdir(path, ...args);
  });
  await assert.rejects(writeProjectTextFilesIn(f.root, writes, f.data), { code: 'RECOVERY_STORAGE' });
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A0');
});
