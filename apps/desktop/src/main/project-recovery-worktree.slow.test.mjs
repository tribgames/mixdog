import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createDesktopOperations } from './desktop-operations.ts';
import { projectRecoveryStorePath } from './project-recovery-store.ts';
import { hookProjectSwap } from './project-swap-hook.mjs';
import { SessionHost } from './session-host.ts';
import * as worktrees from '../../../../src/runtime/shared/worktrees/manager.mjs';
import {
  configureWorktreeManager,
  removeManagedWorktree,
  withWorktreeRecoveryStore,
} from '../../../../src/runtime/shared/worktrees/manager.mjs';
import { getRecord } from '../../../../src/runtime/shared/worktrees/registry.mjs';
import {
  cleanupTempDirs,
  commitFile,
  createTestWorktree,
  makeRepo,
  tempDir,
  useTempDataDir,
} from '../../../../src/runtime/shared/worktrees/test-support.mjs';

test('a real host journal survives force removal and stays manageable after its checkout disappears', async (t) => {
  useTempDataDir();
  const reset = configureWorktreeManager({
    settings: {},
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
  });
  t.after(() => {
    reset();
    cleanupTempDirs();
  });
  const repo = makeRepo();
  commitFile(repo, 'b.txt', 'B0');
  const { entry } = await createTestWorktree(repo);
  const data = realpathSync(tempDir('mixdog-desktop-recovery-profile-'));
  const project = await fs.realpath(repo);
  const host = await SessionHost.create(
    { userDataPath: data, resourcesPath: data, appPath: data, packaged: false },
    {
      attachSessionClient: async () => ({ list: async () => ({ sessions: [] }), close: async () => {} }),
      loadProjects: async () => ({ listProjects: () => [{ name: 'repo', path: project, addedAt: 1 }] }),
      loadWorktrees: async () => worktrees,
      loadSessionStore: async () => ({}),
      loadStatuslineSegments: async () => ({}),
      executeCodeGraphTool: async () => ({}),
    }
  );
  t.after(() => host.dispose());
  const fileRoot = await host.projectDirectory(entry.path);
  assert.equal(await host.projectRecoveryDirectory(entry.path), fileRoot, 'recovery uses the actual writer root');
  const operations = createDesktopOperations({
    userDataPath: data,
    emit() {},
    withRecoveryStore: (root, action, run) =>
      withWorktreeRecoveryStore(root, projectRecoveryStorePath(data, root), action, run),
  });
  t.after(() => operations.dispose());
  const restoreSwap = hookProjectSwap(t, {
    before(path) {
      if (path === join(fileRoot, 'b.txt')) throw new Error('injected second write failure');
    },
  });
  try {
    await assert.rejects(
      operations.invoke('writeProjectTextFilesIn', [
        fileRoot,
        [
          { relPath: 'README.md', expectedContent: 'hello\n', content: 'changed\n' },
          { relPath: 'b.txt', expectedContent: 'B0', content: 'B1' },
        ],
      ]),
      /\[file-recovery\]/
    );
  } finally {
    restoreSwap();
  }
  const scopes = (await getRecord(entry.id)).editorRecoveryStores;
  assert.deepEqual(scopes, [{ root: fileRoot, directory: projectRecoveryStorePath(data, fileRoot) }]);
  await assert.rejects(removeManagedWorktree({ entryId: entry.id, force: true }), { code: 'WORKTREE_FILE_RECOVERY' });
  assert.ok(existsSync(entry.path));
  // An external deletion is not prevented by the manager; the private backup
  // inventory and explicit discard must remain usable afterward.
  await fs.rm(entry.path, { recursive: true });
  const recoveryRoot = await host.projectRecoveryDirectory(entry.path);
  assert.equal(recoveryRoot, fileRoot, 'missing checkout keeps the writer root spelling');
  const listed = await operations.invoke('projectRecoveryIn', [recoveryRoot, { action: 'list' }]);
  assert.equal(listed.rootAvailable, false);
  assert.equal(listed.storage.usedRecords, 1);
  const { detail } = await operations.invoke('projectRecoveryIn', [
    recoveryRoot,
    { action: 'inspect', id: listed.records[0].id },
  ]);
  assert.ok(detail.files.every((file) => file.status === 'missing'));
  const result = await operations.invoke('projectRecoveryIn', [
    recoveryRoot,
    { action: 'discard', id: detail.id, revision: detail.revision },
  ]);
  assert.equal(result.records.length, 0);
  assert.equal((await removeManagedWorktree({ entryId: entry.id, force: true })).removed, true);
  // Requests may already hold the host-resolved root when removal wins the
  // race. Even that canonical spelling must not fall through as unmanaged.
  await assert.rejects(operations.invoke('projectRecoveryIn', [recoveryRoot, { action: 'list' }]), {
    code: 'WORKTREE_MISSING',
  });
  await assert.rejects(operations.invoke('writeProjectTextFilesIn', [fileRoot, []]), { code: 'WORKTREE_MISSING' });
});
