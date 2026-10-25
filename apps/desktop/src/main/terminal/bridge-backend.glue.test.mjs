import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalBridgeBackend } from './bridge-backend.ts';

const first = (cwd = null) => ({ tab: 1, id: 'session-terminal:s1', shell: 'sh', running: true, cwd });

function harness({ tabsAfterStart = [first('/work')], cwd = '/work' } = {}) {
  const calls = [];
  const reveals = [];
  let started = false;
  const backend = createTerminalBridgeBackend({
    invoke: async (name, args) => {
      calls.push([name, args]);
      if (name === 'termEnsure') started = true;
      if (name === 'termSessionTabs') return started ? tabsAfterStart : [];
      if (name === 'termSnapshot') return { text: 't', cursor: 1, reset: false };
      return undefined;
    },
    sessionCwd: async () => cwd,
    reveal: async (request) => {
      reveals.push(request);
      return true;
    },
  });
  return { backend, calls, reveals };
}

test('write, sessionTabs and snapshot map to the daemon operations', async () => {
  const { backend, calls } = harness();
  await backend.write('session-terminal:s1', 'ls\r');
  assert.deepEqual(await backend.sessionTabs('s1'), []);
  assert.deepEqual(await backend.snapshot('id'), { text: 't', cursor: 1, reset: false });
  await backend.snapshot('id', 0);
  assert.deepEqual(calls, [
    ['termWrite', ['session-terminal:s1', 'ls\r']],
    ['termSessionTabs', ['s1']],
    ['termSnapshot', ['id']],
    ['termSnapshot', ['id', 0]],
  ]);
});

test('startTerminal ensures the first terminal at the session cwd and returns its tab', async () => {
  const { backend, calls } = harness();
  assert.deepEqual(await backend.startTerminal('s1'), first('/work'));
  assert.deepEqual(calls[0], ['termEnsure', ['session-terminal:s1', '/work', null]]);
});

test('startTerminal passes a null session cwd through', async () => {
  const { backend, calls } = harness({ cwd: null, tabsAfterStart: [first(null)] });
  assert.deepEqual(await backend.startTerminal('s1'), first(null));
  assert.deepEqual(calls[0], ['termEnsure', ['session-terminal:s1', null, null]]);
});

test('startTerminal throws "did not start" when the first tab never appears', async () => {
  const other = { ...first(), id: 'session-terminal:s1:2', tab: 2 };
  const { backend } = harness({ tabsAfterStart: [other] });
  await assert.rejects(backend.startTerminal('s1'), /the terminal did not start/);
});

test('revealTerminal sends only id, tab and cwd of each tab', async () => {
  const { backend, reveals } = harness();
  const tabs = [first('/a'), { ...first('/b'), id: 'session-terminal:s1:2', tab: 2, running: false }];
  assert.equal(await backend.revealTerminal('s1', tabs[1], tabs), true);
  assert.deepEqual(reveals, [
    {
      sessionId: 's1',
      terminalId: 'session-terminal:s1:2',
      tabs: [
        { id: 'session-terminal:s1', tab: 1, cwd: '/a' },
        { id: 'session-terminal:s1:2', tab: 2, cwd: '/b' },
      ],
    },
  ]);
});
