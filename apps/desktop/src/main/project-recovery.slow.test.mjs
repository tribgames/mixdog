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
import { hookProjectSwap } from './project-swap-hook.mjs';
import {
  beginProjectRecovery,
  projectRecoveryStorePath,
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
  hookProjectSwap(t, {
    before(path) {
      if (path === join(f.root, 'b.txt')) throw new Error('test second-write failure');
    },
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
  const restoreHook = hookProjectSwap(t, {
    before(path) {
      if (path === join(f.root, 'b.txt')) {
        rollback = true;
        throw new Error('write denied');
      }
      if (rollback && path === join(f.root, 'a.txt')) throw new Error('rollback denied');
    },
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

test('a real process exit after the first write leaves a usable restart journal', async (t) => {
  const f = await fixture(t);
  const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { writeProjectTextFilesIn } from ${JSON.stringify(new URL('./project-files.ts', import.meta.url).href)};
    const open = fs.open;
    fs.open = async (path, ...args) => {
      const handle = await open(path, ...args);
      if (path === ${JSON.stringify(join(f.root, 'a.txt'))} && args[0] === 'r+') {
        const datasync = handle.datasync.bind(handle);
        handle.datasync = async () => {
          await datasync();
          process.exit(23);
        };
      }
      return handle;
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
    hookProjectSwap(t, {
      async after(path) {
        if (!moved && path === join(target, 'a.txt')) {
          moved = true;
          await fs.rename(target, target + '-old');
          await fs.mkdir(target);
          await fs.writeFile(join(target, 'a.txt'), 'A1');
          await fs.writeFile(join(target, 'b.txt'), 'B0');
        }
      },
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

test("explicit discard removes only a record that still validates as this root's inspected journal", async (t) => {
  const f = await fixture(t);
  const id = await record(f);
  const location = await recoveryLocation(f.data, f.root, id);
  const discard = (revision) => projectRecoveryIn(f.data, f.root, { action: 'discard', id, revision });
  const listed = async () => (await projectRecoveryIn(f.data, f.root, { action: 'list' })).records.map((row) => row.id);

  // Changed since inspection: an added entry or a swapped payload (even one
  // already unusable at inspection) withdraws the approval.
  await fs.writeFile(join(location, '0.after'), 'YY');
  let approved = await inspect(f, id);
  await fs.writeFile(join(location, '0.after'), 'ZZ');
  await assert.rejects(discard(approved.revision), { code: 'RECOVERY_CHANGED' });
  approved = await inspect(f, id);
  await fs.writeFile(join(location, 'foreign.txt'), 'not part of the journal');
  await assert.rejects(discard(approved.revision), { code: 'RECOVERY_CHANGED' });
  await fs.rm(join(location, 'foreign.txt'));

  // Wrong entry type: never inspected as a deletable flat store.
  approved = await inspect(f, id);
  await fs.mkdir(join(location, 'nested'));
  await fs.writeFile(join(location, 'nested', 'keep'), 'keep');
  await assert.rejects(inspect(f, id), { code: 'RECOVERY_STORAGE' });
  await assert.rejects(discard(approved.revision), { code: 'RECOVERY_STORAGE' });
  assert.equal(await fs.readFile(join(location, 'nested', 'keep'), 'utf8'), 'keep');
  await fs.rm(join(location, 'nested'), { recursive: true });

  // Foreign: a valid manifest of another project root is not this journal.
  const manifest = JSON.parse(await fs.readFile(join(location, 'manifest.json'), 'utf8'));
  const original = JSON.stringify(manifest);
  await fs.writeFile(
    join(location, 'manifest.json'),
    JSON.stringify({ ...manifest, root: join(f.base, 'other-project') })
  );
  approved = await inspect(f, id);
  await assert.rejects(discard(approved.revision), { code: 'RECOVERY_MANUAL_INSPECTION' });
  assert.deepEqual(await listed(), [id]);

  // A valid, unchanged record of this root is discarded.
  await fs.writeFile(join(location, 'manifest.json'), original);
  approved = await inspect(f, id);
  await discard(approved.revision);
  assert.deepEqual(await listed(), []);
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A0');
});

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
  const restoreHook = hookProjectSwap(t, {
    async before(path) {
      if (path === join(f.root, 'a.txt')) {
        entered.resolve();
        await release.promise;
      }
    },
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
    usedRecords: 3,
    maxRecords: 20,
    unresolvedRecords: 2,
    resolvedRecords: 1,
    payloadBytes: 16,
    unknownSizeRecords: 1,
    maxBatchBytes: 16777216,
    maxBatchFiles: 100,
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

test('capacity errors retain all records and leave target bytes unchanged', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < RECOVERY_MAX_RECORDS; i++) await record(f, i % 2 ? 'recovered' : 'failed');
  const before = await fs.readdir(projectRecoveryStorePath(f.data, f.root));
  await assert.rejects(writeProjectTextFilesIn(f.root, writes, f.data), { code: 'RECOVERY_CAPACITY' });
  assert.deepEqual(await fs.readdir(projectRecoveryStorePath(f.data, f.root)), before);
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A0');
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

for (const stage of ['writeFile', 'sync', 'close', 'rename']) {
  test(`recovery state ${stage} failure removes its temporary file and preserves the published state`, async (t) => {
    const f = await fixture(t);
    const id = await record(f);
    const directory = await recoveryLocation(f.data, f.root, id);
    const previous = await fs.readFile(join(directory, 'state.json'));
    const entries = (await fs.readdir(directory)).sort();
    const failure = new Error(`injected state ${stage} failure`);
    let injected = false;
    const restore =
      stage === 'rename'
        ? hook(t, 'rename', async (rename, from, to) => {
            if (dirname(from) === directory && from.endsWith('.tmp')) {
              injected = true;
              throw failure;
            }
            return rename(from, to);
          })
        : hook(t, 'open', async (open, path, ...args) => {
            const handle = await open(path, ...args);
            if (dirname(path) === directory && path.endsWith('.tmp')) {
              assert.equal(args[0], 'wx');
              const original = handle[stage].bind(handle);
              handle[stage] = async (...values) => {
                injected = true;
                if (stage === 'writeFile') await original(values[0].subarray(0, 3));
                // A close error can be reported after the descriptor is closed.
                // Close the real handle so this injection also works on Windows.
                if (stage === 'close') await original();
                throw failure;
              };
            }
            return handle;
          });
    await assert.rejects(
      writeRecoveryState(directory, { phase: 'recovered', message: 'retry', restored: [] }),
      (error) => error === failure
    );
    assert.equal(injected, true);
    restore();
    assert.deepEqual(await fs.readFile(join(directory, 'state.json')), previous);
    assert.deepEqual((await fs.readdir(directory)).sort(), entries);
    await writeRecoveryState(directory, { phase: 'recovered', message: 'retry', restored: [] });
    assert.equal(JSON.parse(await fs.readFile(join(directory, 'state.json'), 'utf8')).phase, 'recovered');
    assert.deepEqual((await fs.readdir(directory)).sort(), entries);
  });
}

test('recovery state exclusive-create failure preserves the file it did not create', async (t) => {
  const f = await fixture(t);
  const id = await record(f);
  const directory = await recoveryLocation(f.data, f.root, id);
  const previous = await fs.readFile(join(directory, 'state.json'));
  let collision;
  const restore = hook(t, 'open', async (open, path, ...args) => {
    if (dirname(path) === directory && path.endsWith('.tmp')) {
      collision = path;
      const other = await open(path, 'wx', 0o600);
      try {
        await other.writeFile('existing file owned by another operation');
      } finally {
        await other.close();
      }
    }
    return open(path, ...args);
  });
  await assert.rejects(writeRecoveryState(directory, { phase: 'recovered', message: '', restored: [] }), {
    code: 'EEXIST',
  });
  restore();
  assert.ok(collision);
  assert.equal(await fs.readFile(collision, 'utf8'), 'existing file owned by another operation');
  assert.deepEqual(await fs.readFile(join(directory, 'state.json')), previous);
});

test('aggregate UTF-16 preflight byte exhaustion returns the batch-limit code before any mutation', async (t) => {
  const f = await fixture(t);
  const content = 'x'.repeat(3_000_000);
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]);
  for (const rel of ['a.txt', 'b.txt']) await fs.writeFile(join(f.root, rel), bytes);
  let readOversizedBody = false;
  hook(t, 'open', (open, file, ...args) => {
    if (file === join(f.root, 'b.txt') && args[0] === 'r') readOversizedBody = true;
    return open(file, ...args);
  });
  await assert.rejects(
    writeProjectTextFilesIn(
      f.root,
      ['a.txt', 'b.txt'].map((relPath) => ({
        relPath,
        expectedContent: content,
        content: content + 'y',
      })),
      f.data
    ),
    { code: 'RECOVERY_BATCH_LIMIT' }
  );
  assert.equal(readOversizedBody, false, 'reject over-budget input before allocating/reading its payload');
  for (const rel of ['a.txt', 'b.txt']) assert.deepEqual(await fs.readFile(join(f.root, rel)), bytes);
  assert.deepEqual((await projectRecoveryIn(f.data, f.root, { action: 'list' })).records, []);
});

test('unknown store entries require manual inspection instead of an empty inventory', async (t) => {
  const f = await fixture(t);
  const store = projectRecoveryStorePath(f.data, f.root);
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(join(store, '.DS_Store'), 'unrecognized');
  await assert.rejects(projectRecoveryIn(f.data, f.root, { action: 'list' }), { code: 'RECOVERY_MANUAL_INSPECTION' });
  await assert.rejects(writeProjectTextFilesIn(f.root, writes, f.data), { code: 'RECOVERY_MANUAL_INSPECTION' });
  assert.equal(await fs.readFile(join(store, '.DS_Store'), 'utf8'), 'unrecognized');
  assert.equal(await fs.readFile(join(f.root, 'a.txt'), 'utf8'), 'A0');
  await fs.rm(join(store, '.DS_Store'));
  assert.deepEqual((await projectRecoveryIn(f.data, f.root, { action: 'list' })).records, []);
});

for (const kind of ['file', 'symlink']) {
  test(`a recovery-named ${kind} requires manual inspection without touching its contents`, async (t) => {
    const f = await fixture(t);
    const store = projectRecoveryStorePath(f.data, f.root);
    await fs.mkdir(store, { recursive: true });
    const location = join(store, randomUUID());
    const target = join(f.base, 'unrelated');
    if (kind === 'file') await fs.writeFile(location, 'preserve');
    else {
      await fs.mkdir(target);
      await fs.writeFile(join(target, 'keep'), 'preserve');
      await fs.symlink(target, location, process.platform === 'win32' ? 'junction' : 'dir');
    }
    await assert.rejects(projectRecoveryIn(f.data, f.root, { action: 'list' }), { code: 'RECOVERY_MANUAL_INSPECTION' });
    assert.equal(await fs.readFile(kind === 'file' ? location : join(target, 'keep'), 'utf8'), 'preserve');
  });
}
