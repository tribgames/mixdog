import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { DesktopProjectRegistry } from './desktop-project-registry.ts';
import { SessionHost } from './session-host.ts';

async function fixture(t, { registerProject = true, entryFor, containing = false, strict = false, nestedProject = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mixdog-host-worktree-')));
  const project = join(root, 'repo');
  const worktree = join(root, 'data', 'worktrees-v1', '0123456789abcdef', 'fix-login');
  const arbitrary = join(root, 'elsewhere');
  const nested = join(project, 'packages', 'app');
  for (const dir of [project, worktree, arbitrary]) await mkdir(dir, { recursive: true });
  if (nestedProject) await mkdir(nested, { recursive: true });
  const projects = registerProject
    ? [
        { name: 'repo', path: project, addedAt: 1 },
        ...(nestedProject ? [{ name: 'app', path: nested, addedAt: 1 }] : []),
      ]
    : [];
  const host = await SessionHost.create(
    { userDataPath: root, resourcesPath: root, appPath: root, packaged: false },
    {
      attachSessionClient: async () => ({ list: async () => ({ sessions: [] }), close: async () => {} }),
      loadProjects: async () => ({
        listProjects: () => projects,
        ...(strict ? { listProjectsStrict: () => projects } : {}),
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
  return { host, root, project, worktree, arbitrary, nested };
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

test('inheriting a session whose Project is not registered starts the heir in the containing Project, else as a task', async (t) => {
  const { host, root, project, arbitrary } = await fixture(t, { strict: true });
  const subfolder = join(project, 'packages', 'app');
  await mkdir(subfolder, { recursive: true });
  const created = [];
  host.sessionClient.create = async (input) => {
    created.push(input);
    return { sessionId: `sess_heir_${created.length}` };
  };
  host.transport.invokeSession = async () => ({ value: null, snapshot: null, result: {} });
  host.catalog.publishCatalogs = async () => {};
  host.listSessions = async () => [
    { id: 'sess_unregistered', projectPath: arbitrary },
    { id: 'sess_registered', projectPath: project },
    { id: 'sess_subfolder', projectPath: subfolder },
    { id: 'sess_sibling', projectPath: `${project}-sibling` },
  ];
  const taskWorkspace = join(root, 'workspace', 'unclassified');

  const heir = await host.inheritSession('sess_unregistered', null, null);
  assert.equal(heir.sessionId, 'sess_heir_1');
  assert.equal(created[0].cwd, taskWorkspace);
  assert.deepEqual(created[0].desktopSession, { classification: 'task', projectPath: null });

  // A registered Project keeps its identity.
  await host.inheritSession('sess_registered', null, null);
  assert.equal(created[1].cwd, project);
  assert.deepEqual(created[1].desktopSession, { classification: 'project', projectPath: project });

  // A subfolder of a registered Project starts at that Project's root.
  await host.inheritSession('sess_subfolder', null, null);
  assert.equal(created[2].cwd, project);
  assert.deepEqual(created[2].desktopSession, { classification: 'project', projectPath: project });

  // A name-prefix sibling is not inside the Project.
  await host.inheritSession('sess_sibling', null, null);
  assert.equal(created[3].cwd, taskWorkspace);
  assert.deepEqual(created[3].desktopSession, { classification: 'task', projectPath: null });
});

test('inheriting a session the user moved to a Project starts the heir in that Project', async (t) => {
  const { host, root, project, arbitrary } = await fixture(t, { strict: true });
  const created = [];
  host.sessionClient.create = async (input) => {
    created.push(input);
    return { sessionId: `sess_heir_${created.length}` };
  };
  host.transport.invokeSession = async () => ({ value: null, snapshot: null, result: {} });
  host.catalog.publishCatalogs = async () => {};
  host.listSessions = async () => [
    { id: 'sess_moved_in', projectPath: arbitrary, projectAssignment: project },
    { id: 'sess_moved_out', projectPath: project, projectAssignment: '' },
    { id: 'sess_moved_to_removed', projectPath: project, projectAssignment: join(root, 'removed') },
  ];
  const taskWorkspace = join(root, 'workspace', 'unclassified');

  // Moved into a registered Project: the heir starts there.
  await host.inheritSession('sess_moved_in', null, null);
  assert.equal(created[0].cwd, project);
  assert.deepEqual(created[0].desktopSession, { classification: 'project', projectPath: project });

  // Moved out to "no Project": the heir is a task.
  await host.inheritSession('sess_moved_out', null, null);
  assert.equal(created[1].cwd, taskWorkspace);
  assert.deepEqual(created[1].desktopSession, { classification: 'task', projectPath: null });

  // Moved to a Project removed since: the source's own Project applies.
  await host.inheritSession('sess_moved_to_removed', null, null);
  assert.equal(created[2].cwd, project);
  assert.deepEqual(created[2].desktopSession, { classification: 'project', projectPath: project });
});

test('inheritance considers all sidebar paths and selects the deepest registered Project', async (t) => {
  const { host, project, nested, arbitrary, worktree } = await fixture(t, { strict: true, nestedProject: true });
  const cases = [
    [{ projectPath: project, cwd: join(nested, 'src') }, nested],
    [{ projectPath: null, cwd: join(nested, 'src') }, nested],
    [{ projectPath: arbitrary, cwd: worktree, workspace: { projectPath: project, cwd: worktree } }, project],
    [{ projectPath: project, workspace: { projectPath: project, cwd: join(nested, 'src') } }, nested],
    [{ projectPath: project, cwd: nested, projectAssignment: project }, project],
    [{ projectPath: arbitrary, cwd: join(nested, 'src'), projectAssignment: arbitrary }, nested],
  ];
  host.listSessions = async () => cases.map(([row], index) => ({ id: `sess_case_${index}`, ...row }));
  const created = [];
  host.sessionClient.create = async (input) => {
    created.push(input);
    return { sessionId: `sess_heir_${created.length}` };
  };
  host.transport.invokeSession = async () => ({ value: null, snapshot: null, result: {} });
  host.catalog.publishCatalogs = async () => {};
  for (const [index, [, expected]] of cases.entries()) {
    await host.inheritSession(`sess_case_${index}`, null, null);
    assert.equal(created[index].cwd, expected, `case ${index}`);
    assert.deepEqual(created[index].desktopSession, { classification: 'project', projectPath: expected });
  }
});

test('inheritance propagates registry and directory errors without creating a session', async (t) => {
  const { host, project } = await fixture(t, { strict: true });
  let creates = 0;
  host.sessionClient.create = async () => {
    creates += 1;
    return { sessionId: 'sess_unexpected' };
  };
  host.listSessions = async () => [{ id: 'sess_source', projectPath: project }];
  const ioError = Object.assign(new Error('Registry read failed'), { code: 'EIO' });
  host.projects = new DesktopProjectRegistry({
    loadProjectsModule: async () => ({
      listProjects: () => [],
      listProjectsStrict: () => { throw ioError; },
    }),
    userDataRoot: () => project,
  });
  await assert.rejects(host.inheritSession('sess_source'), (error) => error === ioError);
  const directoryCase = await fixture(t, { strict: true });
  directoryCase.host.sessionClient.create = host.sessionClient.create;
  directoryCase.host.listSessions = async () => [{ id: 'sess_source', projectPath: directoryCase.project }];
  await rm(directoryCase.project, { recursive: true });
  await assert.rejects(directoryCase.host.inheritSession('sess_source'), { code: 'ENOENT' });
  assert.equal(creates, 0);
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
