import assert from 'node:assert/strict';
import test from 'node:test';

import { viewIsStale } from './remote-view-staleness.ts';

const user = (id, device) => ({ id, kind: 'user', device });

test('a view missing another device\'s prompt is stale', () => {
  const held = [user('u1', 'Main PC')];
  const latest = [user('u1', 'Main PC'), user('u2', 'Main PC')];
  assert.equal(viewIsStale(held, latest, 'Pixel'), true);
});

test('a prompt from the same device is not stale, nor is anything the view already holds', () => {
  assert.equal(viewIsStale([user('u1', 'Pixel')], [user('u1', 'Pixel'), user('u2', 'Pixel')], 'Pixel'), false);
  assert.equal(viewIsStale([user('u1', 'Main PC')], [user('u1', 'Main PC')], 'Pixel'), false);
});

test('streaming rows and unattributed prompts never make a view stale', () => {
  const held = [user('u1', 'Pixel')];
  const latest = [user('u1', 'Pixel'), { id: 'a1', kind: 'assistant' }, { id: 'u2', kind: 'user' }];
  assert.equal(viewIsStale(held, latest, 'Pixel'), false);
});

test('a connection that holds no rows has no view to be stale', () => {
  assert.equal(viewIsStale(null, [user('u1', 'Main PC')], 'Pixel'), false);
  assert.equal(viewIsStale([], null, 'Pixel'), false);
});
