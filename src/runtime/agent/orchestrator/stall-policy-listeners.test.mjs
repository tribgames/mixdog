import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';

import { createAbortController } from '../../shared/abort-controller.mjs';
import { createPassthroughSignal, createTimeoutSignal } from './stall-policy.mjs';

test('sequential and parallel session scopes release every parent abort listener', () => {
  const parent = createAbortController(128);
  for (let index = 0; index < 75; index += 1) {
    const scope = createPassthroughSignal(parent.signal);
    assert.equal(getEventListeners(parent.signal, 'abort').length, 1);
    scope.cleanup();
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  }

  const scopes = Array.from({ length: 64 }, (_, index) =>
    createTimeoutSignal(parent.signal, 60_000, `parallel scope ${index}`)
  );
  assert.equal(getEventListeners(parent.signal, 'abort').length, scopes.length);
  for (const scope of scopes) scope.cleanup();
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});
