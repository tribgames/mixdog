import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindChildLifecycle,
  createNativeSearchTransport,
} from './native-search-transport.mjs';

test('search transport stays unavailable until the verified child binary exists', () => {
  assert.equal(createNativeSearchTransport({ binaryPath: null, cwd: process.cwd() }), null);
});

test('child stdin failures are routed through the lifecycle error handler', () => {
  const errors = [];
  const listeners = {};
  const child = {
    on(name, handler) { listeners[name] = handler; },
    stdin: { on(name, handler) { listeners[`stdin:${name}`] = handler; } },
  };
  bindChildLifecycle(child, { onError: (error) => errors.push(error) });
  const expected = new Error('EPIPE');
  listeners['stdin:error'](expected);
  assert.deepEqual(errors, [expected]);
});
