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
