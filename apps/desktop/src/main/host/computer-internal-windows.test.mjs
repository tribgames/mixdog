import assert from 'node:assert/strict';
import test from 'node:test';
import { registerComputerUseInternalWindow } from '../computer/overlay/internal-windows.ts';
import { registerComputerInternalWindows } from './computer-internal-windows.ts';

function handler() {
  const handlers = new Map();
  registerComputerInternalWindows({ handleRequest: (method, run) => handlers.set(method, run) });
  return handlers.get('host/computer/internalWindows');
}

// The id is the platform's own: hwnd on Windows, x11 on Linux, cg (the CGWindowID of the media source) on macOS.
const expectedId = { win32: 'hwnd:0x1ab', darwin: 'cg:928' }[process.platform] ?? 'x11:0x1ab';

test('the handler answers the registered windows by their platform ids, and none once they are unregistered', async () => {
  const ask = handler();
  const before = (await ask({}, new AbortController().signal)).windowIds.length;
  const unregister = registerComputerUseInternalWindow({
    getNativeWindowHandle: () => Buffer.from([0xab, 0x01, 0, 0, 0, 0, 0, 0]),
    getMediaSourceId: () => 'window:928:0',
  });
  assert.deepEqual((await ask({}, new AbortController().signal)).windowIds.slice(before), [expectedId]);
  unregister();
  assert.equal((await ask({}, new AbortController().signal)).windowIds.length, before);
});
