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

test('an empty handoff needs the runtime turndone marker, never elapsed time', () => {
  // No turndone: an accepted submit must keep waiting past any window — the
  // submitted user prompt itself grows the transcript, and a queued/prepping
  // turn can sit idle longer than any fixed settle.
  assert.equal(remoteTurnHandoffReady({
    elapsedMs: 60_000,
    content: '',
  }), false);
  assert.equal(remoteTurnHandoffReady({
    grew: true,
    elapsedMs: 15_001,
    content: '',
  }), false);
  assert.equal(remoteTurnHandoffReady({
    grew: true,
    elapsedMs: 60_000,
    content: '',
  }), false);
  // Content closes the turn on any completion signal.
  assert.equal(remoteTurnHandoffReady({
    grew: true,
    elapsedMs: 100,
    content: 'worker handoff',
  }), true);
});
