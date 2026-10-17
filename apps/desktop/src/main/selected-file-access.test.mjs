import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { withApiFileGrantRefresh } from '../renderer/remote-file-grant-refresh.ts';
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

test('describing a file again keeps its token, so repeated link checks never evict an open file', async (t) => {
  const { access, files } = await fixture(t);
  const [opened] = await access.describe([files[0]]);
  // Every verification or hover of another link describes its file again.
  for (let index = 0; index < 101; index++) await access.describe([files[1]]);
  assert.equal((await requireFile(access, opened.accessToken, files[0])).absolute, files[0]);
  const [again] = await access.describe([files[0]]);
  assert.equal(again.accessToken, opened.accessToken);
});

test('the window API re-grants once on the permission refusal and passes other refusals through', async () => {
  const refusal = () =>
    Object.assign(new Error('The selected-file permission is unavailable.'), {
      code: 'SELECTED_FILE_GRANT_UNAVAILABLE',
    });
  const run = async (failure) => {
    const calls = [];
    const api = withApiFileGrantRefresh({
      resolveLocalPaths: async (paths) => {
        calls.push('resolve');
        return [{ absolutePath: paths[0], accessToken: 'fresh', projectPath: 'C:\\outside', relPath: 'a.txt' }];
      },
      readProjectFile: async () => {
        calls.push('read');
        throw failure();
      },
    });
    await api.resolveLocalPaths(['C:\\outside\\a.txt']);
    calls.length = 0;
    const error = await api.readProjectFile('C:\\outside', 'a.txt', 'held').catch((e) => e);
    return { calls, error };
  };
  // Granted again once and retried once; the second refusal is the answer.
  const once = await run(refusal);
  assert.deepEqual(once.calls, ['read', 'resolve', 'read']);
  assert.match(once.error.message, /permission is unavailable/);
  // Any other refusal passes through untouched, with no re-grant.
  const other = await run(() => Object.assign(new Error('ENOENT: missing'), { code: 'ENOENT' }));
  assert.deepEqual(other.calls, ['read']);
  assert.equal(other.error.code, 'ENOENT');
});

test('a held link whose grant was dropped past the cap is granted again and opens', async (t) => {
  const { access, root, files } = await fixture(t);
  // The window's file API over this grant store, as the preload exposes it.
  const windowApi = {
    resolveLocalPaths: (paths) => access.describe(paths),
    readProjectFile: async (projectPath, relPath, accessToken) => {
      const { absolute } = await access.requireGrant(accessToken, projectPath, relPath);
      return { content: await fs.readFile(absolute, 'utf8') };
    },
  };
  const api = withApiFileGrantRefresh(windowApi);
  const [held] = await api.resolveLocalPaths([files[0]]);
  const others = Array.from({ length: 100 }, (_, index) => join(root, `other-${index}.txt`));
  await Promise.all(others.map((file) => fs.writeFile(file, 'other')));
  for (const file of others) await api.resolveLocalPaths([file]);
  await assert.rejects(requireFile(access, held.accessToken, files[0]), /selected-file permission is unavailable/);

  // Before the fix: "The selected-file permission is unavailable."
  assert.equal((await api.readProjectFile(held.projectPath, held.relPath, held.accessToken)).content, 'fixture');
  assert.equal((await api.readProjectFile(held.projectPath, held.relPath, held.accessToken)).content, 'fixture');
  // A token that never named a grant for this path is still refused.
  await assert.rejects(api.readProjectFile(root, 'missing.txt', 'never-granted'), { code: 'ENOENT' });
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
