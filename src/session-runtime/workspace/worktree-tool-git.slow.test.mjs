// Managed worktrees of the issue #247 kind against real git, through the
// workspace API (the desktop branch menu's) and the git tool's host: a
// worktree whose owner session is gone is removed on request with the
// removal guards intact, and refused again if its owner came back; a new
// managed worktree for a branch a remote declares its default is refused on
// every surface; an existing branch records no merge target of its own.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import {
  configureWorktreeManager,
  createManagedWorktree,
  getSessionWorktree,
} from '../../runtime/shared/worktrees/manager.mjs';
import { getRecord, putRecord, readRegistry } from '../../runtime/shared/worktrees/registry.mjs';
import { samePath } from '../../runtime/shared/worktrees/paths.mjs';
import {
  cleanupTempDirs,
  commitFile,
  git,
  makeRepo,
  useTempDataDir,
} from '../../runtime/shared/worktrees/test-support.mjs';
import { createWorkspaceTransitions } from './transitions.mjs';
import { createWorktreeToolHost } from './worktree-tool.mjs';

let restore = () => {};
let counter = 0;

beforeEach(() => {
  counter += 1;
  useTempDataDir();
  // Every owner lease here is this test process's: its holders count as gone.
  restore = configureWorktreeManager({
    settings: {},
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
  });
});

afterEach(() => restore());
after(() => cleanupTempDirs());

/** Remote `name` declares `branch` its default (`refs/remotes/<name>/HEAD` → `<name>/<branch>`). */
function remoteDefault(repo, name, branch) {
  git(repo, 'update-ref', `refs/remotes/${name}/${branch}`, branch);
  git(repo, 'symbolic-ref', `refs/remotes/${name}/HEAD`, `refs/remotes/${name}/${branch}`);
}

/**
 * The issue's repository: `main` (origin's default) is one commit ahead of
 * `claude/feature`, which the project folder has checked out.
 */
function featureRepo({ origin = true } = {}) {
  const repo = makeRepo();
  commitFile(repo, 'main-only.txt', 'later\n');
  if (origin) remoteDefault(repo, 'origin', 'main');
  git(repo, 'switch', '-q', '-c', 'claude/feature', 'main~1');
  return repo;
}

function leadSession(repo, name) {
  return {
    id: `sess_${name}_${process.pid}_${counter}`,
    owner: 'user',
    sourceType: 'lead',
    cwd: repo,
    desktopSession: { classification: 'project', projectPath: repo },
    messages: [],
  };
}

/** The workspace API of `session`; no stored session exists (the store is never read). */
function workspaceApi(session, repo, overrides = {}) {
  return createWorkspaceTransitions({
    getSession: () => session,
    getCurrentCwd: () => session.cwd,
    applyResolvedCwd: (next) => {
      session.cwd = next;
    },
    persistSession: () => {},
    refreshWorkspaceContext: async () => {},
    getActiveTurnCount: () => 0,
    agentStatusState: () => ({ agentWorkers: [], agentJobs: [] }),
    countOwnShellJobs: async () => 0,
    listLiveSessions: () => [],
    listStoredSessionIds: async () => [],
    listWorkspaceConsumers: async () => [],
    listWorkspaceJobs: async () => [],
    findRegisteredProject: async (path) => (samePath(path, repo) ? repo : null),
    ...overrides,
  });
}

/** The tool host of Lead `session`; any other session is gone (the daemon's lookup fails). */
function toolHost(session, repo, overrides = {}) {
  const api = workspaceApi(session, repo, overrides);
  const host = createWorktreeToolHost({
    getSession: () => session,
    getWorkspaceApi: () => api,
    executeSessionControl: async (args) => {
      throw new Error(`session ${args.session_id} is not available`);
    },
  });
  return (request) => host.run(request, { callerSessionId: session.id });
}

/**
 * The reported state, made the way v1.3.5 made it: a session (since gone)
 * holds a managed worktree of `main` while the project folder is elsewhere.
 */
async function orphanOnMain(repo) {
  const owner = leadSession(repo, 'gone');
  await createManagedWorktree({
    projectPath: repo,
    sessionId: owner.id,
    runtimeToken: `token-${counter}`,
    txId: `tx-orphan-${counter}`,
    branch: 'main',
    existingBranch: true,
    baseBranch: 'main',
    nameHint: 'main',
  });
  const entry = await getSessionWorktree(owner.id);
  assert.equal(entry.branch, 'main');
  return { owner, entry };
}

const entryCount = async () => Object.keys((await readRegistry()).entries).length;
const worktreeCount = (repo) => git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length;

test('an existing branch records no merge target of its own', async () => {
  const repo = featureRepo();
  git(repo, 'branch', 'dev', 'main');
  const session = leadSession(repo, 'lead');
  const entered = await workspaceApi(session, repo).selectBranch({ branch: 'dev' });
  assert.equal(entered.workspace.branch, 'dev');
  const entry = await getSessionWorktree(session.id);
  assert.equal(entry.mergeTarget, null, "the project folder's branch is not where an existing branch merges");
});

