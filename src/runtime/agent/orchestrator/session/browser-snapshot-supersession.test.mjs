import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_SNAPSHOT_SUPERSEDED,
  supersedeBrowserSnapshots,
} from './browser-snapshot-supersession.mjs';

const snapshot = (page, generation, suffix = '') => ({
  role: 'tool',
  toolCallId: `${page}-${generation}`,
  content: `UNTRUSTED PAGE CONTENT\nSnapshot: ${page}-s${generation}\n${'x'.repeat(200)}${suffix}`,
});

test('browser snapshot supersession keeps only the newest state for each page', () => {
  const messages = [
    { role: 'user', content: 'browse' },
    snapshot('p1', 1),
    snapshot('p2', 1),
    snapshot('p1', 2),
    snapshot('p2', 2),
  ];
  const result = supersedeBrowserSnapshots(messages);
  assert.equal(result.replaced, 2);
  assert.ok(result.savedBytes > 0);
  assert.equal(result.messages[1].content.startsWith(BROWSER_SNAPSHOT_SUPERSEDED), true);
  assert.match(result.messages[2].content, /p2/);
  assert.equal(result.messages[3], messages[3]);
  assert.equal(result.messages[4], messages[4]);
  assert.equal(messages[1].content.includes('x'.repeat(200)), true, 'stored history remains lossless');
});

test('browser snapshot supersession supports text parts and ignores unrelated tools', () => {
  const oldSnapshot = {
    role: 'tool',
    toolCallId: 'old',
    content: [{ type: 'text', text: 'Condition met.\n\nSnapshot: p3-s4\nold state' }],
  };
  const unrelated = { role: 'tool', toolCallId: 'read', content: 'Snapshot: not-a-browser-id' };
  const latest = snapshot('p3', 5);
  const result = supersedeBrowserSnapshots([oldSnapshot, unrelated, latest]);
  assert.equal(result.replaced, 1);
  assert.equal(result.messages[1], unrelated);
  assert.equal(result.messages[2], latest);
});

test('browser snapshot supersession removes stale observe screenshots with their text', () => {
  const oldObserve = {
    role: 'tool',
    toolCallId: 'observe-old',
    content: {
      content: [
        { type: 'text', text: 'Snapshot: p8-s1\nold visual state' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc' } },
      ],
    },
  };
  const latest = snapshot('p8', 2);
  const result = supersedeBrowserSnapshots([oldObserve, latest]);
  assert.equal(result.replaced, 1);
  assert.equal(typeof result.messages[0].content, 'string');
  assert.doesNotMatch(result.messages[0].content, /abc|old visual state/);
});

test('browser snapshot supersession does not rewrite another tool that mentions a browser-like id', () => {
  const messages = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'browser-old', name: 'browser', arguments: { action: 'snapshot' } },
        { id: 'other', name: 'read', arguments: {} },
        { id: 'browser-new', name: 'browser', arguments: { action: 'snapshot' } },
      ],
    },
    { ...snapshot('p9', 1), toolCallId: 'browser-old' },
    { role: 'tool', toolCallId: 'other', content: 'Snapshot: p9-s99\nunrelated evidence' },
    { ...snapshot('p9', 2), toolCallId: 'browser-new' },
  ];
  const result = supersedeBrowserSnapshots(messages);
  assert.equal(result.replaced, 1);
  assert.equal(result.messages[2], messages[2]);
});
