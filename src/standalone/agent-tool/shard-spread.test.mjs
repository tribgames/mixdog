import assert from 'node:assert/strict';
import test from 'node:test';

import { remoteTurnHandoffReady } from './shard-spread.mjs';

test('remote turn waits through the turndone-to-save gap for assistant content', () => {
  assert.equal(remoteTurnHandoffReady({
    turnEnded: true,
    elapsedMs: 100,
    content: '',
  }), false);
  assert.equal(remoteTurnHandoffReady({
    grew: true,
    elapsedMs: 100,
    content: '',
  }), false);
  assert.equal(remoteTurnHandoffReady({
    turnEnded: true,
    elapsedMs: 200,
    content: 'worker handoff',
  }), true);
  assert.equal(remoteTurnHandoffReady({
    turnEnded: true,
    elapsedMs: 15_001,
    content: '',
  }), true);
});
