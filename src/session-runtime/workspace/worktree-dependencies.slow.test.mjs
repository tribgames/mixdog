// A new managed worktree gets its JS dependencies prepared with nothing to
// configure, against real git: an identical lockfile links the main
// checkout's node_modules (a junction on Windows), a different one runs the
// frozen install at the first turn, none does nothing; removing the worktree
// never touches the main checkout's node_modules.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { findLockfileFolders, planDependencySetup } from '../../runtime/shared/worktrees/dependencies.mjs';
import { configureWorktreeManager, removeManagedWorktree } from '../../runtime/shared/worktrees/manager.mjs';
import { samePath } from '../../runtime/shared/worktrees/paths.mjs';
import {
  cleanupTempDirs,
  commitFile,
  createTestWorktree,
  makeRepo,
  tempDir,
  useTempDataDir,
  writeFile,
} from '../../runtime/shared/worktrees/test-support.mjs';
import { createWorkspaceTransitions } from './transitions.mjs';

after(() => cleanupTempDirs());
beforeEach(useTempDataDir);

const LOCK = '{"name":"app","lockfileVersion":3,"requires":true,"packages":{"":{"name":"app"}}}\n';
const MAIN_DEP = 'node_modules/dep/index.js';

/** A repository with a committed package.json and lockfile, and an installed node_modules. */
function jsRepo({ lockfile = true, installed = true } = {}) {
  const repo = makeRepo();
  commitFile(repo, '.gitignore', 'node_modules\n');
  commitFile(repo, 'package.json', '{"name":"app"}\n');
  if (lockfile) commitFile(repo, 'package-lock.json', LOCK);
  if (installed) writeFile(repo, MAIN_DEP, 'module.exports = 1;\n');
  return repo;
}

/**
 * A PATH holding only a fake `npm` that runs `source` (a node script) and
 * appends `{ cwd, args }` to the returned log.
 */
function fakeNpm(source = '') {
  const bin = tempDir('mixdog-fake-npm-');
  const log = join(bin, 'calls.jsonl');
  const script = join(bin, 'npm.cjs');
  writeFileSync(
    script,
    `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');\n${source}`
  );
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'npm.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(join(bin, 'npm'), 0o755);
  }
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  return { env: { ...process.env, PATH: bin, Path: bin }, calls };
}

function harness(repo, npm) {
  const session = {
    id: `sess_deps_${process.pid}_${Math.random().toString(36).slice(2)}`,
    cwd: repo,
    desktopSession: { classification: 'project', projectPath: repo },
    messages: [],
  };
  const state = { cwd: repo };
  const api = createWorkspaceTransitions({
    getSession: () => session,
    getCurrentCwd: () => state.cwd,
    applyResolvedCwd: (next) => {
      state.cwd = next;
      session.cwd = next;
    },
    persistSession: () => {},
    refreshWorkspaceContext: async () => {},
    getActiveTurnCount: () => 0,
    agentStatusState: () => ({ agentWorkers: [], agentJobs: [] }),
    countOwnShellJobs: async () => 0,
    listLiveSessions: () => [],
    findRegisteredProject: async (path) => (samePath(path, repo) ? repo : null),
    planWorktreeSetup: (input) => planDependencySetup({ ...input, env: npm.env }),
  });
  const events = [];
  api.onWorktreeSetup((event) => events.push(event));
  return { session, state, api, events };
}

async function withManager(run) {
  const restore = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER });
  try {
    await run();
  } finally {
    restore();
  }
}

function assertMainIntact(repo) {
  assert.equal(readFileSync(join(repo, MAIN_DEP), 'utf8'), 'module.exports = 1;\n', 'main node_modules intact');
  assert.equal(lstatSync(join(repo, 'node_modules')).isSymbolicLink(), false);
}

