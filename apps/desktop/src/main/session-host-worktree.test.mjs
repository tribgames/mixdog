import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { SessionHost } from './session-host.ts';

async function fixture(t, { registerProject = true, entryFor, containing = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mixdog-host-worktree-')));
  const project = join(root, 'repo');
  const worktree = join(root, 'data', 'worktrees-v1', '0123456789abcdef', 'fix-login');
  const arbitrary = join(root, 'elsewhere');
  for (const dir of [project, worktree, arbitrary]) await mkdir(dir, { recursive: true });
  const host = await SessionHost.create(
    { userDataPath: root, resourcesPath: root, appPath: root, packaged: false },
    {
      attachSessionClient: async () => ({ list: async () => ({ sessions: [] }), close: async () => {} }),
      loadProjects: async () => ({
        listProjects: () => (registerProject ? [{ name: 'repo', path: project, addedAt: 1 }] : []),
      }),
      loadWorktrees: async () => ({
        getWorktreeByPath: (path) =>
          entryFor
            ? entryFor({ path, project, worktree })
            : path === worktree
              ? { id: 'fix-login', projectPath: project, path: worktree, state: 'ready' }
              : null,
        ...(containing
          ? {
              findWorktreeContaining: (path) =>
                path === worktree || path.startsWith(`${worktree}${sep}`)
                  ? { id: 'fix-login', projectPath: join(project, 'packages', 'app'), path: worktree, state: 'ready' }
                  : null,
            }
          : {}),
      }),
      loadSessionStore: async () => ({}),
      loadStatuslineSegments: async () => ({}),
      executeCodeGraphTool: async () => ({}),
    }
  );
  t.after(async () => {
    await host.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { host, root, project, worktree, arbitrary };
}

test('a managed worktree of a registered project resolves with the main project identity', async (t) => {
  const { host, project, worktree } = await fixture(t);
  assert.equal(await host.projectDirectory(worktree), worktree);
  const resolved = await host.resolveSessionWorkspace(worktree);
  assert.equal(resolved.registeredProject, project);
  assert.equal(resolved.cwd, worktree);
  assert.deepEqual(resolved.desktopSession, { classification: 'project', projectPath: project });
  assert.equal(await host.knownProjectPath(worktree), project);
  // The registered project itself is unchanged.
  const own = await host.resolveSessionWorkspace(project);
  assert.equal(own.cwd, project);
  assert.deepEqual(own.desktopSession, { classification: 'project', projectPath: project });
});

test('a Project registered in a repository subfolder resolves its session root inside the worktree', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mixdog-host-sub-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { host, project, worktree } = await fixture(t, { containing: true, registerProject: false });
  const sub = join(project, 'packages', 'app');
  const subRoot = join(worktree, 'packages', 'app');
  await mkdir(sub, { recursive: true });
  await mkdir(subRoot, { recursive: true });
  host.projects.knownPath = async (path) => {
    if (path === sub) return sub;
    throw new Error('Project is not available.');
  };
  assert.equal(await host.projectDirectory(subRoot), subRoot);
  const resolved = await host.resolveSessionWorkspace(subRoot);
  assert.equal(resolved.registeredProject, sub);
  assert.equal(resolved.cwd, subRoot);
  assert.deepEqual(resolved.desktopSession, { classification: 'project', projectPath: sub });
  // Outside the worktree nothing is granted.
  await assert.rejects(host.projectDirectory(join(root)), /Project is not available/);
});

test('an arbitrary directory is rejected even when a worktree manager is present', async (t) => {
  const { host, arbitrary } = await fixture(t);
  await assert.rejects(host.projectDirectory(arbitrary), /Project is not available/);
  await assert.rejects(host.resolveSessionWorkspace(arbitrary), /Project is not available/);
  await assert.rejects(host.knownProjectPath(arbitrary), /Project is not available/);
});

test('a managed worktree is rejected when its project is not registered', async (t) => {
  const { host, worktree } = await fixture(t, { registerProject: false });
  await assert.rejects(host.projectDirectory(worktree), /Project is not available/);
  await assert.rejects(host.resolveSessionWorkspace(worktree), /Project is not available/);
});

test('a registry entry for another folder or a non-ready worktree grants nothing', async (t) => {
  const mismatched = await fixture(t, {
    entryFor: ({ project }) => ({ projectPath: project, path: join(project, '..', 'elsewhere'), state: 'ready' }),
  });
  await assert.rejects(mismatched.host.projectDirectory(mismatched.worktree), /Project is not available/);
  const deleting = await fixture(t, {
    entryFor: ({ project, worktree }) => ({ projectPath: project, path: worktree, state: 'deleting' }),
  });
  await assert.rejects(deleting.host.projectDirectory(deleting.worktree), /Project is not available/);
});

test('session-less branch capabilities reach the runtime only for a registered Project', async (t) => {
  const { host, project, worktree, arbitrary } = await fixture(t);
  const forwarded = [];
  host.transport.invokeControlResult = async (method, args) => {
    forwarded.push([method, args]);
    return { value: { ok: true }, snapshot: null };
  };
  host.transport.invokeControl = async (method, args) => {
    forwarded.push([method, args]);
    return { ok: true };
  };
  const nested = join(project, '.', 'x', '..');
  await host.invokeCapability('getProjectBranchMenu', [{ projectPath: nested }]);
  await host.invokeCapability('selectProjectBranch', [{ projectPath: project, branch: 'dev', remote: true }]);
  await host.invokeCapability('mergeProjectBranch', [{ projectPath: nested, branch: 'dev', target: 'main' }]);
  assert.deepEqual(forwarded, [
    ['getProjectBranchMenu', [{ projectPath: project }]],
    ['selectProjectBranch', [{ projectPath: project, branch: 'dev', remote: true }]],
    ['mergeProjectBranch', [{ projectPath: project, branch: 'dev', target: 'main' }]],
  ]);
  // An unregistered folder and a managed worktree (never a Project) are refused here.
  for (const path of [arbitrary, worktree]) {
    for (const [capability, input] of [
      ['selectProjectBranch', { projectPath: path, branch: 'dev' }],
      ['mergeProjectBranch', { projectPath: path, branch: 'dev', target: 'main' }],
    ]) {
      await assert.rejects(host.invokeCapability(capability, [input]), (error) => {
        assert.match(error.message, /^WORKTREE_PROJECT_UNKNOWN: /);
        return true;
      });
    }
  }
  const [read] = await host.readCapabilities([{ capability: 'getProjectBranchMenu', args: [{ projectPath: arbitrary }] }]);
  assert.equal(read.ok, false);
  assert.match(read.error, /WORKTREE_PROJECT_UNKNOWN/);
  assert.equal(forwarded.length, 3, 'nothing else reached the runtime');
});

test('a registered Project whose folder is gone fails the branch menus with a typed error', async (t) => {
  const { host, project } = await fixture(t);
  await rm(project, { recursive: true, force: true });
  const missing = () =>
    Object.assign(new Error('The project folder no longer exists.'), {
      code: 'WORKTREE_PROJECT_UNKNOWN',
      details: { projectPath: project, reason: 'missing' },
    });
  host.transport.invokeControlResult = async () => {
    throw missing();
  };
  host.transport.invokeSession = async () => {
    throw missing();
  };
  const typed = (error) => {
    assert.match(error.message, /^WORKTREE_PROJECT_UNKNOWN: The project folder no longer exists\./);
    assert.match(error.message, /\[worktree-details\] \{"projectPath":.*"reason":"missing"\}/);
    assert.doesNotMatch(error.message, /ENOENT/);
    assert.equal(error.code, 'WORKTREE_PROJECT_UNKNOWN');
    return true;
  };
  // Session-less (the registry still lists it) and session menus alike.
  await assert.rejects(host.invokeCapability('getProjectBranchMenu', [{ projectPath: project }]), typed);
  await assert.rejects(host.invokeCapability('getBranchMenu', [], 's1'), typed);
});

test('open hints carry the worktree cwd under the main project identity', async (t) => {
  const { host, project, worktree } = await fixture(t);
  host.rawSessionRows = [
    { id: 'sess_a', cwd: worktree, workspace: { projectPath: project, cwd: worktree, worktreeId: 'fix-login' } },
  ];
  const hints = host.openHints('sess_a');
  assert.equal(hints.cwd, worktree);
  assert.deepEqual(hints.desktopSession, { classification: 'project', projectPath: project });
});


test('recovery lookup retains a registered missing folder without granting general file access', async (t) => {
  const { host, project, worktree, arbitrary } = await fixture(t);
  await rm(project, { recursive: true });
  await rm(worktree, { recursive: true });
  assert.equal(await host.projectRecoveryDirectory(project), project);
  assert.equal(await host.projectRecoveryDirectory(worktree), worktree);
  await assert.rejects(host.projectDirectory(project));
  await assert.rejects(host.projectDirectory(worktree));
  await assert.rejects(host.projectRecoveryDirectory(arbitrary));
});

test('recovery lookup accepts a deleting managed record but never an unregistered parent', async (t) => {
  const f = await fixture(t, { entryFor: ({ project, worktree }) => ({ projectPath: project, path: worktree, state: 'deleting' }) });
  assert.equal(await f.host.projectRecoveryDirectory(f.worktree), f.worktree);
  await assert.rejects(f.host.projectDirectory(f.worktree));
  await assert.rejects(f.host.projectRecoveryDirectory(f.arbitrary));
  const removed = await fixture(t, { registerProject: false });
  await assert.rejects(removed.host.projectRecoveryDirectory(removed.worktree));
});
