import test from 'node:test';
import assert from 'node:assert/strict';

import { installViewportGuard } from './viewport-guard';

function fakeWindow({ inner, content }) {
  const state = {
    inner,
    commands: [],
    bounds: [],
    windowListeners: new Map(),
    contentsListeners: new Map(),
    attached: false,
  };
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: content[0], height: content[1] }),
    getBounds: () => ({ x: 10, y: 10, width: content[0], height: content[1] + 40 }),
    setBounds: (next) => state.bounds.push(next),
    on: (event, callback) => {
      state.windowListeners.set(event, callback);
      return window;
    },
    webContents: {
      executeJavaScript: async () => state.inner,
      getZoomFactor: () => 1,
      on: (event, callback) => {
        state.contentsListeners.set(event, callback);
      },
      debugger: {
        isAttached: () => state.attached,
        attach: () => { state.attached = true; },
        detach: () => { state.attached = false; },
        sendCommand: async (method) => { state.commands.push(method); },
      },
    },
  };
  return { window, state };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('viewport guard clears a stray device-metrics override and nudges a relayout', async () => {
  const { window, state } = fakeWindow({ inner: [800, 600], content: [1900, 1100] });
  installViewportGuard(window);
  // CHECK_DELAY_MS (1.2s) + RECHECK_DELAY_MS (0.4s) + slack.
  await wait(2_400);
  state.windowListeners.get('closed')?.();
  assert.deepEqual(state.commands, ['Emulation.clearDeviceMetricsOverride'],
    'a persistent renderer/native size mismatch must clear the emulation override');
  assert.equal(state.bounds.length, 2, 'the repair must nudge a native resize (shrink + restore)');
  assert.equal(state.attached, false, 'the temporary debugger session must detach after the repair');
});

test('viewport guard leaves a healthy window alone', async () => {
  const { window, state } = fakeWindow({ inner: [1900, 1100], content: [1900, 1100] });
  installViewportGuard(window);
  await wait(2_400);
  state.windowListeners.get('closed')?.();
  assert.deepEqual(state.commands, [], 'matching sizes must never trigger a repair');
  assert.deepEqual(state.bounds, []);
});

test('viewport guard keeps a heartbeat so an eventless override still heals', async () => {
  const { window, state } = fakeWindow({ inner: [1900, 1100], content: [1900, 1100] });
  installViewportGuard(window);
  await wait(2_000);
  // Override arrives LATER with no native window event at all.
  state.inner = [800, 600];
  await wait(11_500);
  state.windowListeners.get('closed')?.();
  assert.deepEqual(state.commands, ['Emulation.clearDeviceMetricsOverride'],
    'the 10s heartbeat must catch an override that fired no window event');
});
