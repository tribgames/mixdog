import assert from 'node:assert/strict';
import test from 'node:test';
import {
  _hasSessionWriteControl,
  acquireWriteCommit,
  guardedSaveOptions,
  releaseSessionWriteControl,
  releaseWriteCommit,
} from './write-guards.mjs';

test('write control is created per id and removed on release', () => {
  guardedSaveOptions('wg-a', {});
  assert.equal(_hasSessionWriteControl('wg-a'), true);
  assert.equal(releaseSessionWriteControl('wg-a'), true);
  assert.equal(_hasSessionWriteControl('wg-a'), false);
  assert.equal(releaseSessionWriteControl('wg-a'), false);
});

test('a control whose commit lock is held survives release', () => {
  const opts = guardedSaveOptions('wg-b', {});
  const held = acquireWriteCommit(opts);
  assert.equal(releaseSessionWriteControl('wg-b'), false);
  releaseWriteCommit(held);
  assert.equal(releaseSessionWriteControl('wg-b'), true);
});
