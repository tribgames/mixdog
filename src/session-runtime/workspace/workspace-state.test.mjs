// Durable workspace record outside the transition authority: resume restores a
// worktree-bound session (also for desktop task sessions) and parks a session
// whose worktree vanished in `recovery`; a manual Project selection keeps the
// registered Project while inside the worktree.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createSessionResume, resolveResumeCwd } from '../lifecycle/session-switch/resume.mjs';
import { createContextSwitch } from '../lifecycle/session-switch/context-switch.mjs';
import { createCwdApply } from '../cwd-plugins/cwd-apply.mjs';
import { workspaceCwdLock } from './admission-gate.mjs';
import { restoreWorkspaceAfterResume, workspaceForProjectSelection } from './workspace-state.mjs';

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-workspace-state-'));
  const project = join(root, 'project');
  const worktree = join(root, 'worktrees', 'fix');
  mkdirSync(project, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  return { root, project, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const boundWorkspace = (project, worktree, revision = 2) => ({
  projectPath: project,
  repoCommonDir: join(project, '.git'),
  cwd: worktree,
  worktreeId: 'fix',
  branch: 'mixdog/fix',
  baseCommit: null,
  mergeTarget: 'main',
  revision,
  transition: { state: 'idle', txId: null },
});

function resumeFixture(stored) {
  const calls = [];
  const state = { session: null, cwd: 'C:/host-task-workspace' };
  const api = createSessionResume(
    {
      getSession: () => state.session,
      setSession: (session) => {
        state.session = session;
      },
      getRoute: () => ({ provider: 'p', model: 'm' }),
      setRoute: () => {},
      getConfig: () => ({}),
      getMode: () => 'full',
      getCurrentCwd: () => state.cwd,
      getMcpScopeId: () => null,
      getDesktopSession: () => stored.desktopSession,
      mgr: { resumeSession: async () => stored },
      statusRoutes: null,
      refreshRouteEffort: async () => null,
      invalidateContextStatusCache: () => {},
      invalidatePreSessionToolSurface: () => {},
      applyResolvedCwd: (cwd) => {
        calls.push(['cwd', cwd]);
        state.cwd = cwd;
      },
      resolveRoute: (_config, next) => next,
      applyDeferredToolSurface: () => {},
      getStandaloneTools: () => [],
      beginRoutePreparation: () => {},
      clearRoutePreparation: () => {},
    },
    { ingestSessionIntoMemory: async () => {}, closeSurfaceSession: () => {} }
  );
  return { api, calls, state };
}

test('resume restores a worktree-bound task session into its worktree', async () => {
  const d = dirs();
  try {
    const stored = {
      id: 'sess_resume_ok',
      cwd: d.worktree,
      desktopSession: { classification: 'task', projectPath: null },
      workspace: boundWorkspace(d.project, d.worktree),
    };
    assert.equal(resolveResumeCwd(stored, 'C:/host-task-workspace'), d.worktree, 'task sessions honor the binding');
    const f = resumeFixture(stored);
    const resumed = await f.api.resume('sess_resume_ok');
    assert.equal(resumed.cwd, d.worktree);
    assert.equal(stored.workspace.transition.state, 'idle');
    assert.equal(workspaceCwdLock(['sess_resume_ok']), d.worktree);
  } finally {
    d.cleanup();
  }
});

test('resume of a session whose worktree vanished enters recovery in the project folder', async () => {
  const d = dirs();
  try {
    const missing = join(d.root, 'worktrees', 'gone');
    const stored = {
      id: 'sess_resume_missing',
      cwd: missing,
      desktopSession: { classification: 'project', projectPath: d.project },
      workspace: boundWorkspace(d.project, missing, 5),
    };
    const f = resumeFixture(stored);
    const resumed = await f.api.resume('sess_resume_missing');
    assert.equal(resumed.cwd, d.project, 'never silently runs in the vanished root');
    assert.deepEqual(stored.workspace.transition, { state: 'recovery', txId: 'recovery:fix' });
    assert.equal(stored.workspace.revision, 5);
    assert.equal(stored.workspace.cwd, missing, 'the binding is kept for the recovery choice');
    assert.equal(workspaceCwdLock(['sess_resume_missing']), null);
    // Idempotent on a second restore.
    restoreWorkspaceAfterResume(stored);
    assert.equal(stored.workspace.transition.state, 'recovery');
  } finally {
    d.cleanup();
  }
});

test('a manual Project selection keeps the registered Project inside the worktree and re-roots outside it', () => {
  const d = dirs();
  try {
    const session = { id: 'sess_sel', workspace: boundWorkspace(d.project, d.worktree) };
    const inside = workspaceForProjectSelection(session, join(d.worktree, 'src'));
    assert.equal(inside.workspace, session.workspace);
    assert.equal(inside.projectPath, d.project);
    const outside = workspaceForProjectSelection(session, d.root);
    assert.equal(outside.projectPath, d.root);
    assert.equal(outside.workspace.worktreeId, null);
    assert.equal(outside.workspace.cwd, d.root);
    assert.equal(outside.workspace.revision, 3, 'a switch advances the revision');
    assert.deepEqual(workspaceForProjectSelection({ id: 'x' }, d.root), { workspace: null, projectPath: d.root });

    // Through the cwd tool path: persistProjectSelection never rewrites the
    // desktop projectPath from a worktree cwd.
    let current = d.worktree;
    const live = { ...session, desktopSession: { classification: 'project', projectPath: d.project } };
    let desktop = live.desktopSession;
    const { applyResolvedCwd } = createCwdApply({
      getCurrentCwd: () => current,
      setCurrentCwd: (next) => {
        current = next;
      },
      getSession: () => live,
      getDesktopSession: () => desktop,
      setDesktopSession: (next) => {
        desktop = next;
      },
      isCodeGraphPrewarmLazy: () => true,
      isCodeGraphFirstTurnPrewarmDone: () => false,
      getCodeGraphPrewarmDelayMs: () => 0,
      scheduleCodeGraphPrewarm: () => {},
      hooks: { dispatch: async () => {} },
      hookCommonPayload: (payload) => payload,
      bootProfile: () => {},
      writeLastSessionCwd: () => {},
      updateCurrentCwdOverride: () => {},
      persistSession: () => {},
      isProjectFolder: () => true,
      clean: (value) => String(value || '').trim(),
      resolve,
      statSync,
    });
    applyResolvedCwd(d.worktree, { persistProjectSelection: true });
    assert.deepEqual(desktop, { classification: 'project', projectPath: d.project });
    assert.equal(live.workspace, session.workspace);
    applyResolvedCwd(d.root, { persistProjectSelection: true });
    assert.deepEqual(desktop, { classification: 'project', projectPath: d.root });
    assert.equal(live.workspace.worktreeId, null);
    assert.equal(live.workspace.revision, 3);
  } finally {
    d.cleanup();
  }
});

test('/new and /clear from a worktree-bound Lead start the new session in the Project folder', async () => {
  const d = dirs();
  try {
    for (const [bound, expected] of [
      [true, [d.project]],
      [false, []],
    ]) {
      const state = {
        session: {
          id: 'sess_old',
          cwd: bound ? d.worktree : d.project,
          ...(bound ? { workspace: boundWorkspace(d.project, d.worktree) } : {}),
        },
      };
      const applied = [];
      const { newSession } = createContextSwitch(
        {
          getSession: () => state.session,
          setSession: (next) => {
            state.session = next;
          },
          createCurrentSession: async () => {
            state.session = { id: 'sess_new' };
          },
          invalidateContextStatusCache() {},
          applyResolvedCwd: async (cwd) => applied.push(cwd),
        },
        { ingestSessionIntoMemory() {}, closeSurfaceSession() {}, releaseSessionWork() {} }
      );
      assert.equal(await newSession(), 'sess_new');
      assert.deepEqual(applied, expected);
    }
  } finally {
    d.cleanup();
  }
});
