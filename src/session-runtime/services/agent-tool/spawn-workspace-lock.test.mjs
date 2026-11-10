// Workers share the Lead's execution root: while the Lead is bound to its
// worktree, a spawn's args.cwd (or an inherited pre-transition cwd) cannot
// send the worker elsewhere, and no spawn is prepared during a transition.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createSpawnPlanner } from './spawn-flow/spawn-plan.mjs';
import { createSpawnPreparer } from './spawn-flow/spawn-prep.mjs';
import { beginWorkspaceTransition, setWorkspaceCwdLock } from '../../workspace/admission-gate.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-spawn-lock-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'agents', 'worker.md'), '---\ndescription: worker\n---\nWork.\n');
  const deps = {
    cfgMod: { loadConfig: () => ({}) },
    dataDir: join(root, 'data'),
    STANDALONE_SOURCE_ROOT: root,
    defaultCwd: root,
    nextTag: () => 'worker1',
    resolveTag: () => null,
    wantsSessionScan: () => false,
  };
  return { root, deps, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const args = (extra = {}) => ({ agent: 'worker', provider: 'p', model: 'm', prompt: 'do it', ...extra });

test('a worktree-bound Lead locks every worker spawn to its worktree root', async () => {
  const f = fixture();
  try {
    const { resolveSpawnPlan } = createSpawnPlanner(f.deps);
    const project = join(f.root, 'project');
    const free = await resolveSpawnPlan(args({ cwd: 'sub' }), project, { callerSessionId: 'lead-free' });
    assert.equal(free.workerCwd, resolve(project, 'sub'), 'without a binding args.cwd still applies');

    const worktree = join(f.root, 'wt');
    setWorkspaceCwdLock('lead-bound', worktree);
    try {
      const fromLead = await resolveSpawnPlan(args({ cwd: project }), project, { callerSessionId: 'lead-bound' });
      assert.equal(fromLead.workerCwd, resolve(worktree));
      const nested = await resolveSpawnPlan(args({ cwd: 'elsewhere' }), join(f.root, 'stale'), {
        callerSessionId: 'worker-1',
        ownerSessionId: 'lead-bound',
      });
      assert.equal(nested.workerCwd, resolve(worktree), "a worker's own spawn follows the Lead's root");
    } finally {
      setWorkspaceCwdLock('lead-bound', null);
    }
  } finally {
    f.cleanup();
  }
});

test('no worker spawn is prepared while its Lead workspace changes', async () => {
  const f = fixture();
  try {
    const { prepareSpawnInProcess } = createSpawnPreparer({
      ...f.deps,
      bindTag: () => assert.fail('nothing binds during a transition'),
      cancelReap: () => {},
      ensureProvider: async () => {},
    });
    const leave = beginWorkspaceTransition('lead-moving', 'tx');
    try {
      await assert.rejects(prepareSpawnInProcess(args(), f.root, { callerSessionId: 'lead-moving' }), (error) => {
        assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
        assert.equal(error.details.reason, 'transition');
        return true;
      });
    } finally {
      leave();
    }
  } finally {
    f.cleanup();
  }
});
