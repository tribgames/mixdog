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
