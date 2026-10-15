import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalRunRequests } from './run-requests.ts';
import { createTerminalCommandExecutor } from './commands.ts';

const tab = { tab: 1, id: 'session-terminal:s1', shell: 'sh', running: true, cwd: null };

test('a claimed request resolves its open and cannot be claimed twice', async () => {
  const sent = [];
  const runs = createTerminalRunRequests((request) => (sent.push(request), true));
  const opened = runs.open('s1', 'npm test', new AbortController().signal);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].command, 'npm test');
  assert.equal(runs.claim(sent[0].requestId), true);
  await opened;
  assert.equal(runs.claim(sent[0].requestId), false);
  assert.equal(runs.claim('unknown'), false);
});

test('an aborted open withdraws its command: the late claim is refused and the renderer is told to drop it', async () => {
  const sent = [];
  const runs = createTerminalRunRequests((request) => (sent.push(request), true));
  const controller = new AbortController();
  const opened = runs.open('s1', 'rm -rf build', controller.signal);
  const { requestId } = sent[0];
  controller.abort(new Error('client gone'));
  await assert.rejects(opened, /client gone/);
  assert.deepEqual(sent[1], { sessionId: 's1', cancelRequestId: requestId });
  assert.equal(runs.claim(requestId), false);
});

test('no window rejects without leaving a claimable request', async () => {
  const sent = [];
  const runs = createTerminalRunRequests((request) => (sent.push(request), false));
  await assert.rejects(runs.open('s1', 'ls', new AbortController().signal), /no desktop window/);
  assert.equal(runs.claim(sent[0].requestId), false);
});

function executorOver(runs, tabsAfterClaim = [tab], options = {}) {
  let claimed = false;
  const sent = [];
  const backend = {
    sessionTabs: () => (claimed ? tabsAfterClaim : []),
    write() {},
    revealTerminal: () => true,
    openTerminal: (sessionId, command, signal) => runs.open(sessionId, command, signal),
    snapshot: () => ({ text: '', cursor: 0, reset: false }),
  };
  return {
    sent,
    execute: createTerminalCommandExecutor(backend, { openTimeoutMs: 40, openPollMs: 5, ...options }),
    markClaimed: () => {
      claimed = true;
    },
  };
}

test('a run that timed out before the pane opened never executes when the pane opens later', async () => {
  const sent = [];
  const runs = createTerminalRunRequests((request) => (sent.push(request), true));
  const { execute } = executorOver(runs);
  await assert.rejects(execute({ action: 'run', session_id: 's1', command: 'echo hi' }), /timed out/);
  // The pane opens afterwards and tries to enter the queued command.
  const queued = sent.find((request) => request.command);
  assert.equal(runs.claim(queued.requestId), false);
  assert.ok(sent.some((request) => request.cancelRequestId === queued.requestId));
});

test('a run whose bridge client disconnected is withdrawn the same way', async () => {
  const sent = [];
  const runs = createTerminalRunRequests((request) => (sent.push(request), true));
  const { execute } = executorOver(runs, [tab], { openTimeoutMs: 10_000 });
  const controller = new AbortController();
  const result = execute({ action: 'run', session_id: 's1', command: 'echo hi' }, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('terminal bridge client disconnected'));
  await assert.rejects(result, /disconnected/);
  assert.equal(runs.claim(sent.find((request) => request.command).requestId), false);
});

test('a run claimed in time reports the tab it went to', async () => {
  const sent = [];
  const runs = createTerminalRunRequests((request) => (sent.push(request), true));
  const { execute, markClaimed } = executorOver(runs);
  const result = execute({ action: 'run', session_id: 's1', command: 'echo hi' });
  await new Promise((resolve) => setImmediate(resolve));
  markClaimed();
  assert.equal(runs.claim(sent[0].requestId), true);
  assert.deepEqual(await result, { id: tab.id, tab: 1, shell: 'sh', running: true, cwd: null, cursor: 0 });
});
