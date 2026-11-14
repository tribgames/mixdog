import assert from 'node:assert/strict';
import test from 'node:test';
import { registerComputerUseInternalWindow } from '../computer/overlay/internal-windows.ts';
import { registerComputerInternalWindows } from './computer-internal-windows.ts';

function handler() {
  const handlers = new Map();
  registerComputerInternalWindows({ handleRequest: (method, run) => handlers.set(method, run) });
  return handlers.get('host/computer/internalWindows');
}

test('the handler answers the registered windows as hwnd ids, and none once they are unregistered', async () => {
  const ask = handler();
  const before = (await ask({}, new AbortController().signal)).windowIds.length;
  const unregister = registerComputerUseInternalWindow({ getNativeWindowHandle: () => Buffer.from([0xab, 0x01, 0, 0, 0, 0, 0, 0]) });
  assert.deepEqual((await ask({}, new AbortController().signal)).windowIds.slice(before), ['hwnd:0x1ab']);
  unregister();
  assert.equal((await ask({}, new AbortController().signal)).windowIds.length, before);
});
