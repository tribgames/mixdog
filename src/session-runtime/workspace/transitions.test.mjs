// The Lead workspace transition authority: lazy worktree provisioning order,
// idempotent retries, cancellation, busy/folder refusals, revision conflicts,
// project-branch moves, removal, worker retargeting and recovery refusal. The
// managed-worktree backend and git facts are stubbed; paths are real temp dirs.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createWorkspaceTransitions, publicWorkspaceMethods } from './transitions.mjs';
import {
  admitTurn,
  beginWorkspaceTransition,
  enterWorkerSpawn,
  holdCheckoutFolder,
  workspaceCwdLock,
} from './admission-gate.mjs';
import { worktreeError } from '../../runtime/shared/worktrees/contract.mjs';
import {
  refreshSessionWorkspaceContext,
  snapshotPendingWorkspaceNotice,
} from '../../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';

const BASE = 'a'.repeat(40);
let counter = 0;

function harness({
  intent,
  sessionMessages = [],
  live = [],
  config = null,
  refresh = null,
  planSetup = null,
  snapshotRetryLimit = 20,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-workspace-'));
  const project = join(root, 'project');
  const worktree = join(root, 'worktrees', 'fix');
  mkdirSync(join(project, '.mixdog'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  counter += 1;
  const projectId = `pid-${process.pid}-${counter}`;
  writeFileSync(join(project, '.mixdog', 'project.id'), projectId);
  const calls = [];
  const sessionId = `sess_ws_${counter}`;
  const state = {
    cwd: project,
    activeTurns: 0,
    workers: [],
    jobs: [],
    shellJobs: 0,
    projectBranch: 'main',
    retained: null,
    setupPending: new Map(),
    setupClaims: [],
  };
  const session = {
    id: sessionId,
    cwd: project,
    desktopSession: { classification: 'project', projectPath: project },
    messages: [{ role: 'system', content: 'rules' }, ...sessionMessages],
  };
  const entry = {
    id: 'fix',
    repoCommonDir: join(project, '.git'),
    projectPath: project,
    path: worktree,
    branch: 'mixdog/fix',
    baseCommit: BASE,
    createdAt: 1,
    ownerSessionId: sessionId,
    state: 'ready',
  };
  const manager = {
    createImpl: null,
    async findWorktreeContaining() {
      return state.retained;
    },
    async resolveBranchWorkspace(input) {
      calls.push(['resolveBranch', input]);
      if (manager.checkoutGate) await manager.checkoutGate;
      const retained = state.retained?.branch === input.branch ? state.retained : null;
      if (retained) {
        if (retained.repoCommonDir !== entry.repoCommonDir) throw worktreeError('WORKTREE_PROJECT_MISMATCH');
        await manager.claimWorktreeOwner(retained.id, { sessionId: input.sessionId });
      }
      const projectInfo = state.inspect?.(input.projectPath);
      const path =
        retained?.path ??
        (input.branch === state.projectBranch
          ? (projectInfo?.topLevel ?? input.projectPath)
          : join(root, 'branches', input.branch));
      mkdirSync(path, { recursive: true });
      return { path, branch: input.branch, entry: retained, repoCommonDir: entry.repoCommonDir };
    },
    async getSessionWorktree(id) {
      calls.push(['getSessionWorktree', id]);
      return state.retained;
    },
    async createManagedWorktree(input) {
      calls.push(['create', input]);
      if (manager.createImpl) return manager.createImpl(input);
      state.retained = entry;
      state.setupPending.set(entry.id, { prepared: null });
      return entry;
    },
    // Stands in for the registry entry's pending first-turn setup.
    async claimWorktreeSetup(id) {
      const pending = state.setupPending.get(id) ?? null;
      if (pending) {
        state.setupPending.delete(id);
        state.setupClaims.push(id);
      }
      return pending;
    },
    async claimWorktreeOwner(id, owner) {
      calls.push(['claim', id, owner.sessionId]);
    },
    async releaseWorktreeOwner(id, owner) {
      calls.push(['release', id, owner.sessionId]);
    },
    async checkoutProjectBranch(input) {
      calls.push(['checkout', input]);
      if (manager.checkoutGate) await manager.checkoutGate;
      if (manager.checkoutImpl) return manager.checkoutImpl(input);
      state.projectBranch = input.branch;
      return { branch: input.branch, changed: true };
    },
    async listBranchOccupancy(input) {
      calls.push(['occupancy', input]);
      return {
        branches: ['main', 'dev'],
        occupancy: [{ branch: state.projectBranch, kind: 'current' }],
        retainedWorktree: state.retained,
      };
    },
    async assertWorktreeRemovable(input) {
      calls.push(['removable', input]);
      if (manager.removableImpl) await manager.removableImpl(input);
    },
    async removeManagedWorktree(input) {
      calls.push(['remove', input]);
      if (manager.removeImpl) return manager.removeImpl(input);
      state.retained = null;
      return { removed: true };
    },
  };
  const api = createWorkspaceTransitions({
    getSession: () => session,
    getCurrentCwd: () => state.cwd,
    getDesktopSession: () => session.desktopSession,
    getConfig: () => config,
    applyResolvedCwd: (cwd, options) => {
      calls.push(['applyCwd', cwd, ...(options ? [options] : [])]);
      state.cwd = cwd;
      session.cwd = cwd;
      // Stands in for cwd-apply's persistProjectSelection.
      if (options?.persistProjectSelection) {
        const desktop = { classification: 'project', projectPath: cwd };
        session.desktopSession = desktop;
        state.rtDesktop = desktop;
      }
    },
    setDesktopSession: (next) => {
      state.rtDesktop = next;
    },
    persistSession: async (target) => {
      calls.push(['persist', target.id, target.workspace?.revision ?? null]);
      if (state.persistFails?.(target)) throw new Error('session save failed');
    },
    refreshWorkspaceContext: async (target, cwd, move) => {
      calls.push(['refresh', target.id, cwd]);
      if (state.refreshGate) await state.refreshGate;
      // Stands in for the prompt rewrite a real refresh performs.
      if (refresh) await refresh(target, cwd, move);
      else target.bp3EnvironmentContext = `- Cwd ${cwd}`;
      if (state.refreshFails?.(target, cwd)) throw new Error('prompt refresh failed');
    },
    invalidateCaches: () => calls.push(['invalidate']),
    getActiveTurnCount: () => state.activeTurns,
    agentStatusState: () => ({ agentWorkers: state.workers, agentJobs: state.jobs }),
    // Stands in for the Lead pool row (lead-workers.json).
    updateLeadWorkerCwd: (id, cwd) => {
      state.leadRows ||= [];
      state.leadRows.push([id, cwd]);
    },
    countOwnShellJobs: async (ids) => {
      calls.push(['shellJobs', ids]);
      return state.shellJobsFor ? state.shellJobsFor(ids) : state.shellJobs;
    },
    listLiveSessions: () => live,
    findRegisteredProject: async (path) => (path === project ? project : null),
    listStoredSessionIds: async () => ['stored-1'],
    sessionManager: { getSessionRuntime: (id) => (id === 'other-active' ? { stage: 'streaming' } : null) },
    initialIntent: intent,
    manager,
    inspectProject: async (path) => {
      calls.push(['inspect', path]);
      return {
        projectPath: path,
        repoCommonDir: join(project, '.git'),
        headCommit: BASE,
        currentBranch: state.projectBranch,
        ...(state.inspect?.(path) ?? {}),
      };
    },
    newTxId: () => {
      counter += 1;
      return `tx-${counter}`;
    },
    ...(planSetup ? { planWorktreeSetup: planSetup } : {}),
    snapshotRetryMs: 5,
    snapshotRetryLimit,
  });
  const names = () => calls.map((call) => call[0]);
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { api, calls, names, state, session, entry, manager, project, worktree, projectId, cleanup };
}

test('a worktree task provisions on its first turn: base branch → create → project id → transition → refresh', async () => {
  const h = harness({ intent: { mode: 'worktree', name: 'fix' } });
  try {
    const result = await h.api.prepareTurnWorkspace({
      submissionId: 'sub-1',
      prompt: 'Fix the login page',
      signal: new AbortController().signal,
    });
    const order = h.names();
    assert.deepEqual(
      order.filter((name) => ['inspect', 'create', 'applyCwd', 'refresh', 'persist'].includes(name)),
      ['inspect', 'create', 'applyCwd', 'refresh', 'persist']
    );
    const create = h.calls.find((call) => call[0] === 'create')[1];
    assert.equal(create.txId, 'sub-1', 'the submission id is the provisioning transaction');
    assert.equal(create.baseBranch, 'main', 'the worktree branches from the project folder branch');
    assert.equal(create.nameHint, 'fix', 'an explicit name wins over the first message');
    assert.equal(create.confirmLarge, false);
    assert.equal(create.sessionId, h.session.id);
    assert.equal(
      readFileSync(join(h.worktree, '.mixdog', 'project.id'), 'utf8').trim(),
      h.projectId,
      'the worktree resolves the same project memory'
    );
    assert.deepEqual(result.workspace, {
      projectPath: h.project,
      repoCommonDir: join(h.project, '.git'),
      cwd: h.worktree,
      worktreeId: 'fix',
      branch: 'mixdog/fix',
      baseCommit: BASE,
      mergeTarget: 'main',
      revision: 1,
      transition: { state: 'idle', txId: null },
    });
    assert.equal(result.revision, 1);
    assert.equal(h.session.workspace, result.workspace);
    assert.equal(h.session.cwd, h.worktree);
    assert.equal(h.session.desktopSession.projectPath, h.project, 'project identity stays the registered Project');
    assert.equal(workspaceCwdLock([h.session.id]), h.worktree, 'workers are locked to the worktree');
    assert.equal(await h.api.prepareTurnWorkspace({ submissionId: 'sub-2' }), null, 'the intent is consumed once');
  } finally {
    h.cleanup();
  }
});

test('a refused provisioning keeps the workspace, and the retry reuses the reserved transaction id', async () => {
  const h = harness({ intent: { mode: 'worktree', name: null } });
  try {
    h.manager.createImpl = async () => {
      throw worktreeError('WORKTREE_LARGE_REPO_CONFIRM', undefined, { bytes: 5 });
    };
    await assert.rejects(h.api.prepareTurnWorkspace({ submissionId: 'sub-1', prompt: 'Add dark mode' }), {
      code: 'WORKTREE_LARGE_REPO_CONFIRM',
    });
    assert.equal(h.calls.find((call) => call[0] === 'create')[1].nameHint, 'Add dark mode');
    assert.equal(h.session.workspace, undefined, 'the previous workspace is left intact');
    assert.equal(h.state.cwd, h.project);
    h.manager.createImpl = null;
    const pending = await h.api.requestWorktree({ confirmLarge: true });
    assert.equal(pending.pending, true);
    const result = await h.api.prepareTurnWorkspace({ submissionId: 'sub-resend' });
    const creates = h.calls.filter((call) => call[0] === 'create').map((call) => call[1]);
    assert.deepEqual(
      creates.map((input) => [input.txId, input.confirmLarge]),
      [
        ['sub-1', false],
        ['sub-1', true],
      ]
    );
    assert.equal(result.workspace.worktreeId, 'fix');
  } finally {
    h.cleanup();
  }
});

test('cancellation during provisioning never moves the session; the created worktree is reused', async () => {
  const h = harness({ intent: { mode: 'worktree' } });
  try {
    const controller = new AbortController();
    h.manager.createImpl = async () => {
      h.state.retained = h.entry;
      controller.abort(new Error('Turn aborted'));
      return h.entry;
    };
    await assert.rejects(h.api.prepareTurnWorkspace({ submissionId: 'sub-1', signal: controller.signal }), /aborted/);
    assert.equal(h.session.workspace, undefined);
    assert.equal(h.state.cwd, h.project);
    assert.equal(h.names().includes('applyCwd'), false);
    const result = await h.api.prepareTurnWorkspace({ submissionId: 'sub-2' });
    assert.equal(h.calls.filter((call) => call[0] === 'create').length, 1, 'no second worktree');
    assert.deepEqual(h.calls.filter((call) => call[0] === 'claim').at(-1), ['claim', 'fix', h.session.id]);
    assert.equal(result.workspace.cwd, h.worktree);
  } finally {
    h.cleanup();
  }
});

test('a creation intent never applies to a resumed conversation, and the settings default skips non-repos', async () => {
  const resumed = harness({
    intent: { mode: 'worktree' },
    sessionMessages: [{ role: 'user', content: 'earlier question' }],
  });
  try {
    assert.equal(await resumed.api.prepareTurnWorkspace({ submissionId: 's' }), null);
    assert.equal(resumed.names().includes('create'), false);
  } finally {
    resumed.cleanup();
  }
  const defaulted = harness({ intent: { mode: 'default' }, config: { worktree: { newTaskDefault: 'worktree' } } });
  try {
    defaulted.manager.createImpl = async () => {
      throw worktreeError('WORKTREE_UNSUPPORTED_REPO');
    };
    assert.equal(await defaulted.api.prepareTurnWorkspace({ submissionId: 's' }), null);
    assert.equal(defaulted.names().includes('create'), true, 'the default was attempted');
    assert.equal(defaulted.session.workspace, undefined);
  } finally {
    defaulted.cleanup();
  }
});

test('the worktree default applies only to an interactive Lead start, never to sessions created without intent', async () => {
  const config = { worktree: { newTaskDefault: 'worktree' } };
  const interactive = harness({ intent: { mode: 'default' }, config });
  try {
    const result = await interactive.api.prepareTurnWorkspace({ submissionId: 'sub-1', prompt: 'Fix it' });
    assert.equal(result.workspace.worktreeId, 'fix');
  } finally {
    interactive.cleanup();
  }
  // Agents, schedules, webhooks and desktop tasks create their runtime with
  // no intent (desktop drafts send their own choice), and `branch` declines.
  for (const intent of [undefined, null, { mode: 'branch' }]) {
    const other = harness({ intent, config });
    try {
      assert.equal(await other.api.prepareTurnWorkspace({ submissionId: 'sub-1', prompt: 'Fix it' }), null);
      assert.equal(other.names().includes('create'), false);
    } finally {
      other.cleanup();
    }
  }
});

test('a New Task provisions its requested worktree before the first prompt is sent', async () => {
  const h = harness();
  try {
    h.manager.createImpl = async () => {
      throw worktreeError('WORKTREE_LARGE_REPO_CONFIRM', undefined, { estimateBytes: 5 });
    };
    await assert.rejects(h.api.requestWorktree({ provision: true, prompt: 'Add dark mode', txId: 'sub-1' }), {
      code: 'WORKTREE_LARGE_REPO_CONFIRM',
    });
    assert.equal(h.session.workspace, undefined, 'a refused provisioning leaves the session in the project folder');
    h.manager.createImpl = null;
    const result = await h.api.requestWorktree({
      provision: true,
      confirmLarge: true,
      prompt: 'Add dark mode',
      txId: 'sub-1',
    });
    assert.equal(result.pending, false);
    assert.equal(result.workspace.cwd, h.worktree);
    const creates = h.calls.filter((call) => call[0] === 'create').map((call) => call[1]);
    assert.deepEqual(
      creates.map((input) => [input.txId, input.confirmLarge, input.nameHint]),
      [
        ['sub-1', false, 'Add dark mode'],
        ['sub-1', true, 'Add dark mode'],
      ]
    );
    assert.equal(await h.api.prepareTurnWorkspace({ submissionId: 'sub-1' }), null, 'the first turn finds it bound');
  } finally {
    h.cleanup();
  }
});

test('moving a live session: the uncommitted-changes choice reaches the backend and the notice', async () => {
  const other = { id: 'other-active', owner: 'user', cwd: null };
  const h = harness({ live: [other] });
  try {
    const create = h.manager.createManagedWorktree;
    h.manager.createManagedWorktree = async (input) => {
      if (input.carryChanges === 'ask') {
        h.calls.push(['create', input]);
        throw worktreeError('WORKTREE_DIRTY_CHOICE', undefined, { count: 3 });
      }
      const entry = await create(input);
      return { ...entry, changes: { mode: input.carryChanges === 'carry' ? 'carried' : 'left', count: 3 } };
    };
    await assert.rejects(h.api.requestWorktree({ provision: true }), (error) => {
      assert.equal(error.code, 'WORKTREE_DIRTY_CHOICE');
      assert.deepEqual(error.details, { count: 3 });
      return true;
    });
    assert.equal(h.session.workspace, undefined, 'nothing moved');
    assert.equal(await h.api.prepareTurnWorkspace({ submissionId: 'next' }), null, 'a refused move is not re-armed');
    await assert.rejects(h.api.requestWorktree({ provision: true, carryChanges: 'stash' }), TypeError);

    // Busy: the Lead's own turn refuses before anything is examined.
    h.state.activeTurns = 1;
    await assert.rejects(h.api.requestWorktree({ provision: true, carryChanges: 'carry' }), {
      code: 'WORKTREE_BUSY_JOBS',
    });
    h.state.activeTurns = 0;
    // `carry` needs the project folder to itself; `leave` does not.
    other.cwd = h.project;
    await assert.rejects(h.api.requestWorktree({ provision: true, carryChanges: 'carry' }), (error) => {
      assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
      assert.equal(error.details.reason, 'folder-in-use');
      return true;
    });
    assert.deepEqual(
      h.calls.filter((call) => call[0] === 'create').map((call) => call[1].carryChanges),
      ['ask'],
      'busy refusals never reach the backend'
    );
    const left = await h.api.requestWorktree({ provision: true, carryChanges: 'leave' });
    assert.equal(left.pending, false);
    assert.equal(left.workspace.cwd, h.worktree);
    assert.deepEqual(left.changes, { mode: 'left', count: 3 });
    assert.equal(h.calls.filter((call) => call[0] === 'create').at(-1)[1].carryChanges, 'leave');
  } finally {
    h.cleanup();
  }
});

test('a carried move holds the project folder and tells the model where its changes and paths went', async () => {
  const h = harness({
    sessionMessages: [
      { role: 'user', content: 'edit src/app.js' },
      { role: 'assistant', content: 'done' },
    ],
    refresh: async (target, cwd, move) => refreshSessionWorkspaceContext(target, { cwd, ...(move ? { move } : {}) }),
  });
  try {
    const systemBefore = JSON.stringify(h.session.messages.filter((message) => message.role === 'system'));
    h.manager.createManagedWorktree = async (input) => {
      h.calls.push(['create', input]);
      // The project folder is held while the changes move: another Lead's checkout cannot start.
      assert.throws(() => holdCheckoutFolder('other-lead', h.project), { code: 'WORKTREE_BUSY_JOBS' });
      h.state.retained = h.entry;
      return { ...h.entry, changes: { mode: 'carried', count: 2 } };
    };
    const result = await h.api.requestWorktree({ provision: true, carryChanges: 'carry' });
    assert.equal(h.calls.find((call) => call[0] === 'create')[1].carryChanges, 'carry');
    assert.deepEqual(result.changes, { mode: 'carried', count: 2 });
    assert.equal(h.session.cwd, h.worktree);
    holdCheckoutFolder('other-lead', h.project)();
    assert.equal(
      JSON.stringify(h.session.messages.filter((message) => message.role === 'system')),
      systemBefore,
      'the system prompt is untouched'
    );
    const notice = snapshotPendingWorkspaceNotice(h.session).content;
    assert.match(notice, /\nUncommitted changes were moved into the worktree; ignored files/);
    assert.ok(notice.includes(`substitute ${h.worktree} for the project root ${h.project}`));
  } finally {
    h.cleanup();
  }
});

test('a never-moved session menu names its repository, and a detached checkout shows its commit', async () => {
  const h = harness();
  try {
    const onBranch = await h.api.getBranchMenu();
    assert.equal(onBranch.workspace.repoCommonDir, join(h.project, '.git'));
    assert.equal(onBranch.workspace.branch, 'main');
    assert.equal(onBranch.workspace.baseCommit, null);
    h.state.projectBranch = null;
    const detached = await h.api.getBranchMenu();
    assert.equal(detached.workspace.repoCommonDir, join(h.project, '.git'));
    assert.equal(detached.workspace.branch, null);
    assert.equal(detached.workspace.baseCommit, BASE);
  } finally {
    h.cleanup();
  }
});

test('a carry keeps its recovery ref until the move is committed, and a later failure puts the changes back', async () => {
  const h = harness();
  try {
    const carried = [];
    h.manager.createManagedWorktree = async (input) => {
      h.calls.push(['create', input]);
      h.state.retained = h.entry;
      return { ...h.entry, changes: { mode: 'carried', count: 2, recoveryRef: 'refs/mixdog/carry/fix-1' } };
    };
    h.manager.restoreCarriedChanges = async (input) => carried.push(['restore', input.recoveryRef]);
    h.manager.dropCarryRecoveryRef = async (input) => carried.push(['drop', input.recoveryRef]);
    h.state.refreshFails = (target) => target.id === h.session.id;
    await assert.rejects(h.api.requestWorktree({ provision: true, carryChanges: 'carry' }), /prompt refresh failed/);
    assert.equal(h.session.cwd, h.project, 'the session stays in the project folder');
    assert.deepEqual(carried, [
      ['restore', 'refs/mixdog/carry/fix-1'],
      ['drop', 'refs/mixdog/carry/fix-1'],
    ]);
    assert.deepEqual(h.calls.find((call) => call[0] === 'remove')[1], { entryId: 'fix', force: true });

    carried.length = 0;
    h.state.refreshFails = null;
    const moved = await h.api.requestWorktree({ provision: true, carryChanges: 'carry' });
    assert.deepEqual(moved.changes, { mode: 'carried', count: 2 }, 'the ref is internal');
    assert.deepEqual(carried, [['drop', 'refs/mixdog/carry/fix-1']], 'dropped only after the committed move');
  } finally {
    h.cleanup();
  }
});

test('a failed save of the move fails it: the recovery ref stays until the old state is back', async () => {
  const h = harness();
  try {
    const carried = [];
    h.manager.createManagedWorktree = async (input) => {
      h.calls.push(['create', input]);
      h.state.retained = h.entry;
      return { ...h.entry, changes: { mode: 'carried', count: 2, recoveryRef: 'refs/mixdog/carry/fix-1' } };
    };
    let restoreFails = true;
    h.manager.restoreCarriedChanges = async (input) => {
      carried.push(['restore', input.recoveryRef]);
      if (restoreFails) throw new Error('restore refused');
    };
    h.manager.dropCarryRecoveryRef = async (input) => carried.push(['drop', input.recoveryRef]);
    // Only the save of the moved session fails; the rollback save lands.
    h.state.persistFails = (target) => target.id === h.session.id && target.workspace?.worktreeId === 'fix';

    await assert.rejects(h.api.requestWorktree({ provision: true, carryChanges: 'carry' }), /session save failed/);
    assert.equal(h.session.cwd, h.project, 'the session is back in the project folder');
    assert.equal(h.state.cwd, h.project);
    assert.equal(h.session.workspace, undefined, 'the previous (never-moved) workspace is authoritative');
    assert.deepEqual(carried, [['restore', 'refs/mixdog/carry/fix-1']], 'a refused restore keeps the recovery ref');
    assert.ok(!h.calls.some((call) => call[0] === 'remove'), 'and the worktree holding the changes');
    // The rollback save carries the previous workspace (revision 0) again.
    assert.deepEqual(h.calls.filter((call) => call[0] === 'persist').at(-1), ['persist', h.session.id, 0]);

    carried.length = 0;
    restoreFails = false;
    h.state.retained = null; // a fresh carry (the kept worktree would be re-entered instead)
    await assert.rejects(h.api.requestWorktree({ provision: true, carryChanges: 'carry' }), /session save failed/);
    assert.deepEqual(
      carried,
      [
        ['restore', 'refs/mixdog/carry/fix-1'],
        ['drop', 'refs/mixdog/carry/fix-1'],
      ],
      'the ref is dropped only once the changes are back'
    );
    assert.equal(h.session.cwd, h.project);
  } finally {
    h.cleanup();
  }
});

test('a failed worker save fails the move and every root goes back', async () => {
  const worker = { id: 'worker-1', owner: 'agent', ownerSessionId: null, cwd: null, messages: [] };
  const h = harness({ live: [worker] });
  try {
    worker.ownerSessionId = h.session.id;
    worker.cwd = h.project;
    h.state.persistFails = (target) => target.id === worker.id && target.cwd === h.worktree;
    await assert.rejects(h.api.requestWorktree({ provision: true }), /session save failed/);
    assert.equal(worker.cwd, h.project, 'the worker is back in the project folder');
    assert.equal(h.session.cwd, h.project);
    const persisted = h.calls.filter((call) => call[0] === 'persist');
    assert.equal(persisted.filter((call) => call[1] === worker.id).length, 2, 'the worker rollback is saved');
    assert.deepEqual(persisted.at(-1), ['persist', h.session.id, 0], 'and the Lead rollback, awaited');
  } finally {
    h.cleanup();
  }
});

test('a session that leaves its new worktree before the first turn never runs its setup elsewhere', async () => {
  const plans = [];
  const h = harness({
    planSetup: async (input) => {
      plans.push(input.worktreeDir);
      return { notes: [], commands: [] };
    },
  });
  try {
    await h.api.requestWorktree({ provision: true, prompt: 'Fix it' });
    assert.equal(h.session.cwd, h.worktree);
    await h.api.selectBranch({ branch: 'main' });
    assert.equal(h.session.cwd, h.project, 'back on the project-folder branch');

    await h.api.prepareTurnWorkspace({ submissionId: 'turn-1', prompt: 'go' });
    assert.deepEqual(plans, [], 'no setup runs in the project folder');
    assert.equal(h.session.pendingSetupNotice, undefined);

    await h.api.requestWorktree();
    assert.equal(h.session.cwd, h.worktree, 're-entered the retained worktree');
    await h.api.prepareTurnWorkspace({ submissionId: 'turn-2', prompt: 'again' });
    assert.deepEqual(plans, [h.worktree], 'the deferred setup runs once the session is back in it');
    await h.api.prepareTurnWorkspace({ submissionId: 'turn-3', prompt: 'more' });
    assert.equal(plans.length, 1, 'once');
  } finally {
    h.cleanup();
  }
});

test('a branch switch that creates a managed worktree schedules its setup for the next turn', async () => {
  const plans = [];
  const h = harness({
    planSetup: async (input) => {
      plans.push([input.worktreeDir, input.mainDir]);
      return { notes: ['prepared'], commands: [] };
    },
  });
  try {
    const original = h.manager.resolveBranchWorkspace;
    h.manager.resolveBranchWorkspace = async (input) => {
      const resolved = await original(input);
      h.state.setupPending.set('branch-wt', { prepared: null });
      return {
        ...resolved,
        entry: { ...h.entry, id: 'branch-wt', path: resolved.path, branch: input.branch },
        created: true,
      };
    };
    const moved = await h.api.selectBranch({ branch: 'feature/new', create: true });
    assert.equal(moved.created, undefined, 'internal metadata is not part of the result');
    assert.deepEqual(plans, []);
    await h.api.prepareTurnWorkspace({ submissionId: 'turn-1', prompt: 'go' });
    assert.deepEqual(plans, [[h.session.cwd, h.project]]);
    assert.ok(h.session.pendingSetupNotice, 'the preparation notice is queued');
  } finally {
    h.cleanup();
  }
});

test('a carry refuses while another session in the project folder owns a background shell, even idle', async () => {
  const idle = { id: 'other-idle', owner: 'user', cwd: null };
  const h = harness({ live: [idle] });
  try {
    idle.cwd = h.project;
    h.state.shellJobs = 1;
    await assert.rejects(h.api.requestWorktree({ provision: true, carryChanges: 'carry' }), (error) => {
      // The Lead's own shells are counted first (assertLeadIdle); with them
      // quiet, the idle session's shell still refuses the carry.
      assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
      return true;
    });
    h.state.shellJobs = 0;
    const counted = [];
    const api = h.api;
    h.calls.length = 0;
    // Only the project-folder sharers' shells are running now.
    const shellJobsFor = (ids) => (ids.includes('other-idle') ? 1 : 0);
    h.state.shellJobsFor = shellJobsFor;
    await assert.rejects(api.requestWorktree({ provision: true, carryChanges: 'carry' }), (error) => {
      assert.equal(error.details.reason, 'folder-shell-jobs');
      counted.push(error.details.shellJobs);
      return true;
    });
    assert.deepEqual(counted, [1]);
    assert.equal(h.names().includes('create'), false);
    const left = await api.requestWorktree({ provision: true, carryChanges: 'leave' });
    assert.equal(left.workspace.cwd, h.worktree, '`leave` never clears the folder, so it is allowed');
  } finally {
    h.cleanup();
  }
});

test('a Project in a repository subfolder runs in the same subfolder of its worktree and back', async () => {
  const h = harness();
  try {
    const repoRoot = join(h.project, '..', 'repo-root');
    mkdirSync(join(repoRoot, 'packages'), { recursive: true });
    const sub = join(repoRoot, 'packages', 'app');
    mkdirSync(join(sub, '.mixdog'), { recursive: true });
    writeFileSync(join(sub, '.mixdog', 'project.id'), h.projectId);
    h.session.desktopSession = { classification: 'project', projectPath: sub };
    h.session.cwd = sub;
    h.state.cwd = sub;
    h.state.inspect = (path) => ({ projectPath: path, topLevel: repoRoot });
    const entered = await h.api.requestWorktree({ provision: true, prompt: 'Fix', txId: 'sub-1' });
    assert.equal(entered.workspace.cwd, join(h.worktree, 'packages', 'app'));
    assert.equal(entered.workspace.projectPath, sub);
    assert.equal(
      readFileSync(join(h.worktree, 'packages', 'app', '.mixdog', 'project.id'), 'utf8').trim(),
      h.projectId,
      'the subfolder identity is carried to the same subfolder'
    );
    const back = await h.api.selectBranch({ branch: 'main' });
    assert.equal(back.workspace.cwd, sub);
  } finally {
    h.cleanup();
  }
});

test('busy refusal: a running turn, workers, background shells or another transition block a branch change', async () => {
  const h = harness();
  try {
    h.state.activeTurns = 1;
    await assert.rejects(h.api.selectBranch({ branch: 'dev' }), (error) => {
      assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
      assert.equal(error.details.reason, 'turn');
      return true;
    });
    h.state.activeTurns = 0;
    h.state.workers = [{ sessionId: 'w1', status: 'starting' }];
    await assert.rejects(h.api.selectBranch({ branch: 'dev' }), (error) => error.details.reason === 'workers');
    h.state.workers = [{ sessionId: 'w1', status: 'idle' }];
    h.state.jobs = [{ status: 'running' }];
    await assert.rejects(h.api.selectBranch({ branch: 'dev' }), (error) => error.details.reason === 'workers');
    h.state.jobs = [{ status: 'completed' }];
    h.state.shellJobs = 1;
    await assert.rejects(h.api.selectBranch({ branch: 'dev' }), (error) => error.details.reason === 'shell-jobs');
    assert.deepEqual(
      h.calls
        .filter((call) => call[0] === 'shellJobs')
        .at(-1)[1]
        .sort(),
      [h.session.id, 'w1'].sort()
    );
    h.state.shellJobs = 0;
    assert.equal(h.names().includes('checkout'), false, 'nothing ran while busy');
    assert.equal(h.session.workspace, undefined, 'a refused change leaves the workspace intact');

    // Another transition in flight, and the spawn gate it shares.
    let release;
    h.manager.checkoutGate = new Promise((resolve) => {
      release = resolve;
    });
    const first = h.api.selectBranch({ branch: 'dev' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.session.workspace.transition.state, 'switching', 'the in-flight marker is published');
    await assert.rejects(h.api.selectBranch({ branch: 'other' }), (error) => error.details.reason === 'transition');
    assert.throws(() => enterWorkerSpawn([h.session.id]), { code: 'WORKTREE_BUSY_JOBS' });
    release();
    const done = await first;
    assert.equal(done.workspace.branch, 'dev');
    assert.equal(done.workspace.transition.state, 'idle');
    const leaveSpawn = enterWorkerSpawn([h.session.id]);
    await assert.rejects(h.api.selectBranch({ branch: 'main' }), (error) => error.details.reason === 'workers');
    leaveSpawn();
  } finally {
    h.cleanup();
  }
});

test('a detached checkout of the project folder refuses while another session works there', async () => {
  const other = { id: 'other-active', owner: 'user', cwd: null };
  const h = harness({ live: [other] });
  try {
    other.cwd = h.project;
    await assert.rejects(h.api.selectProjectBranch({ projectPath: h.project, detach: BASE }), (error) => {
      assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
      assert.equal(error.details.reason, 'folder-in-use');
      return true;
    });
    assert.equal(h.names().includes('checkout'), false);
  } finally {
    h.cleanup();
  }
});

test('selecting another branch moves only this session while other sessions work in the project folder', async () => {
  const live = [];
  const h = harness({ live });
  try {
    live.push(
      { id: 'other-active', cwd: join(h.project, 'src'), owner: 'user' },
      { id: 'other-idle', cwd: h.project, owner: 'user' }
    );
    const moved = await h.api.selectBranch({ branch: 'dev' });
    assert.notEqual(moved.workspace.cwd, h.project);
    assert.equal(h.state.projectBranch, 'main');
    assert.equal(h.names().includes('checkout'), false);
    // The checked-out branch itself needs no checkout, so others are unaffected.
    const same = await h.api.selectBranch({ branch: 'main' });
    assert.equal(h.names().includes('checkout'), false);
    assert.equal(same.revision, 2);
  } finally {
    h.cleanup();
  }
});

test('expectedRevision mismatch is a revision conflict', async () => {
  const h = harness();
  try {
    await assert.rejects(h.api.selectBranch({ branch: 'dev', expectedRevision: 4 }), (error) => {
      assert.equal(error.code, 'WORKTREE_REVISION_CONFLICT');
      assert.deepEqual(error.details, { expectedRevision: 4, revision: 0 });
      return true;
    });
    const moved = await h.api.selectBranch({ branch: 'dev', expectedRevision: 0 });
    assert.equal(moved.revision, 1);
    await assert.rejects(
      h.api.applyWorkspaceTransition(
        { sessionId: h.session.id },
        { kind: 'branch', branch: 'main' },
        {
          expectedRevision: 0,
        }
      ),
      { code: 'WORKTREE_REVISION_CONFLICT' }
    );
  } finally {
    h.cleanup();
  }
});

test('requestWorktree, mergeWorkspace and removeWorktree enforce expectedRevision', async () => {
  const h = harness();
  const conflict = (expectedRevision, revision) => (error) => {
    assert.equal(error.code, 'WORKTREE_REVISION_CONFLICT');
    assert.deepEqual(error.details, { expectedRevision, revision });
    return true;
  };
  try {
    // A stale request arms nothing; the current revision arms the intent.
    await assert.rejects(h.api.requestWorktree({ expectedRevision: 2 }), conflict(2, 0));
    assert.equal((await h.api.getBranchMenu()).pendingWorktree, null);
    assert.equal((await h.api.requestWorktree({ expectedRevision: 0 })).pending, true);
    await assert.rejects(h.api.requestWorktree({ expectedRevision: -1 }), TypeError);

    // Re-entering the retained worktree checks the revision too.
    h.state.retained = h.entry;
    const back = await h.api.selectBranch({ branch: 'main' });
    assert.equal(back.revision, 1);
    await assert.rejects(h.api.requestWorktree({ expectedRevision: 0 }), conflict(0, 1));
    assert.equal(h.session.cwd, h.project);
    const entered = await h.api.requestWorktree({ expectedRevision: 1 });
    assert.equal(entered.revision, 2);
    assert.equal(h.session.cwd, h.worktree);

    // A stale merge never reaches git.
    await assert.rejects(
      h.api.mergeWorkspace({ confirmed: true, target: 'main', expectedRevision: 1 }),
      conflict(1, 2)
    );
    assert.equal(h.names().includes('merge'), false);

    // A stale removal leaves the worktree, the cwd and the record untouched.
    await assert.rejects(h.api.removeWorktree({ expectedRevision: 1 }), conflict(1, 2));
    assert.equal(h.names().includes('removable'), false);
    assert.equal(h.names().includes('remove'), false);
    assert.equal(h.session.cwd, h.worktree);
    assert.equal(h.session.workspace.revision, 2);
    const removed = await h.api.removeWorktree({ expectedRevision: 2 });
    assert.equal(removed.revision, 3);
    assert.equal(h.session.cwd, h.project);
  } finally {
    h.cleanup();
  }
});

test('project branches return to the project folder, the retained worktree branch re-enters it', async () => {
  const h = harness();
  try {
    h.state.retained = h.entry;
    const entered = await h.api.selectBranch({ branch: 'mixdog/fix' });
    assert.equal(entered.workspace.cwd, h.worktree);
    assert.deepEqual(
      h.calls.filter((call) => call[0] === 'claim'),
      [['claim', 'fix', h.session.id]]
    );
    assert.equal(h.names().includes('create'), false);

    const back = await h.api.selectBranch({ branch: 'main' });
    assert.equal(back.workspace.cwd, h.project);
    assert.equal(back.workspace.worktreeId, null);
    assert.equal(back.workspace.branch, 'main');
    assert.equal(back.revision, entered.revision + 1);
    assert.equal(h.names().includes('checkout'), false, 'same branch: no checkout');
    assert.deepEqual(
      h.calls.filter((call) => call[0] === 'release'),
      [['release', 'fix', h.session.id]]
    );
    assert.equal(h.state.retained, h.entry, 'the worktree stays retained');
    assert.equal(workspaceCwdLock([h.session.id]), null);

    const created = await h.api.selectBranch({ branch: 'feature/x', create: true });
    assert.equal(h.calls.find((call) => call[0] === 'resolveBranch' && call[1].branch === 'feature/x')[1].create, true);
    assert.equal(h.names().includes('checkout'), false);
    assert.equal(created.workspace.branch, 'feature/x');

    const menu = await h.api.getBranchMenu();
    assert.equal(menu.workspace.cwd, h.session.workspace.cwd);
    assert.equal(h.state.projectBranch, 'main');
    assert.equal(menu.retainedWorktree, h.entry);
    assert.deepEqual(h.calls.find((call) => call[0] === 'occupancy')[1], {
      projectPath: h.project,
      sessionId: h.session.id,
    });
  } finally {
    h.cleanup();
  }
});

test('removing a bound worktree returns to the project folder first, then removes it', async () => {
  const h = harness();
  try {
    h.state.retained = h.entry;
    await h.api.requestWorktree();
    assert.equal(h.session.cwd, h.worktree);
    const removed = await h.api.removeWorktree({ force: true });
    const order = h.names();
    assert.ok(order.lastIndexOf('applyCwd') < order.indexOf('remove'));
    assert.equal(removed.workspace.cwd, h.project);
    assert.equal(removed.workspace.worktreeId, null);
    assert.deepEqual(removed.removed, { removed: true });
    assert.deepEqual(h.calls.find((call) => call[0] === 'remove')[1], {
      entryId: 'fix',
      force: true,
      sessionId: h.session.id,
    });
  } finally {
    h.cleanup();
  }
});

test("every transition moves the Lead's pool row (enter, return, remove), and a rollback moves it back", async () => {
  const h = harness();
  try {
    h.state.retained = h.entry;
    await h.api.requestWorktree();
    await h.api.selectBranch({ branch: 'main' });
    await h.api.selectBranch({ branch: 'mixdog/fix' });
    await h.api.removeWorktree({ force: true });
    const id = h.session.id;
    assert.deepEqual(h.state.leadRows, [
      [id, h.worktree],
      [id, h.project],
      [id, h.worktree],
      [id, h.project],
    ]);
    // A failed transition puts the row back where the session really is.
    h.state.leadRows = [];
    h.state.retained = h.entry;
    await h.api.requestWorktree();
    h.manager.removeImpl = async () => {
      throw new Error('EBUSY: worktree locked');
    };
    await assert.rejects(h.api.removeWorktree({ force: true }), /EBUSY/);
    assert.deepEqual(h.state.leadRows, [
      [id, h.worktree],
      [id, h.project],
      [id, h.worktree],
    ]);
    assert.equal(h.session.cwd, h.worktree);
  } finally {
    h.cleanup();
  }
});

test('merge needs confirmation and refuses while busy', async () => {
  const h = harness();
  try {
    h.state.retained = h.entry;
    await assert.rejects(h.api.mergeWorkspace({ target: 'main' }), { code: 'WORKTREE_CONFIRM_REQUIRED' });
    h.state.activeTurns = 1;
    await assert.rejects(h.api.mergeWorkspace({ confirmed: true, target: 'main' }), { code: 'WORKTREE_BUSY_JOBS' });
  } finally {
    h.cleanup();
  }
});

test('a retained worktree of another Project or repository is never merged into this one', async () => {
  const h = harness();
  try {
    // Same repository, another Project folder (a Project switch left it behind).
    h.state.retained = { ...h.entry, projectPath: join(h.project, '..', 'other-checkout') };
    await assert.rejects(h.api.mergeWorkspace({ confirmed: true, target: 'main' }), {
      code: 'WORKTREE_PROJECT_MISMATCH',
    });
    // Another repository altogether.
    h.state.retained = { ...h.entry, repoCommonDir: join(h.project, '..', 'elsewhere', '.git') };
    await assert.rejects(h.api.mergeWorkspace({ confirmed: true, target: 'main' }), {
      code: 'WORKTREE_PROJECT_MISMATCH',
    });
    assert.equal(h.names().includes('merge'), false, 'nothing was merged');
  } finally {
    h.cleanup();
  }
});

test('a partly failed removal is WORKTREE_REMOVAL_INCOMPLETE: the session stays in the project folder and a retry finishes', async () => {
  const h = harness();
  try {
    h.state.retained = h.entry;
    await h.api.requestWorktree();
    h.manager.removeImpl = async () => ({
      removed: false,
      retryable: true,
      remaining: [{ kind: 'directory', path: h.worktree, error: 'EBUSY' }],
    });
    await assert.rejects(h.api.removeWorktree({ force: true }), (error) => {
      assert.equal(error.code, 'WORKTREE_REMOVAL_INCOMPLETE');
      assert.equal(error.details.entryId, 'fix');
      assert.equal(error.details.retryable, true);
      assert.deepEqual(error.details.remaining, [{ kind: 'directory', path: h.worktree, error: 'EBUSY' }]);
      return true;
    });
    // Never back into a folder that may already be half deleted.
    assert.equal(h.session.cwd, h.project);
    assert.equal(h.session.workspace.worktreeId, null);
    assert.equal(workspaceCwdLock([h.session.id]), null);
    assert.equal(h.calls.filter((call) => call[0] === 'claim').length, 1, 'the lease is not claimed back');
    // The record is `deleting` now; removeWorktree again resumes it.
    h.state.retained = { ...h.entry, state: 'deleting' };
    h.manager.removeImpl = async () => {
      h.state.retained = null;
      return { removed: true, branchDeleted: true };
    };
    const done = await h.api.removeWorktree({ force: true });
    assert.deepEqual(done.removed, { removed: true, branchDeleted: true });
    assert.equal(done.workspace.cwd, h.project);
  } finally {
    h.cleanup();
  }
});

test('the dock merge is project-authorized', async () => {
  const h = harness();
  try {
    await assert.rejects(
      h.api.mergeProjectBranch({ projectPath: join(h.project, '..', 'unregistered'), branch: 'dev', target: 'main' }),
      { code: 'WORKTREE_PROJECT_UNKNOWN' }
    );
  } finally {
    h.cleanup();
  }
});

test('list and prune pass the stored and live sessions; deleted-session cleanup follows autoCleanup', async () => {
  const h = harness();
  try {
    const seen = [];
    h.manager.listManagedWorktrees = async (input) => {
      seen.push(['list', input]);
      return [];
    };
    h.manager.reconcileManagedWorktrees = async (input) => {
      seen.push(['prune', input]);
      return { removed: [] };
    };
    h.manager.markWorktreeDisposable = async (id) => seen.push(['disposable', id]);
    await h.api.listWorktrees();
    await h.api.pruneWorktrees();
    assert.deepEqual(seen[0], ['list', { liveSessionIds: [h.session.id], retainedSessionIds: ['stored-1'] }]);
    assert.deepEqual(seen[1], [
      'prune',
      { liveSessionIds: [h.session.id], retainedSessionIds: ['stored-1'], removeOrphans: true },
    ]);
    h.state.retained = h.entry;
    assert.deepEqual(await h.api.cleanupDeletedSession('gone'), { entryId: 'fix', removed: true });
    assert.deepEqual(seen[2], ['disposable', 'fix']);
  } finally {
    h.cleanup();
  }
  const off = harness({ config: { worktree: { autoCleanup: false } } });
  try {
    off.state.retained = off.entry;
    assert.deepEqual(await off.api.cleanupDeletedSession('gone'), {
      entryId: 'fix',
      removed: false,
      reason: 'auto-cleanup-off',
    });
    assert.equal(off.names().includes('remove'), false);
  } finally {
    off.cleanup();
  }
});

test("a transition retargets the Lead's idle workers to the new root", async () => {
  const worker = { id: 'w-1', owner: 'agent', ownerSessionId: null, cwd: null };
  const h = harness({ live: [worker] });
  try {
    worker.ownerSessionId = h.session.id;
    worker.cwd = h.project;
    h.state.retained = h.entry;
    await h.api.requestWorktree();
    assert.equal(worker.cwd, h.worktree);
    assert.ok(h.calls.some((call) => call[0] === 'refresh' && call[1] === 'w-1' && call[2] === h.worktree));
    assert.ok(h.calls.some((call) => call[0] === 'persist' && call[1] === 'w-1'));
  } finally {
    h.cleanup();
  }
});

test('a session in recovery refuses its turn with WORKTREE_MISSING', async () => {
  const h = harness();
  try {
    h.session.workspace = {
      projectPath: h.project,
      repoCommonDir: join(h.project, '.git'),
      cwd: join(h.worktree, 'gone'),
      worktreeId: 'fix',
      branch: 'mixdog/fix',
      revision: 3,
      transition: { state: 'recovery', txId: 'recovery:fix' },
    };
    await assert.rejects(h.api.prepareTurnWorkspace({ submissionId: 's' }), { code: 'WORKTREE_MISSING' });
    // Picking a project branch is the way out.
    const back = await h.api.selectBranch({ branch: 'main' });
    assert.equal(back.workspace.transition.state, 'idle');
    assert.equal(back.revision, 4);
    assert.equal(await h.api.prepareTurnWorkspace({ submissionId: 's' }), null);
  } finally {
    h.cleanup();
  }
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the branch menu carries branch objects (DesktopGitBranch), with or without a session', async () => {
  const h = harness();
  try {
    const menu = await h.api.getBranchMenu();
    assert.deepEqual(menu.branches, [
      { name: 'main', current: true, remote: false, upstream: '' },
      { name: 'dev', current: false, remote: false, upstream: '' },
    ]);
    const project = await h.api.getProjectBranchMenu({ projectPath: h.project });
    assert.deepEqual(project.branches, menu.branches);
    assert.deepEqual(project.occupancy, [{ branch: 'main', kind: 'current' }]);
    assert.equal(project.retainedWorktree, null);
    assert.equal(project.workspace.projectPath, h.project);
    assert.equal(project.workspace.branch, 'main');
    assert.equal(project.workspace.worktreeId, null);
    assert.deepEqual(h.calls.filter((call) => call[0] === 'occupancy').at(-1)[1], {
      projectPath: h.project,
      sessionId: null,
    });
  } finally {
    h.cleanup();
  }
});

test('a draft branch change goes through the guarded checkout and refuses while others work there', async () => {
  const live = [];
  const h = harness({ live });
  try {
    assert.deepEqual(await h.api.selectProjectBranch({ projectPath: h.project, branch: 'main' }), {
      branch: 'main',
      changed: false,
    });
    assert.equal(h.names().includes('checkout'), false, 'the checked-out branch needs no switch');

    live.push({ id: 'other-active', cwd: h.project, owner: 'user' });
    await assert.rejects(h.api.selectProjectBranch({ projectPath: h.project, branch: 'dev' }), (error) => {
      assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
      assert.deepEqual(error.details.sessions, ['other-active']);
      return true;
    });
    live.length = 0;

    const leaveTurn = await admitTurn({ sessionId: 'turning-lead', cwd: () => join(h.project, 'src') });
    await assert.rejects(h.api.selectProjectBranch({ projectPath: h.project, branch: 'dev' }), (error) => {
      assert.equal(error.details.reason, 'folder-in-use');
      assert.deepEqual(error.details.sessions, ['turning-lead']);
      return true;
    });
    leaveTurn();
    assert.equal(h.names().includes('checkout'), false);

    await h.api.selectProjectBranch({ projectPath: h.project, branch: 'feature/y', create: true });
    assert.deepEqual(h.calls.find((call) => call[0] === 'checkout')[1], {
      projectPath: h.project,
      branch: 'feature/y',
      create: true,
      remote: false,
    });
  } finally {
    h.cleanup();
  }
});

test('turn admission waits for an in-flight transition of its session, then holds off other checkouts', async () => {
  const h = harness();
  try {
    let release;
    h.manager.checkoutGate = new Promise((resolve) => {
      release = resolve;
    });
    const switching = h.api.selectBranch({ branch: 'dev' });
    await tick();
    let admitted = false;
    const admission = h.api.admitTurnWorkspace({}).then((leave) => {
      admitted = true;
      return leave;
    });
    await tick();
    assert.equal(admitted, false, 'no turn starts mid-checkout');
    release();
    await switching;
    const leave = await admission;
    assert.equal(admitted, true);
    // The admitted turn runs in the shared project folder: another session
    // cannot change that checkout under it until the turn settles.
    assert.throws(
      () => holdCheckoutFolder('other-lead', h.state.cwd),
      (error) => {
        assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
        assert.equal(error.details.reason, 'folder-in-use');
        assert.deepEqual(error.details.sessions, [h.session.id]);
        return true;
      }
    );
    leave();
    holdCheckoutFolder('other-lead', h.project)();
  } finally {
    h.cleanup();
  }
});

test('a turn of a session sharing the checkout another session is changing waits; an abort registers nothing', async () => {
  const h = harness();
  try {
    const releaseHold = holdCheckoutFolder('other-lead', h.project);
    let admitted = false;
    const admission = h.api.admitTurnWorkspace({}).then((leave) => {
      admitted = true;
      return leave;
    });
    const controller = new AbortController();
    const aborted = h.api.admitTurnWorkspace({ signal: controller.signal });
    await tick();
    assert.equal(admitted, false, 'waits for the other session’s checkout');
    controller.abort(new Error('Turn aborted'));
    await assert.rejects(aborted, /Turn aborted/);
    releaseHold();
    const leave = await admission;
    assert.equal(admitted, true);
    leave();
    // Neither the settled nor the aborted admission is still registered.
    holdCheckoutFolder('other-lead', h.project)();
  } finally {
    h.cleanup();
  }
});

test('re-entering a retained worktree after a Project switch to another repository is refused', async () => {
  const h = harness();
  try {
    h.state.retained = { ...h.entry, repoCommonDir: join(h.project, '..', 'other-repo', '.git') };
    await assert.rejects(h.api.requestWorktree(), (error) => {
      assert.equal(error.code, 'WORKTREE_PROJECT_MISMATCH');
      assert.equal(error.details.worktreeId, 'fix');
      return true;
    });
    await assert.rejects(h.api.selectBranch({ branch: 'mixdog/fix' }), { code: 'WORKTREE_PROJECT_MISMATCH' });
    // Same repository, another Project folder inside it.
    h.state.retained = { ...h.entry, projectSubdir: 'packages/app' };
    await assert.rejects(h.api.requestWorktree(), { code: 'WORKTREE_PROJECT_MISMATCH' });
    assert.equal(h.names().includes('claim'), false, 'nothing was claimed');
    assert.equal(h.names().includes('applyCwd'), false, 'the session never moved');
    assert.equal(h.session.workspace, undefined);
  } finally {
    h.cleanup();
  }
});

test('a refused removal leaves the session in its worktree with its lease', async () => {
  const h = harness();
  try {
    h.state.retained = h.entry;
    await h.api.requestWorktree();
    const bound = h.session.workspace;
    const callsBefore = h.calls.length;
    h.manager.removableImpl = async () => {
      throw worktreeError('WORKTREE_DIRTY', undefined, { files: ['a.txt'] });
    };
    await assert.rejects(h.api.removeWorktree({}), { code: 'WORKTREE_DIRTY' });
    const after = h.calls.slice(callsBefore).map((call) => call[0]);
    assert.deepEqual(
      after.filter((name) => ['applyCwd', 'release', 'remove', 'persist'].includes(name)),
      [],
      'nothing moved before the refusal'
    );
    assert.equal(h.session.workspace, bound);
    assert.equal(h.state.cwd, h.worktree);
    assert.equal(workspaceCwdLock([h.session.id]), h.worktree);
  } finally {
    h.cleanup();
  }
});

test('a removal that fails after the session left restores cwd, record, prompts, worker roots and the lease', async () => {
  const worker = { id: 'w-restore', owner: 'agent', ownerSessionId: null, cwd: null };
  const h = harness({ live: [worker] });
  try {
    worker.ownerSessionId = h.session.id;
    worker.cwd = h.project;
    h.state.retained = h.entry;
    await h.api.requestWorktree();
    const bound = h.session.workspace;
    const leadPrompt = h.session.bp3EnvironmentContext;
    const workerPrompt = worker.bp3EnvironmentContext;
    assert.equal(worker.cwd, h.worktree);
    h.manager.removeImpl = async () => {
      throw new Error('EBUSY: worktree locked');
    };
    await assert.rejects(h.api.removeWorktree({ force: true }), /EBUSY/);
    assert.equal(h.session.workspace, bound, 'the bound record is back');
    assert.equal(h.state.cwd, h.worktree);
    assert.equal(h.session.cwd, h.worktree);
    assert.equal(h.session.bp3EnvironmentContext, leadPrompt);
    assert.equal(worker.cwd, h.worktree);
    assert.equal(worker.bp3EnvironmentContext, workerPrompt);
    assert.equal(workspaceCwdLock([h.session.id]), h.worktree);
    const leases = h.calls.filter((call) => call[0] === 'release' || call[0] === 'claim').map((call) => call[0]);
    assert.deepEqual(leases.slice(-2), ['release', 'claim'], 'the released lease is claimed back');
  } finally {
    h.cleanup();
  }
});

test('a prompt refresh that fails after the cwd moved restores the previous workspace exactly', async () => {
  const worker = { id: 'w-refresh', owner: 'agent', ownerSessionId: null, cwd: null, bp3EnvironmentContext: 'w-env' };
  const h = harness({ live: [worker] });
  try {
    worker.ownerSessionId = h.session.id;
    worker.cwd = h.project;
    h.session.bp3EnvironmentContext = 'lead-env';
    h.state.retained = h.entry;
    // The Lead refreshes, then the worker's refresh fails.
    h.state.refreshFails = (target) => target.id === worker.id;
    await assert.rejects(h.api.requestWorktree(), /prompt refresh failed/);
    assert.equal(h.session.workspace, undefined, 'no record was left behind');
    assert.equal(h.state.cwd, h.project);
    assert.equal(h.session.cwd, h.project);
    assert.equal(h.session.bp3EnvironmentContext, 'lead-env');
    assert.equal(worker.cwd, h.project);
    assert.equal(worker.bp3EnvironmentContext, 'w-env');
    assert.equal(workspaceCwdLock([h.session.id]), null);
    assert.deepEqual(
      h.calls.filter((call) => call[0] === 'claim' || call[0] === 'release').map((call) => call[0]),
      ['claim', 'release'],
      'the lease claimed for the move is released again'
    );
    assert.equal(h.calls.filter((call) => call[0] === 'applyCwd').at(-1)[1], h.project);
  } finally {
    h.cleanup();
  }
});

test('a transition stages tail notices without touching system prompts, and a rollback restores them exactly', async () => {
  const conversation = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
  ];
  const worker = { id: 'w-notice', owner: 'agent', ownerSessionId: null, cwd: null, bp3EnvSplit: true };
  const refresh = (target, cwd) =>
    refreshSessionWorkspaceContext(target, {
      cwd,
      environmentContext: `- Cwd: ${cwd} — the active Project root; relative paths and shell commands resolve here.`,
      instructionFilesContext: `# Instruction Files\n\n## ${cwd}/AGENTS.md\n\nrule`,
    });
  const h = harness({ live: [worker], sessionMessages: conversation, refresh });
  try {
    worker.ownerSessionId = h.session.id;
    worker.cwd = h.project;
    worker.bp3EnvironmentContext = `- Cwd: ${h.project} — the active Project root; relative paths and shell commands resolve here.`;
    worker.messages = [{ role: 'system', content: worker.bp3EnvironmentContext, cacheTier: 'env' }, ...conversation];
    h.session.bp3EnvSplit = true;
    h.session.bp3EnvironmentContext = '- Shell: test';
    h.session.messages.splice(1, 0, {
      role: 'system',
      content: `# Session\nCwd: ${h.project}\n\n---\n\n- Shell: test`,
      cacheTier: 'env',
    });
    const leadSystem = JSON.stringify(h.session.messages.filter((message) => message.role === 'system'));
    const workerSystem = JSON.stringify(worker.messages.filter((message) => message.role === 'system'));
    const systemOf = (target) => JSON.stringify(target.messages.filter((message) => message.role === 'system'));
    h.state.retained = h.entry;
    await h.api.requestWorktree();
    assert.equal(systemOf(h.session), leadSystem, 'the Lead prompt stays byte-identical');
    assert.equal(systemOf(worker), workerSystem, 'the worker prompt stays byte-identical');
    for (const target of [h.session, worker]) {
      const notice = snapshotPendingWorkspaceNotice(target).content;
      assert.ok(notice.includes(`The working folder is now ${h.worktree}.`));
      assert.ok(notice.includes(`## ${h.worktree}/AGENTS.md`));
    }
    const leadStaged = h.session.workspaceReroot;
    const workerStaged = worker.workspaceReroot;

    // A removal that fails after the session left: both staged changes are put back exactly.
    h.manager.removeImpl = async () => {
      throw new Error('EBUSY: worktree locked');
    };
    await assert.rejects(h.api.removeWorktree({ force: true }), /EBUSY/);
    assert.equal(h.session.workspaceReroot, leadStaged);
    assert.equal(worker.workspaceReroot, workerStaged);
    assert.equal(systemOf(h.session), leadSystem);
    assert.equal(systemOf(worker), workerSystem);
  } finally {
    h.cleanup();
  }
});

test('a transition that rolls back removes the notice it staged', async () => {
  const conversation = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
  ];
  const worker = { id: 'w-notice-fail', owner: 'agent', ownerSessionId: null, cwd: null, messages: [...conversation] };
  const h = harness({
    live: [worker],
    sessionMessages: conversation,
    refresh: (target, cwd) => refreshSessionWorkspaceContext(target, { cwd }),
  });
  try {
    worker.ownerSessionId = h.session.id;
    worker.cwd = h.project;
    h.session.messages.splice(1, 0, { role: 'system', content: `# Session\nCwd: ${h.project}`, cacheTier: 'env' });
    const before = JSON.stringify(h.session.messages);
    h.state.retained = h.entry;
    // The Lead stages its notice, then the worker's refresh fails.
    h.state.refreshFails = (target) => target.id === worker.id;
    await assert.rejects(h.api.requestWorktree(), /prompt refresh failed/);
    assert.equal(Object.hasOwn(h.session, 'workspaceReroot'), false, 'the staged notice is gone');
    assert.equal(Object.hasOwn(worker, 'workspaceReroot'), false);
    assert.equal(snapshotPendingWorkspaceNotice(h.session), null);
    assert.equal(JSON.stringify(h.session.messages), before);
  } finally {
    h.cleanup();
  }
});

function projectSwitchHarness() {
  const conversation = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
  ];
  const worker = { id: 'w-switch', owner: 'agent', ownerSessionId: null, cwd: null, messages: [...conversation] };
  const h = harness({
    live: [worker],
    sessionMessages: conversation,
    refresh: (target, cwd) =>
      refreshSessionWorkspaceContext(target, {
        cwd,
        instructionFilesContext: `# Instruction Files\n\n## ${cwd}/AGENTS.md\n\nrule`,
      }),
  });
  worker.ownerSessionId = h.session.id;
  worker.cwd = h.project;
  h.session.messages.splice(1, 0, { role: 'system', content: `# Session\nCwd: ${h.project}`, cacheTier: 'env' });
  const other = join(dirname(h.project), 'other');
  const third = join(dirname(h.project), 'third');
  mkdirSync(other);
  mkdirSync(third);
  return { ...h, worker, other, third };
}

test('a Project switch moves the Lead and its idle workers and stages their notices before it resolves', async () => {
  const h = projectSwitchHarness();
  try {
    const leadSystem = JSON.stringify(h.session.messages.filter((message) => message.role === 'system'));
    assert.equal(await h.api.switchProject(h.other), h.other);
    assert.deepEqual(
      h.calls.find((call) => call[0] === 'applyCwd'),
      ['applyCwd', h.other, { persistProjectSelection: true, classifyByMembership: false }]
    );
    assert.equal(h.session.cwd, h.other);
    assert.deepEqual(h.session.desktopSession, { classification: 'project', projectPath: h.other });
    assert.equal(h.worker.cwd, h.other, 'a reused worker runs in the new Project');
    assert.deepEqual(h.state.leadRows.at(-1), [h.session.id, h.other]);
    for (const target of [h.session, h.worker]) {
      assert.ok(snapshotPendingWorkspaceNotice(target).content.includes(`The working folder is now ${h.other}.`));
    }
    assert.equal(
      JSON.stringify(h.session.messages.filter((message) => message.role === 'system')),
      leadSystem,
      'the system prompt is untouched'
    );
    assert.ok(h.calls.some((call) => call[0] === 'refresh' && call[1] === h.worker.id && call[2] === h.other));

    // A turn that arrives during a switch is admitted only once the prompt
    // refresh landed.
    let release;
    h.state.refreshGate = new Promise((resolve) => {
      release = resolve;
    });
    const order = [];
    const switching = h.api.switchProject(h.third).then(() => order.push('switched'));
    const admitted = h.api.admitTurnWorkspace().then((leave) => {
      order.push('admitted');
      leave();
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, [], 'the turn waits for the switch');
    release();
    await Promise.all([switching, admitted]);
    assert.deepEqual(order.sort(), ['admitted', 'switched']);
    assert.equal(h.session.cwd, h.third);
    assert.ok(snapshotPendingWorkspaceNotice(h.session).content.includes(`The working folder is now ${h.third}.`));
  } finally {
    h.cleanup();
  }
});

test('a Project switch whose prompt refresh fails is rolled back and rejects', async () => {
  const h = projectSwitchHarness();
  try {
    await h.api.switchProject(h.other);
    const state = (target) => JSON.stringify({ ...target, updatedAt: null });
    const before = {
      lead: state(h.session),
      worker: state(h.worker),
      desktop: h.state.rtDesktop,
      reroot: h.session.workspaceReroot,
    };
    h.state.refreshFails = (target) => target.id === h.worker.id;
    await assert.rejects(h.api.switchProject(h.third), /prompt refresh failed/);
    assert.equal(h.state.cwd, h.other);
    assert.equal(state(h.session), before.lead, 'cwd, record, desktop metadata and notice restored');
    assert.equal(h.session.workspaceReroot, before.reroot);
    assert.equal(state(h.worker), before.worker);
    assert.equal(h.state.rtDesktop, before.desktop);
    assert.deepEqual(h.state.leadRows.at(-1), [h.session.id, h.other]);
  } finally {
    h.cleanup();
  }
});

test('a Project switch is refused from outside a running turn, while workers run, and inside a managed worktree', async () => {
  const h = projectSwitchHarness();
  try {
    h.state.activeTurns = 1;
    await assert.rejects(h.api.switchProject(h.other), { code: 'WORKTREE_BUSY_JOBS', details: { reason: 'turn' } });
    assert.equal(h.names().includes('applyCwd'), false);
    // The Lead's own tool call tolerates its calling turn.
    assert.equal(await h.api.switchProject(h.other, { ownTurn: true }), h.other);
    h.state.activeTurns = 0;

    h.state.workers = [{ sessionId: h.worker.id, status: 'running' }];
    await assert.rejects(h.api.switchProject(h.third, { ownTurn: true }), {
      code: 'WORKTREE_BUSY_JOBS',
      details: { reason: 'workers', workers: 1, jobs: 0 },
    });
    h.state.workers = [];
    // Background shells do not pin the Project.
    h.state.shellJobs = 2;
    assert.equal(await h.api.switchProject(h.project, { classifyByMembership: true }), h.project);
    assert.deepEqual(
      h.calls.filter((call) => call[0] === 'applyCwd').at(-1),
      ['applyCwd', h.project, { persistProjectSelection: true, classifyByMembership: true }],
      'the desktop/remote move classifies by Project membership'
    );
    h.state.shellJobs = 0;

    h.state.retained = h.entry;
    await h.api.requestWorktree();
    assert.equal(h.session.cwd, h.worktree);
    const applied = h.names().filter((name) => name === 'applyCwd').length;
    for (const ownTurn of [false, true]) {
      await assert.rejects(h.api.switchProject(h.other, { ownTurn }), /managed worktree; exit the worktree first/);
    }
    assert.equal(h.names().filter((name) => name === 'applyCwd').length, applied, 'nothing moved');
    assert.equal(h.session.cwd, h.worktree);
    assert.equal(h.session.workspace.worktreeId, 'fix', 'the worktree binding is kept');
  } finally {
    h.cleanup();
  }
});

test('session-less branch capabilities act only on a registered Project', async () => {
  const h = harness();
  try {
    const elsewhere = join(h.project, '..', 'not-registered');
    for (const call of [
      () => h.api.getProjectBranchMenu({ projectPath: elsewhere }),
      () => h.api.selectProjectBranch({ projectPath: elsewhere, branch: 'dev' }),
    ]) {
      await assert.rejects(call(), (error) => {
        assert.equal(error.code, 'WORKTREE_PROJECT_UNKNOWN');
        assert.equal(error.details.projectPath, elsewhere);
        return true;
      });
    }
    assert.equal(
      h.names().some((name) => ['inspect', 'occupancy', 'checkout'].includes(name)),
      false
    );
    // A remote branch is passed through to the guarded checkout.
    await h.api.selectProjectBranch({ projectPath: h.project, branch: 'origin/review', remote: true });
    assert.deepEqual(h.calls.find((call) => call[0] === 'checkout')[1], {
      projectPath: h.project,
      branch: 'origin/review',
      create: false,
      remote: true,
    });
    // A branch opened at a history commit: the same guarded checkout, with its start commit.
    await h.api.selectProjectBranch({ projectPath: h.project, branch: 'from-history', create: true, startPoint: BASE });
    assert.deepEqual(h.calls.filter((call) => call[0] === 'checkout').at(-1)[1], {
      projectPath: h.project,
      branch: 'from-history',
      create: true,
      remote: false,
      startPoint: BASE,
    });
    await assert.rejects(
      h.api.selectProjectBranch({ projectPath: h.project, branch: 'x', startPoint: BASE }),
      TypeError
    );
    // A detached checkout of a history commit: the same guarded checkout, no branch.
    await h.api.selectProjectBranch({ projectPath: h.project, detach: BASE });
    assert.deepEqual(h.calls.filter((call) => call[0] === 'checkout').at(-1)[1], {
      projectPath: h.project,
      detach: BASE,
    });
    await assert.rejects(
      h.api.selectProjectBranch({ projectPath: h.project, branch: 'main', detach: BASE }),
      TypeError
    );
    await assert.rejects(h.api.selectProjectBranch({ projectPath: elsewhere, detach: BASE }), {
      code: 'WORKTREE_PROJECT_UNKNOWN',
    });
  } finally {
    h.cleanup();
  }
});

test('a session that never left the project folder shows the folder’s checked-out branch', async () => {
  const h = harness();
  try {
    h.state.projectBranch = 'release';
    const menu = await h.api.getBranchMenu();
    assert.equal(h.session.workspace, undefined);
    assert.equal(menu.workspace.branch, 'release');
    assert.equal(menu.workspace.worktreeId, null);
  } finally {
    h.cleanup();
  }
});

test('a branch move whose finalization fails leaves the project checkout untouched', async () => {
  const h = harness();
  try {
    h.state.refreshFails = () => true;
    await assert.rejects(h.api.selectBranch({ branch: 'dev' }), /prompt refresh failed/);
    assert.deepEqual(
      h.calls.filter((call) => call[0] === 'checkout').map((call) => call[1].branch),
      [],
      'no checkout was changed'
    );
    assert.equal(h.state.projectBranch, 'main');
    assert.equal(h.session.workspace, undefined);
    assert.equal(h.state.cwd, h.project);
    // The folder was held until the switch back finished.
    holdCheckoutFolder('other-lead', h.project)();
  } finally {
    h.cleanup();
  }
});

test('a failed folder move does not need checkout rollback even when checkout would refuse', async () => {
  const h = harness();
  try {
    h.state.refreshFails = () => true;
    h.manager.checkoutImpl = async (input) => {
      if (input.branch === 'main') {
        throw worktreeError('WORKTREE_DIRTY', 'The project folder has uncommitted changes.', {
          reason: 'project-dirty',
        });
      }
      h.state.projectBranch = input.branch;
      return { branch: input.branch, changed: true };
    };
    await assert.rejects(h.api.selectBranch({ branch: 'dev' }), /prompt refresh failed/);
    assert.equal(h.state.projectBranch, 'main');
    assert.equal(h.session.workspace, undefined);
    assert.equal(h.session.cwd, h.project);
  } finally {
    h.cleanup();
  }
});

test('provisioning a New Task whose session cannot be created (no model) fails before anything is made', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-workspace-nomodel-'));
  try {
    const calls = [];
    const api = createWorkspaceTransitions({
      getSession: () => null,
      getReservedSessionId: () => 'sess_reserved',
      getCurrentCwd: () => root,
      createCurrentSession: async () => {
        throw new Error('No provider models available. Open /providers to sign in, then /model to choose a model.');
      },
      getActiveTurnCount: () => 0,
      manager: {
        async getSessionWorktree() {
          calls.push('getSessionWorktree');
          return null;
        },
        async createManagedWorktree() {
          calls.push('create');
        },
      },
    });
    await assert.rejects(api.requestWorktree({ provision: true, prompt: 'Fix', txId: 'sub-1' }), /No provider models/);
    assert.deepEqual(calls, [], 'no worktree was created');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the transition gate refuses overlap per Lead only', () => {
  const leave = beginWorkspaceTransition('lead-a', 'tx');
  try {
    assert.throws(() => beginWorkspaceTransition('lead-a', 'tx2'), { code: 'WORKTREE_BUSY_JOBS' });
    beginWorkspaceTransition('lead-b', 'tx')();
    enterWorkerSpawn(['lead-b'])();
  } finally {
    leave();
  }
  beginWorkspaceTransition('lead-a', 'tx3')();
});

test('getLiveWorkspace: a project-folder session publishes HEAD facts, identity-stable; a worktree record stays as stored', (t) => {
  const h = harness();
  t.after(h.cleanup);
  mkdirSync(join(h.project, '.git'), { recursive: true });
  writeFileSync(join(h.project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(h.api.getWorkspace(), null, 'the durable record is untouched');
  const first = h.api.getLiveWorkspace();
  assert.equal(first.branch, 'main');
  assert.equal(first.cwd, h.project);
  assert.equal(first.worktreeId, null);
  assert.ok(first.repoCommonDir);
  assert.equal(h.api.getLiveWorkspace(), first, 'identity-stable while unchanged');
  writeFileSync(join(h.project, '.git', 'HEAD'), 'ref: refs/heads/dev\n');
  assert.equal(h.api.getLiveWorkspace().branch, 'dev');
  writeFileSync(join(h.project, '.git', 'HEAD'), `${BASE}\n`);
  const detached = h.api.getLiveWorkspace();
  assert.deepEqual([detached.branch, detached.baseCommit], [null, BASE]);
  // A transition stub (no branch) gains the folder's facts and keeps its marker.
  h.session.workspace = {
    projectPath: h.project,
    repoCommonDir: null,
    cwd: h.project,
    worktreeId: null,
    branch: null,
    baseCommit: null,
    mergeTarget: null,
    revision: 3,
    transition: { state: 'switching', txId: 'tx-9' },
  };
  writeFileSync(join(h.project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const stub = h.api.getLiveWorkspace();
  assert.deepEqual([stub.branch, stub.revision, stub.transition.state], ['main', 3, 'switching']);
  assert.ok(stub.repoCommonDir);
  const bound = {
    ...stub,
    worktreeId: 'fix',
    branch: 'mixdog/fix',
    cwd: h.worktree,
    repoCommonDir: join(h.project, '.git'),
  };
  h.session.workspace = bound;
  assert.equal(h.api.getLiveWorkspace(), bound);
});

test('getLiveWorkspace: outside a git repository a never-moved session publishes none', (t) => {
  const h = harness();
  t.after(h.cleanup);
  assert.equal(h.api.getLiveWorkspace(), null);
});

test("the Lead's own tool call enters a worktree or branch during its turn; nothing else running is tolerated", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.state.activeTurns = 1;
  // Without ownTurn the running turn refuses (another session's request, the desktop).
  await assert.rejects(h.api.requestWorktree({ provision: true, txId: 'call-1' }), {
    code: 'WORKTREE_BUSY_JOBS',
    details: { reason: 'turn' },
  });
  assert.equal(h.session.workspace, undefined);
  assert.equal(h.names().includes('create'), false);
  const entered = await h.api.requestWorktree({ provision: true, name: 'fix', txId: 'call-1' }, { ownTurn: true });
  assert.equal(entered.workspace.cwd, h.worktree);
  assert.equal(entered.pending, false);
  const create = h.calls.find((call) => call[0] === 'create')[1];
  assert.deepEqual([create.txId, create.nameHint, create.carryChanges], ['call-1', 'fix', 'ask']);

  h.state.workers = [{ status: 'running' }];
  await assert.rejects(h.api.selectBranch({ branch: 'dev' }, { ownTurn: true }), (error) => {
    assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
    assert.equal(error.details.reason, 'workers');
    return true;
  });
  h.state.workers = [];
  await assert.rejects(h.api.selectBranch({ branch: 'dev' }), { code: 'WORKTREE_BUSY_JOBS' });
  const moved = await h.api.selectBranch({ branch: 'dev', txId: 'call-2' }, { ownTurn: true });
  assert.equal(moved.workspace.branch, 'dev');
  assert.equal(h.calls.filter((call) => call[0] === 'resolveBranch').at(-1)[1].txId, 'call-2');
  // Re-entering the retained worktree takes the same allowance.
  const back = await h.api.requestWorktree({ provision: true }, { ownTurn: true });
  assert.equal(back.workspace.worktreeId, 'fix');
});

test('external callers reach the public arity only: a smuggled { ownTurn: true } never passes a running turn', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.session.workspace = {
    revision: 3,
    worktreeId: 'fix',
    branch: 'mixdog/fix',
    cwd: h.worktree,
    repoCommonDir: join(h.project, '.git'),
    mergeTarget: 'main',
  };
  h.state.activeTurns = 1;
  // What the facade (desktop IPC, daemon session.configure) exposes.
  const external = publicWorkspaceMethods(h.api);
  const smuggled = { ownTurn: true };
  const calls = [
    () => external.requestWorktree({ provision: true, txId: 'x-1' }, smuggled),
    () => external.selectBranch({ branch: 'dev', txId: 'x-2' }, smuggled),
    () => external.mergeWorkspace({ confirmed: true, target: 'main', cleanup: true }, smuggled),
    () => external.removeWorktree({ force: true }, smuggled),
  ];
  for (const call of calls) {
    await assert.rejects(call(), (error) => {
      assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
      assert.equal(error.details.reason, 'turn');
      return true;
    });
  }
  assert.equal(h.session.workspace.worktreeId, 'fix', 'nothing moved');
});

/** A manager stand-in for snapshots: `inUse` ids are reported kept (a worker or shell runs there). */
function snapshotBackend(h) {
  const backend = { made: 0, inUse: new Set(), removals: [], gate: null };
  const idOf = new Map();
  h.manager.createSnapshotWorktree = async (input) => {
    h.calls.push(['snapshot', input]);
    backend.made += 1;
    idOf.set(input.txId, `snapshot-${backend.made}`);
    return { id: idOf.get(input.txId), kind: 'snapshot', path: join(h.project, '..', 'snap'), baseCommit: BASE };
  };
  // Named by creation transaction; reported by entry id.
  h.manager.removeSessionSnapshots = async (id, { txIds }) => {
    const ids = txIds.map((tx) => idOf.get(tx));
    backend.removals.push([id, ids]);
    if (backend.gate) await backend.gate;
    return {
      removed: ids.filter((one) => !backend.inUse.has(one)),
      kept: txIds
        .filter((tx) => backend.inUse.has(idOf.get(tx)))
        .map((tx) => ({ id: idOf.get(tx), txId: tx, reason: 'in-use' })),
    };
  };
  return backend;
}

const until = async (predicate) => {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), 'condition reached');
};

test('a snapshot lives for the turn that made it; addBranchWorktree never moves the session', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const backend = snapshotBackend(h);
  const repoCommonDir = join(h.project, '.git');
  // Outside a turn there is no turn to own it.
  await assert.rejects(h.api.createSnapshot({ repoCommonDir }), /belongs to a turn/);
  const leave = await h.api.admitTurnWorkspace({});
  const entry = await h.api.createSnapshot({ commit: BASE, txId: 'call-1:snap', repoCommonDir });
  assert.equal(entry.id, 'snapshot-1');
  const input = h.calls.find((call) => call[0] === 'snapshot')[1];
  assert.deepEqual(
    [input.projectPath, input.sessionId, input.commit, input.txId],
    [h.project, h.session.id, BASE, 'call-1:snap']
  );
  assert.equal(h.state.cwd, h.project, 'the session did not move');
  leave();
  await until(() => backend.removals.length === 1);
  assert.deepEqual(backend.removals, [[h.session.id, ['snapshot-1']]]);
  // A turn that made none removes nothing.
  (await h.api.admitTurnWorkspace({}))();
  await tick();
  assert.equal(backend.removals.length, 1);
  const turn = await h.api.admitTurnWorkspace({});
  await assert.rejects(h.api.createSnapshot({ repoCommonDir: join(h.project, 'elsewhere', '.git') }), {
    code: 'WORKTREE_PROJECT_MISMATCH',
  });
  turn();

  // A branch worktree is made for the session, which stays where it is.
  const added = await h.api.addBranchWorktree({ branch: 'feature', create: true, startPoint: BASE, txId: 'call-3' });
  const resolved = h.calls.filter((call) => call[0] === 'resolveBranch').at(-1)[1];
  assert.deepEqual(
    [resolved.branch, resolved.create, resolved.startPoint, resolved.txId],
    ['feature', true, BASE, 'call-3']
  );
  assert.equal(added.branch, 'feature');
  assert.equal(h.state.cwd, h.project);
  assert.equal(h.session.workspace, undefined);
  // A branch checked out elsewhere is refused, as git refuses it.
  await assert.rejects(h.api.addBranchWorktree({ branch: 'main' }), (error) => {
    assert.equal(error.code, 'WORKTREE_BRANCH_OCCUPIED');
    assert.equal(error.details.kind, 'current');
    return true;
  });
});

test('a snapshot a worker still runs in after the turn is kept until the worker ends, then removed', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const backend = snapshotBackend(h);
  const leave = await h.api.admitTurnWorkspace({});
  await h.api.createSnapshot({ repoCommonDir: join(h.project, '.git') });
  backend.inUse.add('snapshot-1');
  leave();
  await until(() => backend.removals.length >= 3);
  assert.ok(
    backend.removals.every(([, ids]) => ids.join() === 'snapshot-1'),
    'retried while the worker runs'
  );
  backend.inUse.delete('snapshot-1');
  const tries = backend.removals.length;
  await until(() => backend.removals.length > tries);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(backend.removals.length, tries + 1, 'removed once the worker ended; no further retries');
});

