import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionCommandsApi } from './commands.mjs';

test('cancelSide forwards the originating session id, and nothing without one', () => {
  const calls = [];
  const runtime = {
    cancelSide: (...args) => {
      calls.push(args);
    },
  };
  const api = createSessionCommandsApi({ runtime, set() {}, getState: () => ({}) });
  api.cancelSide('previous-session');
  api.cancelSide();
  api.cancelSide('');
  assert.deepEqual(calls, [['previous-session'], [], []]);
});
