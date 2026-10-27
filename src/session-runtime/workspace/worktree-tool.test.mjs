// The Lead's worktree operations behind the git tool: its own session goes
// through the runtime's workspace API with ownTurn (the calling turn is
// tolerated), another session through session control without it (the
// target must be idle), and a path removal resolves its managed owner first.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorktreeToolHost } from './worktree-tool.mjs';
import { worktreeError } from '../../runtime/shared/worktrees/contract.mjs';
import { markUnattendedRun } from '../held-requests.mjs';

const LEAD = 'sess_lead';
const PROJECT = '/repo';

// A conversation session: the desktop Lead.
const ATTENDED = { id: LEAD, owner: 'user', sourceType: 'lead' };

function fixture({ entries = {}, session = ATTENDED } = {}) {
  const calls = [];
  const state = { workspace: { cwd: '/wt/fix', worktreeId: 'fix', branch: 'mixdog/fix', mergeTarget: 'main' } };
  const menu = (workspace) => ({
    workspace: { projectPath: PROJECT, cwd: PROJECT, worktreeId: null, mergeTarget: null, revision: 4, ...workspace },
    occupancy: state.occupancy ?? [{ branch: 'main', kind: 'current' }],
    retainedWorktree: { id: 'fix' },
  });
  const record =
    (name, result = {}) =>
    async (...args) => {
      calls.push([name, ...args]);
      if (state.fail?.[name]) throw state.fail[name];
      return result;
    };
  const api = {
    getBranchMenu: async () => menu(state.workspace),
    requestWorktree: record('requestWorktree', { revision: 5 }),
    selectBranch: record('selectBranch', { revision: 5 }),
    mergeWorkspace: record('mergeWorkspace', { merged: true }),
    removeWorktree: record('removeWorktree', { removed: { removed: true } }),
    removeSnapshot: record('removeSnapshot', { removed: true }),
    listWorktrees: record('listWorktrees', []),
    pruneWorktrees: record('pruneWorktrees', { removed: [] }),
  };
  const control = async (args, context) => {
    calls.push(['control', args, context]);
    if (state.fail?.control) throw state.fail.control;
    return args.method === 'getBranchMenu' ? menu({ ...state.workspace, revision: 9 }) : { revision: 10 };
  };
  const manager = { getWorktreeByPath: async (path) => entries[path] ?? null };
  const host = createWorktreeToolHost({
    getSession: () => session,
    getWorkspaceApi: () => api,
    executeSessionControl: control,
    manager,
  });
  const run = (request) => host.run(request, { callerSessionId: LEAD });
  return { calls, state, run };
}

test('its own session: enter, return, merge and remove tolerate the calling turn', async () => {
  const h = fixture();
  await h.run({ op: 'enter', name: 'fix', txId: 'call-1:enter' });
  await h.run({ op: 'enter', name: 'Fix the login page', carry: 'leave', txId: 't' });
  await h.run({ op: 'enter', branch: 'dev', create: true, confirmLarge: true, txId: 't2' });
  await h.run({ op: 'return', txId: 't3' });
  await h.run({ op: 'merge' });
  await h.run({ op: 'remove', force: true });
  assert.deepEqual(h.calls, [
    [
      'requestWorktree',
      { provision: true, name: 'fix', prompt: '', confirmLarge: false, txId: 'call-1:enter' },
      { ownTurn: true },
    ],
    [
      'requestWorktree',
      // Not a slug: the text names the worktree the way a first message does.
      {
        provision: true,
        name: null,
        prompt: 'Fix the login page',
        carryChanges: 'leave',
        confirmLarge: false,
        txId: 't',
      },
      { ownTurn: true },
    ],
    ['selectBranch', { branch: 'dev', create: true, confirmLarge: true, txId: 't2' }, { ownTurn: true }],
    // Back to the branch the project folder has checked out.
    ['selectBranch', { branch: 'main', expectedRevision: 4, txId: 't3' }, { ownTurn: true }],
    ['mergeWorkspace', { confirmed: true, target: 'main', expectedRevision: 4, cleanup: true }, { ownTurn: true }],
    ['removeWorktree', { force: true }, { ownTurn: true }],
  ]);
});

test('return from the project folder changes nothing; a detached project folder has no branch to return to', async () => {
  const h = fixture();
  h.state.workspace = { cwd: PROJECT, worktreeId: null, branch: 'main' };
  assert.equal((await h.run({ op: 'return' })).unchanged, true);
  h.state.workspace = { cwd: '/wt/fix', worktreeId: 'fix', branch: 'mixdog/fix' };
  h.state.occupancy = [{ branch: 'main', kind: 'free' }];
  await assert.rejects(h.run({ op: 'return' }), { code: 'WORKTREE_UNSUPPORTED_REPO' });
  assert.equal(h.calls.length, 0);
});