test('a snapshot cleanup stops on disposal, at its attempt cap, and on a non-in-use failure', async (t) => {
  const repoCommonDir = (h) => join(h.project, '.git');
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  const disposed = harness();
  t.after(disposed.cleanup);
  const kept = snapshotBackend(disposed);
  const leave = await disposed.api.admitTurnWorkspace({});
  await disposed.api.createSnapshot({ repoCommonDir: repoCommonDir(disposed) });
  kept.inUse.add('snapshot-1');
  leave();
  await until(() => kept.removals.length >= 2);
  disposed.api.dispose();
  await settle();
  const atDispose = kept.removals.length;
  await settle();
  assert.equal(kept.removals.length, atDispose, 'no retry after disposal');
  // A disposed runtime starts none.
  (await disposed.api.admitTurnWorkspace({}))();
  await settle();
  assert.equal(kept.removals.length, atDispose);

  const capped = harness({ snapshotRetryLimit: 3 });
  t.after(capped.cleanup);
  const busy = snapshotBackend(capped);
  const turn = await capped.api.admitTurnWorkspace({});
  await capped.api.createSnapshot({ repoCommonDir: repoCommonDir(capped) });
  busy.inUse.add('snapshot-1');
  turn();
  await until(() => busy.removals.length === 3);
  await settle();
  assert.equal(busy.removals.length, 3, 'maintenance takes over after the cap');

  const failing = harness();
  t.after(failing.cleanup);
  let attempts = 0;
  snapshotBackend(failing);
  failing.manager.removeSessionSnapshots = async () => {
    attempts += 1;
    throw new Error('admission ledger unreadable');
  };
  const run = await failing.api.admitTurnWorkspace({});
  await failing.api.createSnapshot({ repoCommonDir: repoCommonDir(failing) });
  run();
  await until(() => attempts === 1);
  await settle();
  assert.equal(attempts, 1, 'a failure other than in-use is not retried');
});

