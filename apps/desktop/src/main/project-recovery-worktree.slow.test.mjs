import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { createDesktopOperations } from './desktop-operations.ts';
import { projectRecoveryStorePath } from './project-recovery-store.ts';
import { configureWorktreeManager, removeManagedWorktree, withWorktreeRecoveryStore } from '../../../../src/runtime/shared/worktrees/manager.mjs';
import { getRecord } from '../../../../src/runtime/shared/worktrees/registry.mjs';
import { cleanupTempDirs, commitFile, createTestWorktree, makeRepo, tempDir, useTempDataDir } from '../../../../src/runtime/shared/worktrees/test-support.mjs';

test('a real host journal survives force removal and stays manageable after its checkout disappears', async (t) => {
  useTempDataDir();
  const reset = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER, processAlive: () => false });
  t.after(() => { reset(); cleanupTempDirs(); });
  const repo = makeRepo();
  commitFile(repo, 'b.txt', 'B0');
  const { entry } = await createTestWorktree(repo);
  const data = realpathSync(tempDir('mixdog-desktop-recovery-profile-'));
  const operations = createDesktopOperations({
    userDataPath: data, emit() {},
    withRecoveryStore: (root, action, run) => withWorktreeRecoveryStore(root, projectRecoveryStorePath(data, root), action, run),
  });
  t.after(() => operations.dispose());
  const rename = fs.rename;
  const mocked = t.mock.method(fs, 'rename', (from, to) => {
    if (to === join(entry.path, 'b.txt')) throw new Error('injected second write failure');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(operations.invoke('writeProjectTextFilesIn', [entry.path, [
      { relPath: 'README.md', expectedContent: 'hello\n', content: 'changed\n' },
      { relPath: 'b.txt', expectedContent: 'B0', content: 'B1' },
    ]]), /\[file-recovery\]/);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  const scopes = (await getRecord(entry.id)).editorRecoveryStores;
  assert.deepEqual(scopes, [{ root: entry.path, directory: projectRecoveryStorePath(data, entry.path) }]);
  await assert.rejects(removeManagedWorktree({ entryId: entry.id, force: true }), { code: 'WORKTREE_FILE_RECOVERY' });
  assert.ok(existsSync(entry.path));
  // An external deletion is not prevented by the manager; the private backup
  // inventory and explicit discard must remain usable afterward.
  await fs.rm(entry.path, { recursive: true });
  const listed = await operations.invoke('projectRecoveryIn', [entry.path, { action: 'list' }]);
  assert.equal(listed.rootAvailable, false);
  assert.equal(listed.storage.usedRecords, 1);
  const { detail } = await operations.invoke('projectRecoveryIn', [entry.path, { action: 'inspect', id: listed.records[0].id }]);
  assert.ok(detail.files.every((file) => file.status === 'missing'));
  const result = await operations.invoke('projectRecoveryIn', [entry.path, { action: 'discard', id: detail.id, revision: detail.revision }]);
  assert.equal(result.records.length, 0);
  assert.equal((await removeManagedWorktree({ entryId: entry.id, force: true })).removed, true);
});
