import test from 'node:test';
import assert from 'node:assert/strict';

import { linkOpenTarget } from './link-open-target.ts';

test('a web link opens in the pane only when a session pane can be revealed', () => {
  assert.equal(linkOpenTarget({ sessionId: 's1', paneAvailable: true }), 'pane');
  assert.equal(linkOpenTarget({ sessionId: 's1', paneAvailable: false }), 'external');
  assert.equal(linkOpenTarget({ sessionId: undefined, paneAvailable: true }), 'external');
  assert.equal(linkOpenTarget({ sessionId: '', paneAvailable: true }), 'external');
  assert.equal(linkOpenTarget({ sessionId: 'new-task', paneAvailable: true }), 'external');
  assert.equal(linkOpenTarget({ sessionId: 's1', paneAvailable: true, external: true }), 'external');
  assert.equal(linkOpenTarget({ sessionId: 's1', paneAvailable: true, external: false }), 'pane');
});