test("consecutive turns: turn 1's cleanup never touches the snapshot turn 2 made", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const backend = snapshotBackend(h);
  const repoCommonDir = join(h.project, '.git');
  let open;
  backend.gate = new Promise((resolve) => {
    open = resolve;
  });
  const first = await h.api.admitTurnWorkspace({});
  await h.api.createSnapshot({ repoCommonDir });
  first();
  // Turn 1's cleanup is still in flight while turn 2 starts and makes its own.
  const second = await h.api.admitTurnWorkspace({});
  await h.api.createSnapshot({ repoCommonDir });
  open();
  await until(() => backend.removals.length === 1);
  await tick();
  assert.deepEqual(backend.removals, [[h.session.id, ['snapshot-1']]]);
  backend.gate = null;
  second();
  await until(() => backend.removals.length === 2);
  assert.deepEqual(backend.removals[1], [h.session.id, ['snapshot-2']]);
});

test('a checkout made by git worktree add gets its first-turn setup once, when a session enters it', async (t) => {
  const plans = [];
  const h = harness({
    planSetup: async (input) => {
      plans.push([input.worktreeDir, input.mainDir]);
      return { notes: [], commands: [] };
    },
  });
  t.after(h.cleanup);
  const original = h.manager.resolveBranchWorkspace;
  h.manager.resolveBranchWorkspace = async (input) => {
    const resolved = await original(input);
    if (!input.create) {
      return { ...resolved, entry: { ...h.entry, id: 'raw-wt', path: resolved.path, branch: input.branch } };
    }
    // Made now (raw add): its registry entry keeps the setup pending.
    h.state.setupPending.set('raw-wt', { prepared: { root: h.project } });
    return {
      ...resolved,
      entry: { ...h.entry, id: 'raw-wt', path: resolved.path, branch: input.branch },
      created: true,
    };
  };
  await h.api.addBranchWorktree({ branch: 'feature', create: true, startPoint: BASE });
  await h.api.prepareTurnWorkspace({ submissionId: 'turn-1', prompt: 'go' });
  assert.deepEqual(plans, [], 'nothing runs while the session stays in the project folder');
  const entered = await h.api.selectBranch({ branch: 'feature' });
  assert.equal(entered.workspace.worktreeId, 'raw-wt');
  await h.api.prepareTurnWorkspace({ submissionId: 'turn-2', prompt: 'go' });
  await h.api.prepareTurnWorkspace({ submissionId: 'turn-3', prompt: 'again' });
  assert.deepEqual(plans, [[entered.workspace.cwd, h.project]], 'once, in that checkout');
  assert.deepEqual(h.state.setupClaims, ['raw-wt']);
  assert.ok(h.session.pendingSetupNotice);
});
