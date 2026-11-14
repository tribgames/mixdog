import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { registerTerminalIpc } from './ipc-terminal.ts';

function setup(withNotify) {
  const handlers = new Map();
  const notified = [];
  const dispose = registerTerminalIpc({
    window: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send() {} } },
    ipcMain: new EventEmitter(),
    handle: (channel, handler) => handlers.set(channel, handler),
    ...(withNotify ? { notify: (method, params) => notified.push([method, params]) } : {}),
    invokeDesktopOperation: async () => null,
  });
  return { claim: handlers.get('mixdog:terminal-run-claim'), notified, dispose };
}

test('a terminal run claim goes to the core once per call, with the id validated', () => {
  const { claim, notified, dispose } = setup(true);
  assert.equal(claim({}, 'run-1'), true);
  assert.deepEqual(notified, [['ui/terminalRun/claimed', { requestId: 'run-1' }]]);
  for (const bad of ['', 7, null, 'x'.repeat(129)]) assert.throws(() => claim({}, bad));
  assert.equal(notified.length, 1, 'an invalid id sends nothing');
  dispose();
});

test('without a protocol link the claim reports false and sends nothing', () => {
  const { claim, notified, dispose } = setup(false);
  assert.equal(claim({}, 'run-1'), false);
  assert.deepEqual(notified, []);
  dispose();
});

// Two windows on one host: the host fans each output and reset out to every window's listener, as the real one does.
function twoWindows() {
  const sent = { a: [], b: [] };
  const outputs = new Set();
  const resets = new Set();
  const holds = [];
  const terminals = {
    ensure: async (id) => ({ id: id ?? 'new', replay: '' }),
    attach: async (id) => (id === 'gone' ? null : { id, replay: '' }),
    write() {},
    resize() {},
    pauseOutput: (id, holder) => holds.push(['pause', id, holder]),
    resumeOutput: (id, holder) => holds.push(['resume', id, holder]),
    releaseHolder: (holder) => holds.push(['release', holder]),
    dispose() {},
    subscribe: (listener) => (outputs.add(listener), () => outputs.delete(listener)),
    subscribeReset: (listener) => (resets.add(listener), () => resets.delete(listener)),
  };
  const open = (name, wcId) => {
    const handlers = new Map();
    const dispose = registerTerminalIpc({
      window: { isDestroyed: () => false, webContents: { id: wcId, isDestroyed: () => false, send: (channel, event) => sent[name].push([channel, event]) } },
      ipcMain: new EventEmitter(),
      handle: (channel, handler) => handlers.set(channel, handler),
      terminals,
      invokeDesktopOperation: async () => null,
    });
    return { handlers, dispose };
  };
  return {
    sent,
    holds,
    open,
    output: (event) => outputs.forEach((listener) => listener(event)),
    reset: (event) => resets.forEach((listener) => listener(event)),
  };
}

test('a window is sent the output and reset of the tabs it showed, and of no other', async () => {
  const rig = twoWindows();
  const a = rig.open('a', 1);
  const b = rig.open('b', 2);
  await a.handlers.get('mixdog:term-ensure')({}, 't1', null, null);
  await b.handlers.get('mixdog:term-attach')({}, 't2');
  assert.equal(await b.handlers.get('mixdog:term-attach')({}, 'gone'), null);
  rig.output({ id: 't1', data: 'one' });
  rig.output({ id: 't2', data: 'two' });
  rig.output({ id: 'gone', data: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  rig.reset({ id: 't2', replay: 'SCREEN' });
  rig.reset({ id: 't1', replay: 'OTHER' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const data = (list) => list.map(([, event]) => event);
  assert.deepEqual(data(rig.sent.a), [{ id: 't1', data: 'one' }, { id: 't1', data: 'OTHER', reset: true }]);
  assert.deepEqual(data(rig.sent.b), [{ id: 't2', data: 'two' }, { id: 't2', data: 'SCREEN', reset: true }]);
  // A disposed tab is no longer shown.
  a.handlers.get('mixdog:term-dispose')({}, 't1');
  rig.output({ id: 't1', data: 'late' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(rig.sent.a.length, 2);
  a.dispose();
  b.dispose();
});

test('a window that is torn down releases its holds under its own holder id', () => {
  const rig = twoWindows();
  const a = rig.open('a', 7);
  a.dispose();
  assert.deepEqual(rig.holds.at(-1), ['release', 'wc:7']);
});