test('an identical lockfile links node_modules from the main checkout and installs nothing, once', async () => {
  await withManager(async () => {
    const repo = jsRepo();
    const npm = fakeNpm();
    const h = harness(repo, npm);
    const entered = await h.api.requestWorktree({ provision: true, prompt: 'Linked deps', txId: 'deps-link' });
    const linked = join(entered.workspace.cwd, 'node_modules');
    assert.equal(lstatSync(linked).isSymbolicLink(), true, 'a junction/symlink, made at creation');
    assert.ok(samePath(realpathSync(linked), realpathSync(join(repo, 'node_modules'))));
    await h.api.prepareTurnWorkspace({ submissionId: 'turn-1', prompt: 'go' });
    await h.api.prepareTurnWorkspace({ submissionId: 'turn-2', prompt: 'again' });
    assert.deepEqual(npm.calls(), [], 'no install');
    assert.equal(h.events.length, 0, 'nothing installs: the user sees nothing');
    const note = h.session.pendingSetupNotice.content;
    assert.match(note, /^<system-reminder>\n# Worktree Preparation\nThis worktree was made from the main checkout at /);
    const [, mainPath] = /main checkout at (.+?); ignored files/.exec(note);
    assert.ok(samePath(mainPath, repo), 'the agent is told the main checkout path');
    assert.match(note, /\nLinked node_modules from the main checkout: project root\.\n/);
    assertMainIntact(repo);
  });
});

test('a lockfile that differs from the main checkout runs the frozen install in the worktree once', async () => {
  await withManager(async () => {
    const repo = jsRepo();
    writeFileSync(join(repo, 'package-lock.json'), LOCK.replace('"app"}}}', '"app","version":"2.0.0"}}}'));
    const npm = fakeNpm("require('fs').mkdirSync('node_modules/installed', { recursive: true });");
    const h = harness(repo, npm);
    const entered = await h.api.requestWorktree({
      provision: true,
      prompt: 'Install deps',
      txId: 'deps-install',
      carryChanges: 'leave',
    });
    const worktree = entered.workspace.cwd;
    assert.equal(existsSync(join(worktree, 'node_modules')), false, 'nothing is linked or installed before the turn');
    await h.api.prepareTurnWorkspace({ submissionId: 'turn-1', prompt: 'go' });
    await h.api.prepareTurnWorkspace({ submissionId: 'turn-2', prompt: 'again' });
    const calls = npm.calls();
    assert.equal(calls.length, 1, 'the install runs once per new worktree');
    assert.deepEqual(calls[0].args, ['ci']);
    assert.ok(samePath(calls[0].cwd, worktree));
    assert.equal(lstatSync(join(worktree, 'node_modules')).isSymbolicLink(), false);
    assert.equal(h.events.at(-1).final, true);
    assert.equal(h.events.at(-1).status, 'completed');
    assert.equal(
      existsSync(join(repo, 'node_modules', 'installed')),
      false,
      'the main checkout is never installed into'
    );
    assertMainIntact(repo);
  });
});

test('no lockfile prepares nothing and says so once', async () => {
  await withManager(async () => {
    const repo = jsRepo({ lockfile: false });
    const npm = fakeNpm();
    const h = harness(repo, npm);
    const entered = await h.api.requestWorktree({ provision: true, prompt: 'No lockfile', txId: 'deps-none' });
    await h.api.prepareTurnWorkspace({ submissionId: 'turn-1', prompt: 'go' });
    await h.api.prepareTurnWorkspace({ submissionId: 'turn-2', prompt: 'again' });
    assert.equal(existsSync(join(entered.workspace.cwd, 'node_modules')), false);
    assert.deepEqual(npm.calls(), []);
    assert.equal(h.events.length, 0);
    assert.match(
      h.session.pendingSetupNotice.content,
      /\nNo lockfile or dependency manifest found; nothing was installed\.\n/
    );
  });
});

test('the root, declared workspaces and nested projects installed in main are prepared, never a fixture', async () => {
  await withManager(async () => {
    const repo = jsRepo({ installed: false });
    commitFile(repo, 'package.json', '{"name":"app","workspaces":["packages/*"]}\n');
    for (const dir of ['packages/a', 'apps/x', 'test/fixtures/app']) {
      commitFile(repo, `${dir}/package.json`, '{"name":"x"}\n');
      commitFile(repo, `${dir}/package-lock.json`, LOCK);
    }
    // The user installed apps/x in the main checkout; the fixture never was.
    writeFile(repo, 'apps/x/node_modules/dep/index.js', 'module.exports = 1;\n');
    const npm = fakeNpm();
    const h = harness(repo, npm);
    const entered = await h.api.requestWorktree({ provision: true, prompt: 'Nested deps', txId: 'deps-nested' });
    const worktree = entered.workspace.cwd;
    assert.equal(lstatSync(join(worktree, 'apps', 'x', 'node_modules')).isSymbolicLink(), true, 'apps/x is linked');
    assert.equal(existsSync(join(worktree, 'test', 'fixtures', 'app', 'node_modules')), false);
    const plan = await planDependencySetup({ worktreeDir: worktree, mainDir: repo, env: npm.env });
    assert.deepEqual(
      plan.commands.map((command) => command.label),
      ['npm (project root)', 'npm (packages/a)'],
      'the fixture gets no install'
    );
    assert.deepEqual(plan.notes, ['Linked node_modules from the main checkout: apps/x.']);
  });

  const pnpm = makeRepo();
  commitFile(pnpm, 'package.json', '{"name":"mono"}\n');
  commitFile(pnpm, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  commitFile(pnpm, 'pnpm-workspace.yaml', 'packages:\n  - \'libs/**\'\n  - "!libs/skip"\n');
  for (const dir of ['libs/core/util', 'libs/skip', 'fixtures/demo']) {
    commitFile(pnpm, `${dir}/package.json`, '{"name":"y"}\n');
    commitFile(pnpm, `${dir}/pnpm-lock.yaml`, 'lockfileVersion: 9\n');
  }
  assert.deepEqual(
    (await findLockfileFolders(pnpm)).map((folder) => [folder.dir, folder.manager]),
    [
      ['', 'pnpm'],
      ['libs/core/util', 'pnpm'],
    ]
  );
});

test('a package manager that is not on PATH is skipped with a note', async () => {
  const repo = jsRepo({ installed: false });
  const plan = await planDependencySetup({ worktreeDir: repo, env: { PATH: tempDir('mixdog-empty-path-'), Path: '' } });
  assert.deepEqual(plan.commands, []);
  assert.deepEqual(plan.notes, [
    'npm is not on PATH; project root was not prepared (run `npm ci` there if tests need it).',
  ]);
});

test('a failed install keeps the worktree and the session in it, and the turn goes on', async () => {
  await withManager(async () => {
    const repo = jsRepo({ installed: false });
    const npm = fakeNpm("console.error('npm ERR! missing'); process.exit(2);");
    const h = harness(repo, npm);
    const entered = await h.api.requestWorktree({ provision: true, prompt: 'Failing deps', txId: 'deps-fail' });
    const worktree = entered.workspace.cwd;
    await h.api.prepareTurnWorkspace({ submissionId: 'turn-1', prompt: 'go' });
    const final = h.events.at(-1);
    assert.equal(final.final, true);
    assert.equal(final.status, 'failed');
    assert.match(
      h.session.pendingSetupNotice.content,
      /\nFailed: .*npm.* ci \[npm \(project root\)\] \(failed, exit 2\)\nnpm ERR! missing\n/,
      'the agent gets the failure with its output tail'
    );
    assert.ok(existsSync(worktree), 'the worktree is kept');
    assert.ok(samePath(h.state.cwd, worktree), 'the session stays in its worktree');
  });
});

test('stopping the turn cancels the install; the worktree stays and the turn aborts', async () => {
  await withManager(async () => {
    const repo = jsRepo({ installed: false });
    const npm = fakeNpm("console.log('installing'); setTimeout(() => {}, 30000);");
    const h = harness(repo, npm);
    const entered = await h.api.requestWorktree({ provision: true, prompt: 'Cancel deps', txId: 'deps-cancel' });
    const controller = new AbortController();
    h.api.onWorktreeSetup((event) => {
      if (!event.final && event.output?.includes('installing')) controller.abort();
    });
    await assert.rejects(
      h.api.prepareTurnWorkspace({ submissionId: 'turn-1', prompt: 'go', signal: controller.signal }),
      (error) => error?.name === 'AbortError' || /abort/i.test(String(error?.message))
    );
    assert.equal(h.events.at(-1).status, 'cancelled');
    assert.ok(existsSync(entered.workspace.cwd), 'the worktree is kept');
  });
});

for (const [name, options, ignored] of [
  ['forced removal', { force: true }, true],
  ['folder-only cleanup', { safeOnly: true }, true],
  // Not git-ignored: the link is still never seen as a user change.
  ['folder-only cleanup of an unignored link', { safeOnly: true }, false],
]) {
  test(`${name} unlinks the linked node_modules and leaves the main checkout's intact`, async () => {
    await withManager(async () => {
      const repo = jsRepo();
      if (!ignored) commitFile(repo, '.gitignore', '');
      mkdirSync(join(repo, 'node_modules', 'dep', 'nested'), { recursive: true });
      writeFileSync(join(repo, 'node_modules', 'dep', 'nested', 'deep.js'), 'deep\n');
      const { entry, sessionId } = await createTestWorktree(repo);
      const linked = join(entry.path, 'node_modules');
      assert.equal(lstatSync(linked).isSymbolicLink(), true);
      const result = await removeManagedWorktree({ entryId: entry.id, sessionId, ...options });
      assert.equal(result.removed, true, JSON.stringify(result));
      assert.equal(existsSync(entry.path), false, 'the worktree is gone');
      assertMainIntact(repo);
      assert.equal(readFileSync(join(repo, 'node_modules', 'dep', 'nested', 'deep.js'), 'utf8'), 'deep\n');
    });
  });
}
