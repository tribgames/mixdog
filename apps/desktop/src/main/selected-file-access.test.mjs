import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { SelectedFileAccess } from './selected-file-access.ts';
import { parseSelectedFileGrants, selectedFileGrantKey, serializeSelectedFileGrants } from './selected-file-grants.ts';
import { readSecretFile, writeSecretFile } from './secret-file.ts';

async function fixture(t, seed = false) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-selected-file-'));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  });
  const files = [join(root, 'a.txt'), join(root, 'b.txt')];
  await Promise.all(files.map((file) => fs.writeFile(file, 'fixture')));
  const storePath = join(root, 'grants.json');
  const token = 'stored-fixture-token';
  if (seed) {
    await writeSecretFile(storePath, serializeSelectedFileGrants(new Map([[selectedFileGrantKey(token), files[0]]])));
  }
  const create = () => new SelectedFileAccess({ storePath, listProjects: async () => [] });
  return { root, files, storePath, token, create, access: create() };
}

const requireFile = (access, token, file) => access.requireGrant(token, dirname(file), basename(file));

test('concurrent permission reads share the initial load instead of seeing an empty grant map', async (t) => {
  const { access, files, storePath, token } = await fixture(t, true);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const read = fs.readFile;
  t.mock.method(fs, 'readFile', async (path, ...args) => {
    if (path === storePath) {
      entered.resolve();
      await release.promise;
    }
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  const first = requireFile(access, token, files[0]);
  await entered.promise;
  let secondSettled = false;
  const second = requireFile(access, token, files[0]);
  void second.then(
    () => {
      secondSettled = true;
    },
    () => {
      secondSettled = true;
    }
  );
  try {
    await new Promise(setImmediate);
    assert.equal(secondSettled, false);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
  }
  assert.equal((await first).absolute, files[0]);
  assert.equal((await second).absolute, files[0]);
});

test('a failed permission-file read remains retryable without losing existing grants', async (t) => {
  const { access, files, storePath, token } = await fixture(t, true);
  const read = fs.readFile;
  const failure = Object.assign(new Error('grant read failed'), { code: 'EIO' });
  let fail = true;
  t.mock.method(fs, 'readFile', async (path, ...args) => {
    if (path === storePath && fail) {
      fail = false;
      throw failure;
    }
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(requireFile(access, token, files[0]), (error) => error === failure);
  assert.equal((await requireFile(access, token, files[0])).absolute, files[0]);
});

test('a rejected file selection cannot leave partially created grants behind', async (t) => {
  const { access, root, files, storePath } = await fixture(t);
  await assert.rejects(access.describe([files[0], join(root, 'missing.txt')]), { code: 'ENOENT' });
  const [selected] = await access.describe([files[1]]);
  const persisted = parseSelectedFileGrants(await readSecretFile(storePath));
  assert.equal(persisted.grants.size, 1);
  assert.equal((await requireFile(access, selected.accessToken, files[1])).absolute, files[1]);
});

test('failed grant publication does not leak unpublished grants into a later successful save', async (t) => {
  const { access, files, storePath } = await fixture(t);
  const rename = fs.rename;
  const failure = Object.assign(new Error('grant publication failed'), { code: 'ENOSPC' });
  let fail = true;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === storePath && fail) {
      fail = false;
      throw failure;
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  await assert.rejects(access.describe([files[0]]), (error) => error === failure);
  const [selected] = await access.describe([files[1]]);
  const persisted = parseSelectedFileGrants(await readSecretFile(storePath));
  assert.equal(persisted.grants.size, 1);
  assert.equal((await requireFile(access, selected.accessToken, files[1])).absolute, files[1]);
});

test('concurrent successful selections remain authorized after reloading their persisted grants', async (t) => {
  const { access, files, create } = await fixture(t);
  const results = await Promise.all(files.map((file) => access.describe([file])));
  const reloaded = create();
  for (let index = 0; index < files.length; index++) {
    assert.equal((await requireFile(reloaded, results[index][0].accessToken, files[index])).absolute, files[index]);
  }
  await assert.rejects(requireFile(reloaded, results[0][0].accessToken, files[1]), /does not match/);
});
