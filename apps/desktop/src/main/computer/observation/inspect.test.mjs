import assert from 'node:assert/strict';
import test from 'node:test';
import { createInspection } from './inspect.ts';

function inspection(result) {
  return createInspection({
    callPowerShell: async () => ({ ok: true, result }),
    sessionIdFor: () => 'test',
    assertExecutionNotAborted() {},
    readComputerWindows: async () => [],
    readDisplays: () => [],
    isObserveOnly: () => false,
  });
}

test('verification propagates provider coverage instead of treating missing text as absence', async () => {
  for (const [elements, text_complete, expected] of [
    [[], true, 'unknown'],
    [[{ name: 'ready' }], undefined, 'unknown'],
    [[{ name: 'ready' }], false, 'unknown'],
    [[{ name: 'ready' }], true, 'satisfied'],
    [[{ name: 'error' }], false, 'unsatisfied'],
  ]) {
    const result = JSON.parse((await inspection({
      exists: true, elements, text_complete,
    }).verifyWindowState({
      action: 'verify', window_id: 'hwnd:0x1', expect: [{ absent: 'error' }],
      timeout_ms: 0, stable_samples: 1,
    })).text);
    assert.equal(result.decision, expected);
    assert.equal(result.ok, expected === 'satisfied');
  }
});
