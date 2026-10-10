import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalAccessDeniedError, isLocalAccessDenied } from './local-access-denied.ts';
import { SelectedFileAccess } from './selected-file-access.ts';
import { DesktopProjectRegistry } from './desktop-project-registry.ts';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-local-authority-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('only explicit authority codes survive serialization as a definite denial', () => {
  const denial = new LocalAccessDeniedError('private diagnostic');
  assert.equal(isLocalAccessDenied(denial), true);
  assert.equal(isLocalAccessDenied(JSON.parse(JSON.stringify({ code: denial.code }))), true);
  for (const error of [null, undefined, {}, new Error(denial.message), { code: 'EACCES' }, { code: 'ETIMEDOUT' }]) {
    assert.equal(isLocalAccessDenied(error), false);
  }
});

test('selected-file authority marks missing grants and mismatched paths, not its storage failure', async (t) => {
  const root = await fixture(t);
  const access = new SelectedFileAccess({ storePath: '', listProjects: async () => [] });
  await fs.writeFile(join(root, 'page.html'), '<p>selected</p>');
  const [selected] = await access.describe([join(root, 'page.html')]);
  await access.requireGrant(selected.accessToken, root, 'page.html');
  await assert.rejects(access.requireGrant('unknown', root, 'page.html'), isLocalAccessDenied);
  await assert.rejects(access.requireGrant(selected.accessToken, root, 'other.html'), isLocalAccessDenied);

  const storePath = join(root, 'grants.json');
  const unavailable = new SelectedFileAccess({ storePath, listProjects: async () => [] });
  const failure = Object.assign(new Error('injected storage error'), { code: 'EIO' });
  const read = fs.readFile;
  t.mock.method(fs, 'readFile', (path, ...args) => {
    if (path === storePath) return Promise.reject(failure);
    return read(path, ...args);
  });
  await assert.rejects(unavailable.requireGrant('unknown', root, 'page.html'), (error) => {
    assert.equal(error, failure);
    assert.equal(isLocalAccessDenied(error), false);
    return true;
  });
});

test('project authority marks removal but preserves module and registry lookup failures', async (t) => {
  const root = await fixture(t);
  let rows = [{ path: root, name: 'fixture', addedAt: 0 }];
  let failure = null;
  let lookupFailure = null;
  const registry = new DesktopProjectRegistry({
    userDataRoot: () => root,
    async loadProjectsModule() {
      if (failure) throw failure;
      return { listProjects() { if (lookupFailure) throw lookupFailure; return rows; } };
    },
  });
  assert.equal(await registry.knownPath(root), root);
  rows = [];
  await assert.rejects(registry.knownPath(root), isLocalAccessDenied);
  failure = new Error('temporary daemon failure');
  await assert.rejects(registry.knownPath(root), (error) => error === failure && !isLocalAccessDenied(error));
  failure = null;
  lookupFailure = Object.assign(new Error('temporary registry failure'), { code: 'EIO' });
  await assert.rejects(registry.knownPath(root), (error) => error === lookupFailure && !isLocalAccessDenied(error));
});