test('another session goes through session control without ownTurn, and its busy refusal stays typed', async () => {
  const h = fixture();
  await h.run({ op: 'enter', sessionId: 'sess_other', name: 'fix', txId: 't' });
  await h.run({ op: 'merge', sessionId: 'sess_other' });
  assert.deepEqual(h.calls[0], [
    'control',
    {
      action: 'worktree',
      session_id: 'sess_other',
      method: 'requestWorktree',
      input: { provision: true, name: 'fix', prompt: '', confirmLarge: false, txId: 't' },
    },
    { callerSessionId: LEAD, callerScope: { kind: 'human', attended: true } },
  ]);
  assert.deepEqual(h.calls[1][1], { action: 'worktree', session_id: 'sess_other', method: 'getBranchMenu' });
  assert.deepEqual(h.calls[2][1].input, { confirmed: true, target: 'main', expectedRevision: 9, cleanup: true });
  // The caller's own id is its own lane, never session control.
  await h.run({ op: 'remove', sessionId: LEAD });
  assert.equal(h.calls.at(-1)[0], 'removeWorktree');

  h.state.fail = { control: worktreeError('WORKTREE_BUSY_JOBS', undefined, { reason: 'turn' }) };
  await assert.rejects(h.run({ op: 'remove', sessionId: 'sess_other' }), {
    code: 'WORKTREE_BUSY_JOBS',
    details: { reason: 'turn' },
  });
});

test('only a conversation session changes worktrees; schedules, webhooks, bot routines and workers only list', async (t) => {
  const unmark = markUnattendedRun('sess_home_reviewer', { kind: 'schedule', agentId: 'reviewer', name: 'nightly' });
  t.after(unmark);
  const refused = {
    schedule: { id: 'sess_run', owner: 'user', sourceType: 'schedule' },
    webhook: { id: 'sess_hook', owner: 'user', sourceType: 'webhook' },
    worker: { id: 'sess_worker', owner: 'agent', parentSessionId: LEAD },
    'bot routine': { id: 'sess_home_reviewer' },
  };
  const mutations = [
    { op: 'enter', name: 'fix' },
    { op: 'return' },
    { op: 'merge' },
    { op: 'remove' },
    { op: 'prune' },
    { op: 'add', branch: 'b', create: true },
    { op: 'snapshot', commit: 'HEAD' },
    { op: 'remove-path', path: '/wt/fix' },
    { op: 'enter', sessionId: 'sess_other', name: 'fix' },
  ];
  for (const [label, session] of Object.entries(refused)) {
    const h = fixture({ session });
    for (const request of mutations) {
      await assert.rejects(h.run(request), /only in a conversation session/, `${label} ${request.op}`);
    }
    await h.run({ op: 'list' });
    assert.deepEqual(
      h.calls.map((call) => call[0]),
      ['listWorktrees'],
      `${label}: nothing but the list ran`
    );
  }
  // A bot's chat (no unattended run marked on it) is a conversation session.
  const bot = fixture({ session: { id: 'sess_home_writer' } });
  await bot.run({ op: 'prune' });
  assert.deepEqual(bot.calls[0][0], 'pruneWorktrees');
});

test('a path removal resolves its managed owner: snapshot, own or other session, never an unmanaged folder', async () => {
  const h = fixture({
    entries: {
      '/wt/snap': { id: 'snap', kind: 'snapshot', path: '/wt/snap', holderSessionId: LEAD },
      '/wt/fix': { id: 'fix', path: '/wt/fix', branch: 'mixdog/fix', ownerSessionId: LEAD },
      '/wt/theirs': { id: 'fix', path: '/wt/theirs', branch: 'mixdog/theirs', ownerSessionId: 'sess_other' },
      '/wt/second': { id: 'second', path: '/wt/second', branch: 'dev', ownerSessionId: LEAD },
      '/wt/orphan': { id: 'orphan', path: '/wt/orphan', branch: 'x', ownerSessionId: null },
    },
  });
  await h.run({ op: 'remove-path', path: '/wt/snap', force: false });
  await h.run({ op: 'remove-path', path: '/wt/fix', force: true });
  await h.run({ op: 'remove-path', path: '/wt/theirs' });
  assert.deepEqual(h.calls[0], ['removeSnapshot', { path: '/wt/snap', force: false }]);
  assert.deepEqual(h.calls[1], ['removeWorktree', { force: true, expectedRevision: 4 }, { ownTurn: true }]);
  // Another session's worktree: listed first (a gone owner's is removed here), then its own lane.
  assert.equal(h.calls[2][0], 'listWorktrees');
  assert.equal(h.calls[4][1].method, 'removeWorktree');
  assert.deepEqual(h.calls[4][1].input, { force: false, expectedRevision: 9 });
  await assert.rejects(h.run({ op: 'remove-path', path: '/elsewhere' }), /not a Mixdog-managed worktree/);
  await assert.rejects(h.run({ op: 'remove-path', path: '/wt/orphan' }), /git worktree prune removes it/);
  await assert.rejects(h.run({ op: 'remove-path', path: '/wt/second' }), /not the current worktree/);
});
