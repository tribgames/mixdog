import assert from 'node:assert/strict';
import test from 'node:test';

import { createAbortController } from './abort-controller.mjs';
import { listenerLeakWarningLine } from './listener-leak-warning.mjs';

test('a listener-leak warning becomes one line naming the code that added the listener', async () => {
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on('warning', onWarning);
  try {
    const turn = createAbortController();
    function addsTurnListener() {
      turn.signal.addEventListener('abort', () => {}, { once: true });
    }
    for (let i = 0; i < 51; i++) addsTurnListener();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', onWarning);
  }
  const line = listenerLeakWarningLine(warnings.find((warning) => warning.name === 'MaxListenersExceededWarning'));
  assert.match(line, /^listener leak warning: MaxListenersExceededWarning: /);
  assert.match(line, /addsTurnListener/);
  assert.doesNotMatch(line, /\n/);
});

test('other warnings are not listener leaks', () => {
  assert.equal(listenerLeakWarningLine(Object.assign(new Error('old api'), { name: 'DeprecationWarning' })), null);
  assert.equal(listenerLeakWarningLine(new Error('plain')), null);
  assert.equal(listenerLeakWarningLine(undefined), null);
});
