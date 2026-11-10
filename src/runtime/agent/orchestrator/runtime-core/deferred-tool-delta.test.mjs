import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acknowledgePendingDeferredToolDelta,
  mergePendingDeferredToolDelta,
  snapshotPendingDeferredToolDelta,
} from './deferred-tool-delta.mjs';

test('deferred tool delta coalesces inverse changes before delivery', () => {
  const session = {};
  mergePendingDeferredToolDelta(session, {
    added: [{ name: 'mcp__demo__one', description: ' First <tool>  ' }],
  });
  mergePendingDeferredToolDelta(session, {
    added: [{ name: 'mcp__demo__two', description: 'Second tool' }],
    removed: ['mcp__demo__one'],
  });

  const snapshot = snapshotPendingDeferredToolDelta(session);
  assert.deepEqual(snapshot.added, [
    {
      name: 'mcp__demo__two',
      description: 'Second tool',
    },
  ]);
  assert.deepEqual(snapshot.removed, []);
  assert.match(snapshot.content, /<deferred_tools_delta>/);
  assert.match(snapshot.content, /^- mcp__demo: Second tool$/m);
  assert.doesNotMatch(snapshot.content, /mcp__demo__one|mcp__demo__two/);
});

const mcpTool = (server, tool, description = '') => ({ name: `mcp__${server}__${tool}`, description });

test('deferred tool delta renders one line per MCP server and keeps the tool-level sets exact', () => {
  const session = {
    deferredToolCatalog: [mcpTool('gmail', 'send'), mcpTool('gmail', 'read'), mcpTool('docs', 'page')],
    deferredLateToolCatalog: [mcpTool('late', 'lookup')],
    deferredMcpToolNames: ['mcp__gmail__send', 'mcp__late__lookup'],
    mcpServerInstructions: { late: 'Look things up for the user. More text.' },
  };
  mergePendingDeferredToolDelta(session, {
    added: [
      { name: 'mcp__gmail__send', description: 'Send.' },
      { name: 'mcp__gmail__read', description: 'Read.' },
      { name: 'mcp__late__lookup', description: 'Look.' },
      { name: 'web_fetch', description: 'Fetch a page.' },
    ],
    removed: [
      { name: 'mcp__docs__page', server: 'docs' },
      { name: 'mcp__gone__a', server: 'gone' },
      { name: 'mcp__gone__b', server: 'gone' },
      'old_tool',
    ],
  });
  const snapshot = snapshotPendingDeferredToolDelta(session);
  // Exact tool-level sets stay for acknowledgement and reconciliation.
  assert.deepEqual(
    snapshot.added.map((entry) => entry.name),
    ['mcp__gmail__read', 'mcp__gmail__send', 'mcp__late__lookup', 'web_fetch']
  );
  assert.deepEqual(snapshot.removed, ['mcp__docs__page', 'mcp__gone__a', 'mcp__gone__b', 'old_tool']);
  assert.equal(
    snapshot.content,
    [
      '<system-reminder>',
      '<deferred_tools_delta>',
      'Added deferred tools:',
      '- mcp__gmail: Gmail email: sending, reading, searching or organizing mail.',
      '- mcp__late: Look things up for the user',
      '- web_fetch: Fetch a page.',
      'Removed deferred tools:',
      '- mcp__docs',
      '- mcp__gone',
      '- old_tool',
      '</deferred_tools_delta>',
      '</system-reminder>',
    ].join('\n')
  );
});

test('deferred tool delta does not claim a server vanished while it still has tools', () => {
  const session = {
    deferredToolCatalog: [mcpTool('docs', 'keep')],
    deferredMcpToolNames: ['mcp__docs__keep'],
  };
  mergePendingDeferredToolDelta(session, {
    removed: [
      { name: 'mcp__docs__a', server: 'docs' },
      { name: 'mcp__docs__b', server: 'docs' },
    ],
  });
  const { content, removed } = snapshotPendingDeferredToolDelta(session);
  assert.match(content, /^- mcp__docs: 2 tools removed$/m);
  assert.doesNotMatch(content, /^- mcp__docs$/m);
  assert.deepEqual(removed, ['mcp__docs__a', 'mcp__docs__b']);
  // Without a known connected set nothing is claimed gone either.
  delete session.deferredMcpToolNames;
  assert.match(snapshotPendingDeferredToolDelta(session).content, /^- mcp__docs: 2 tools removed$/m);
  // A re-added tool cancels its pending removal (and its recorded server).
  mergePendingDeferredToolDelta(session, { added: [{ name: 'mcp__docs__a', description: 'A.' }] });
  assert.deepEqual(session.pendingDeferredToolDelta.removed, ['mcp__docs__b']);
  assert.deepEqual(session.pendingDeferredToolDelta.removedServers, { mcp__docs__b: 'docs' });
});

test('deferred tool delta clears only after matching provider-accepted revision', () => {
  const session = {};
  mergePendingDeferredToolDelta(session, { removed: ['mcp__demo__gone'] });
  const snapshot = snapshotPendingDeferredToolDelta(session);

  assert.equal(acknowledgePendingDeferredToolDelta(session, snapshot.revision + 1), false);
  assert.ok(session.pendingDeferredToolDelta);
  assert.equal(acknowledgePendingDeferredToolDelta(session, snapshot.revision), true);
  assert.equal(snapshotPendingDeferredToolDelta(session), null);
});