test('a worktree whose owner session is gone is removed on request; dirty work still needs force', async () => {
  const repo = featureRepo();
  const { owner, entry } = await orphanOnMain(repo);
  const run = toolHost(leadSession(repo, 'lead'), repo);
  const row = (await run({ op: 'list' })).find((item) => item.id === entry.id);
  assert.equal(row.ownerLive, false);
  assert.equal(row.removable, true);

  writeFileSync(join(entry.path, 'scratch.txt'), 'unsaved\n');
  await assert.rejects(run({ op: 'remove', sessionId: owner.id }), { code: 'WORKTREE_DIRTY' });
  await assert.rejects(run({ op: 'remove-path', path: entry.path }), { code: 'WORKTREE_DIRTY' });
  assert.ok(existsSync(entry.path), 'nothing was removed');

  const removed = await run({ op: 'remove', sessionId: owner.id, force: true });
  assert.equal(removed.removed.removed, true);
  assert.equal(existsSync(entry.path), false);
  assert.equal(await entryCount(), 0);
  assert.ok(existsSync(repo), 'the project folder stays');
  // The default branch is free for the project folder again, and kept.
  git(repo, 'switch', '-q', 'main');
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('git worktree remove <path> of a clean orphan removes it; the pre-existing branch stays', async () => {
  const repo = featureRepo();
  const { entry } = await orphanOnMain(repo);
  // main is ahead of the project folder's branch: none of that is work only the worktree holds.
  const run = toolHost(leadSession(repo, 'lead'), repo);
  const removed = await run({ op: 'remove-path', path: entry.path, force: false });
  assert.equal(removed.removed.removed, true);
  assert.equal(existsSync(entry.path), false);
  assert.ok(git(repo, 'rev-parse', '--verify', 'main'));
});

test("a record from before the fix (merge target: the project folder's branch) is removed with force", async () => {
  const repo = featureRepo();
  const { owner, entry } = await orphanOnMain(repo);
  await putRecord({ ...(await getRecord(entry.id)), mergeTarget: 'claude/feature' });
  const run = toolHost(leadSession(repo, 'lead'), repo);
  await assert.rejects(run({ op: 'remove', sessionId: owner.id }), { code: 'WORKTREE_UNMERGED' });
  const tip = git(repo, 'rev-parse', 'main');
  const removed = await run({ op: 'remove', sessionId: owner.id, force: true });
  assert.equal(removed.removed.removed, true);
  assert.equal(git(repo, 'rev-parse', 'main'), tip, 'main is kept as it was');
});

test('an owner that came back before the lock refuses the orphan removal', async (t) => {
  const repo = featureRepo();
  const { owner, entry } = await orphanOnMain(repo);
  let ownerBack = false;
  t.after(configureWorktreeManager({ processAlive: () => ownerBack }));
  // The owner's runtime claims its lease again after the list said "gone",
  // between the folder admission and the removal.
  const run = toolHost(leadSession(repo, 'lead'), repo, {
    listWorkspaceJobs: async () => {
      ownerBack = true;
      return [];
    },
  });
  await assert.rejects(run({ op: 'remove', sessionId: owner.id, force: true }), {
    code: 'WORKTREE_BUSY_JOBS',
    details: { reason: 'workspace-lease', entryId: entry.id },
  });
  assert.ok(existsSync(entry.path), 'nothing was removed');
  assert.equal((await getRecord(entry.id)).state, 'ready');
});

test("every remote's default branch is refused on the desktop menu and the git tool; other branches open", async () => {
  const repo = featureRepo();
  git(repo, 'branch', 'trunk', 'main~1');
  remoteDefault(repo, 'upstream', 'trunk');
  const lead = leadSession(repo, 'lead');
  const api = workspaceApi(lead, repo);
  const run = toolHost(lead, repo);
  for (const branch of ['main', 'trunk']) {
    await assert.rejects(api.selectBranch({ branch }), { code: 'WORKTREE_DEFAULT_BRANCH', details: { branch } });
    await assert.rejects(run({ op: 'enter', branch, txId: `enter-${branch}` }), { code: 'WORKTREE_DEFAULT_BRANCH' });
    await assert.rejects(run({ op: 'add', branch, create: false, txId: `add-${branch}` }), {
      code: 'WORKTREE_DEFAULT_BRANCH',
    });
  }
  assert.equal(await entryCount(), 0, 'no worktree was made');
  assert.equal(worktreeCount(repo), 1);
  assert.ok(samePath(lead.cwd, repo), 'the session did not move');

  // The project folder's own branch: the session runs in the project folder, nothing is locked.
  const current = await run({ op: 'enter', branch: 'claude/feature', txId: 'enter-current' });
  assert.ok(samePath(current.workspace.cwd, repo));
  assert.equal(await entryCount(), 0);

  // A new branch, and any other existing branch, still get their worktree.
  const fresh = await run({ op: 'enter', branch: 'from-main', create: true, txId: 'enter-new' });
  assert.equal(git(fresh.workspace.cwd, 'symbolic-ref', '--short', 'HEAD'), 'from-main');
  git(repo, 'branch', 'dev', 'main');
  const dev = await api.selectBranch({ branch: 'dev' });
  assert.equal(git(dev.workspace.cwd, 'symbolic-ref', '--short', 'HEAD'), 'dev');
});

test('without a remote, or with a remote HEAD that is no symbolic ref, no branch counts as the default', async () => {
  for (const setup of ['no-remote', 'detached-remote-head']) {
    const repo = featureRepo({ origin: false });
    if (setup === 'detached-remote-head') git(repo, 'update-ref', 'refs/remotes/origin/HEAD', 'main');
    const lead = leadSession(repo, setup);
    const entered = await workspaceApi(lead, repo).selectBranch({ branch: 'main' });
    assert.equal(git(entered.workspace.cwd, 'symbolic-ref', '--short', 'HEAD'), 'main', setup);
    assert.equal(worktreeCount(repo), 2, setup);
  }
});
