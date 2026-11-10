import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs, { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGitHeadWatcher } from '../../runtime/shared/worktrees/git-head.mjs';
import { createSessionWorkspaceView } from './session-view.mjs';

test('getLiveWorkspace of a watched project folder reads HEAD from the cache, with no sync fs', (t) => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-session-view-')));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  mkdirSync(join(top, '.git'));
  writeFileSync(join(top, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  t.mock.method(fs, 'watch', () => Object.assign(new EventEmitter(), { close() {} }));
  syncBuiltinESMExports();
  const session = { id: 'sess_1', cwd: top };
  const view = createSessionWorkspaceView({ getSession: () => session, getCurrentCwd: () => top });
  const watcher = createGitHeadWatcher({ getCwd: () => view.getLiveWorkspace()?.cwd || top, onChange() {} });
  t.after(() => watcher.dispose());
  watcher.retarget();
  const first = view.getLiveWorkspace();
  assert.equal(first.branch, 'main');
  const calls = [];
  for (const name of ['readFileSync', 'statSync', 'lstatSync', 'existsSync', 'realpathSync']) {
    const original = fs[name];
    t.mock.method(fs, name, (...args) => {
      calls.push(name);
      return original(...args);
    });
  }
  syncBuiltinESMExports();
  for (let i = 0; i < 5; i++) {
    assert.equal(view.getLiveWorkspace(), first);
    watcher.retarget();
  }
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.deepEqual(calls, []);
});

test('getLiveWorkspace of a managed worktree names the branch its checkout has now', (t) => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-session-view-')));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  mkdirSync(join(top, '.git'));
  const head = (text) => writeFileSync(join(top, '.git', 'HEAD'), `${text}\n`);
  head('ref: refs/heads/feat/place-review');
  const workspace = {
    projectPath: join(top, 'project'),
    repoCommonDir: join(top, '.git'),
    cwd: top,
    worktreeId: 'feat-place-review',
    branch: 'feat/place-review',
    baseCommit: null,
    mergeTarget: 'main',
    revision: 3,
    transition: { state: 'idle', txId: null },
  };
  const session = { id: 'sess_1', cwd: top, workspace };
  const view = createSessionWorkspaceView({ getSession: () => session, getCurrentCwd: () => top });
  assert.equal(view.getLiveWorkspace(), workspace);
  // Renamed inside the checkout (`git branch -m`): the new name, nothing else changed.
  head('ref: refs/heads/place');
  const renamed = view.getLiveWorkspace();
  assert.deepEqual(renamed, { ...workspace, branch: 'place' });
  assert.equal(view.getLiveWorkspace(), renamed);
  // Detached (a rebase, bisect or `switch --detach`): the recorded branch, as the manager acts on it.
  head('0123456789abcdef0123456789abcdef01234567');
  assert.equal(view.getLiveWorkspace(), workspace);
  // Switched to another branch: that branch.
  head('ref: refs/heads/side');
  assert.deepEqual(view.getLiveWorkspace(), { ...workspace, branch: 'side' });
  // Back on the recorded branch: the stored record as it is.
  head('ref: refs/heads/feat/place-review');
  assert.equal(view.getLiveWorkspace(), workspace);
});
