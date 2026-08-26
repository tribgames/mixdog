import assert from 'node:assert/strict';
import test from 'node:test';

import {
  publishGlobalExtensionChange,
  subscribeGlobalExtensionChanges,
} from './global-extensions.mjs';

test('global extension changes fan out to every runtime except the writer', async () => {
  const events = [];
  const writer = subscribeGlobalExtensionChanges((kind) => events.push(['writer', kind]));
  const peer = subscribeGlobalExtensionChanges((kind) => events.push(['peer', kind]));
  try {
    await publishGlobalExtensionChange('mcp', writer.id);
    assert.deepEqual(events, [['peer', 'mcp']]);
  } finally {
    writer.unsubscribe();
    peer.unsubscribe();
  }
});

test('unsubscribed runtimes stop receiving global extension changes', async () => {
  const events = [];
  const runtime = subscribeGlobalExtensionChanges((kind) => events.push(kind));
  runtime.unsubscribe();
  await publishGlobalExtensionChange('skills');
  assert.deepEqual(events, []);
});
