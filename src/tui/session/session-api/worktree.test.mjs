// The session worktree actions delegate to the runtime authority, republish
// the route state after a change, and their typed WorktreeError codes survive
// the daemon call envelope (call-route → attachment client).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionWorktreeApi, SESSION_WORKTREE_ACTIONS } from './worktree.mjs';
import {
  WORKTREE_REFUSAL_REASONS,
  worktreeError,
  worktreeRefusal,
} from '../../../runtime/shared/worktrees/contract.mjs';
import { createCallRoute } from '../../../standalone/session-transport/call-route.mjs';
import { createAttachmentCalls } from '../../../standalone/session-client/attachment-calls.mjs';

function wire(api) {
  const handleCallRequest = createCallRoute({
    handleCall: async (name, args) => api[name.replace(/^session\./, '')](...(args.args || [])),
    clients: new Map([['client-1', {}]]),
    lanes: { dispatch: (_owner, task) => task() },
    callCache: { get: () => null, track: () => {} },
    nowMs: () => 0,
  });
  return createAttachmentCalls({
    request: async ({ body }) => {
      let raw = '';
      await handleCallRequest(body, { writeHead: () => {}, end: (chunk) => (raw = chunk) });
      return JSON.parse(raw);
    },
    port: 0,
    serverToken: 's',
    clientToken: 'client-1',
    stopStream: () => {},
    log: () => {},
  });
}

test('worktree actions delegate to the runtime and republish the route state after a change', async () => {
  const calls = [];
  const runtime = Object.fromEntries(
    SESSION_WORKTREE_ACTIONS.map((action) => [
      action,
      async (input) => {
        calls.push([action, input]);
        return { action };
      },
    ])
  );
  const published = [];
  const api = createSessionWorktreeApi({
    runtime,
    set: (patch) => published.push(patch),
    routeState: () => ({ workspace: { revision: 1 } }),
  });
  assert.deepEqual(await api.selectBranch({ branch: 'dev', expectedRevision: 0 }), { action: 'selectBranch' });
  assert.deepEqual(calls.at(-1), ['selectBranch', { branch: 'dev', expectedRevision: 0 }]);
  assert.equal(published.length, 1);
  await api.getBranchMenu();
  assert.deepEqual(calls.at(-1), ['getBranchMenu', {}]);
  assert.equal(published.length, 1, 'reads publish nothing');
});

test('a WorktreeError code crosses the daemon call envelope', async () => {
  const api = createSessionWorktreeApi({
    runtime: {
      selectBranch: async () => {
        throw worktreeError('WORKTREE_BUSY_JOBS', undefined, { reason: 'workers' });
      },
      requestWorktree: async () => {
        throw worktreeError('WORKTREE_LARGE_REPO_CONFIRM');
      },
    },
  });
  const client = wire(api);
  await assert.rejects(client.call('session.selectBranch', { args: [{ branch: 'dev' }] }), (error) => {
    assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
    assert.match(error.message, /running jobs/);
    return true;
  });
  await assert.rejects(client.call('session.requestWorktree', { args: [{}] }), { code: 'WORKTREE_LARGE_REPO_CONFIRM' });
  await assert.rejects(client.call('session.mergeWorkspace', { args: [{ confirmed: true }] }), {
    code: 'WORKTREE_NOT_IMPLEMENTED',
  });
});

test('every management refusal reaches TUI and remote clients with its one shared text', async () => {
  for (const [reason, text] of Object.entries(WORKTREE_REFUSAL_REASONS)) {
    const api = createSessionWorktreeApi({
      runtime: {
        manageProjectBranch: async () => {
          throw worktreeRefusal(reason);
        },
      },
    });
    await assert.rejects(wire(api).call('session.manageProjectBranch', { args: [{}] }), (error) => {
      assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
      assert.equal(error.message, text);
      return true;
    });
  }
});
