import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalRunRequests } from './run-requests.ts';
import { createTerminalCommandExecutor } from './commands.ts';
import { createTerminalBridgeBackend } from './bridge-backend.ts';
import { createTerminalRunDispatch } from './run-dispatch.ts';

const tab = (n, cwd = null) => ({
  tab: n,
  id: n === 1 ? 'session-terminal:s1' : `session-terminal:s1:${n}`,
  shell: 'sh',
  running: true,
  cwd,
});

/** A daemon with PTYs keyed by id; `termEnsure` starts one, `termWrite` types into it. */
function fakeDaemon(initial = []) {
  const terminals = new Map(initial.map((entry) => [entry.id, { ...entry, written: [] }]));
  const calls = [];
  return {
    terminals,
    calls,
    invoke: async (name, args) => {
      calls.push([name, ...args]);
      if (name === 'termSessionTabs') return [...terminals.values()].filter((entry) => entry.id.startsWith(`session-terminal:${args[0]}`));
      if (name === 'termEnsure') {
        if (!terminals.has(args[0])) terminals.set(args[0], { ...tab(1, args[1]), id: args[0], written: [] });
        return { id: args[0], replay: '' };
      }
      if (name === 'termWrite') {
        terminals.get(args[0])?.written.push(args[1]);
        return null;
      }
      if (name === 'termSnapshot') return { text: '', cursor: 5, reset: false };
      throw new Error(`unexpected ${name}`);
    },
  };
}

test('a claimed reveal reports shown and cannot be claimed twice', async () => {
  const sent = [];
  const runs = createTerminalRunRequests((request) => (sent.push(request), true));
  const shown = runs.reveal({ sessionId: 's1', terminalId: 'session-terminal:s1' }, 1000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].terminalId, 'session-terminal:s1');
  assert.equal(runs.claim(sent[0].requestId), true);
  assert.equal(await shown, true);
  assert.equal(runs.claim(sent[0].requestId), false);
  assert.equal(runs.claim('unknown'), false);
});

test('an unclaimed reveal reports background after the wait, and a late claim is refused', async () => {
  const sent = [];
  const runs = createTerminalRunRequests((request) => (sent.push(request), true));
  assert.equal(await runs.reveal({ sessionId: 's1' }, 10), false);
  assert.equal(runs.claim(sent[0].requestId), false);
});

test('no window reports background at once without leaving a claimable request', async () => {
  const sent = [];
  const runs = createTerminalRunRequests((request) => (sent.push(request), false));
  assert.equal(await runs.reveal({ sessionId: 's1' }, 60_000), false);
  assert.equal(runs.claim(sent[0].requestId), false);
});

function bridge({ daemon = fakeDaemon(), claimShown = false, windowOpen = true } = {}) {
  const requests = [];
  const runs = createTerminalRunRequests((request) => {
    requests.push(request);
    if (windowOpen && claimShown) queueMicrotask(() => runs.claim(request.requestId));
    return windowOpen;
  });
  const execute = createTerminalCommandExecutor(
    createTerminalBridgeBackend({
      invoke: daemon.invoke,
      sessionCwd: async () => '/work',
      reveal: (request) => runs.reveal(request, 20),
    })
  );
  return { daemon, requests, execute };
}

test('a run for a session with no terminal and nothing on screen starts the process in main and enters the command there', async () => {
  const h = bridge({ windowOpen: false });
  const result = await h.execute({ action: 'run', session_id: 's1', command: 'echo hi' });
  // No pane was needed: the process exists, in the session's directory, and holds the command.
  assert.deepEqual(h.daemon.calls.find((call) => call[0] === 'termEnsure'), ['termEnsure', 'session-terminal:s1', '/work', null]);
  assert.deepEqual(h.daemon.terminals.get('session-terminal:s1').written, ['echo hi\r']);
  assert.deepEqual(result, { id: 'session-terminal:s1', tab: 1, shell: 'sh', running: true, cwd: '/work', cursor: 5, shown: false });
});

test('a failed run reveals nothing, so no empty tab opens', async () => {
  const daemon = fakeDaemon();
  daemon.invoke = async (name) => {
    if (name === 'termEnsure') throw new Error('spawn failed');
    return [];
  };
  const h = bridge({ daemon });
  await assert.rejects(h.execute({ action: 'run', session_id: 's1', command: 'echo hi' }), /spawn failed/);
  assert.deepEqual(h.requests, []);
});

test('the result says shown only when a pane claims the reveal', async () => {
  const shown = await bridge({ claimShown: true }).execute({ action: 'run', session_id: 's1', command: 'ls' });
  assert.equal(shown.shown, true);
  const hidden = await bridge({ claimShown: false }).execute({ action: 'run', session_id: 's1', command: 'ls' });
  assert.equal(hidden.shown, false);
});

test('a run targets the requested tab and reveals exactly that terminal with main\'s tab list', async () => {
  const daemon = fakeDaemon([tab(1, '/a'), tab(2, '/b')]);
  const h = bridge({ daemon, claimShown: true });
  const result = await h.execute({ action: 'run', session_id: 's1', tab: 2, command: 'pwd' });
  assert.equal(result.id, 'session-terminal:s1:2');
  assert.deepEqual(daemon.terminals.get('session-terminal:s1:2').written, ['pwd\r']);
  assert.deepEqual(daemon.terminals.get('session-terminal:s1').written, []);
  assert.equal(h.requests.length, 1);
  const { requestId, ...reveal } = h.requests[0];
  assert.ok(requestId);
  assert.deepEqual(reveal, {
    sessionId: 's1',
    terminalId: 'session-terminal:s1:2',
    tabs: [
      { id: 'session-terminal:s1', tab: 1, cwd: '/a' },
      { id: 'session-terminal:s1:2', tab: 2, cwd: '/b' },
    ],
  });
});

test('a run in a tab that does not exist fails without starting or revealing anything', async () => {
  const h = bridge({ daemon: fakeDaemon([tab(1)]) });
  await assert.rejects(h.execute({ action: 'run', session_id: 's1', tab: 5, command: 'ls' }), /no terminal tab 5/);
  assert.deepEqual(h.requests, []);
});

test('paired phones get the reveal without any path or ack id, while the desktop window keeps the full request', async () => {
  const secret = 'C:\\Users\\someone\\secret-project';
  const daemon = fakeDaemon([tab(1, secret), tab(2, `${secret}\\sub`)]);
  const toWindow = [];
  const toPhones = [];
  let runs;
  const dispatch = createTerminalRunDispatch({
    sendToWindow: (request) => (toWindow.push(request), queueMicrotask(() => runs.claim(request.requestId)), true),
    relay: (request) => toPhones.push(request),
  });
  runs = createTerminalRunRequests(dispatch);
  const execute = createTerminalCommandExecutor(
    createTerminalBridgeBackend({
      invoke: daemon.invoke,
      sessionCwd: async () => secret,
      reveal: (request) => runs.reveal(request, 1000),
    })
  );
  await execute({ action: 'run', session_id: 's1', tab: 2, command: 'pwd' });
  assert.equal(toWindow.length, 1);
  assert.equal(toWindow[0].tabs[1].cwd, `${secret}\\sub`, 'the desktop window still adopts each tab\'s root');
  assert.ok(toWindow[0].requestId);
  assert.deepEqual(toPhones, [
    {
      sessionId: 's1',
      terminalId: 'session-terminal:s1:2',
      tabs: [
        { id: 'session-terminal:s1', tab: 1 },
        { id: 'session-terminal:s1:2', tab: 2 },
      ],
    },
  ]);
  assert.equal(JSON.stringify(toPhones).includes('secret'), false);
});
