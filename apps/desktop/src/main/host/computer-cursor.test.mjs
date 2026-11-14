import assert from 'node:assert/strict';
import test from 'node:test';
import { HOST_COMPUTER_CURSOR_PREPARE, registerComputerCursor } from './computer-cursor.ts';

function rig(prepare) {
  const handlers = new Map();
  registerComputerCursor({ handleRequest: (method, run) => handlers.set(method, run) }, prepare);
  return (params) => handlers.get(HOST_COMPUTER_CURSOR_PREPARE)(params, new AbortController().signal);
}

test('the arrow is prepared for the session within the 750 ms budget and its state is the answer', async () => {
  const asked = [];
  const ask = rig(async (id, budget) => {
    asked.push([id, budget]);
    return 'ready';
  });
  assert.deepEqual(await ask({ sessionThreadId: 'th1', windowId: 'hwnd:0x2', x: 1, y: 2 }), { state: 'ready' });
  assert.deepEqual(asked, [['th1', 750]]);
});

test('an unavailable or late arrow is answered, never refused', async () => {
  for (const state of ['unavailable', 'timeout']) {
    assert.deepEqual(await rig(async () => state)({ sessionThreadId: 'th1', x: 0, y: 0 }), { state });
  }
});

test('params without a session are refused', async () => {
  const ask = rig(async () => 'ready');
  await assert.rejects(ask({ x: 1, y: 1 }), /needs sessionThreadId/);
  await assert.rejects(ask({ sessionThreadId: '' }), /needs sessionThreadId/);
  await assert.rejects(ask(null), /expects an object/);
});
