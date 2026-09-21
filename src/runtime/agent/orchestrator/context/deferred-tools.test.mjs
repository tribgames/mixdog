import assert from 'node:assert/strict';
import test from 'node:test';
import { applyInitialDeferredToolManifestToBp2 } from './collect.mjs';

test('MCP instructions are sorted, unique per deferred server, and confined to BP2', () => {
  const bp1 = { role: 'system', content: 'BP1' };
  const bp2 = { role: 'system', content: 'BP2' };
  const bp3 = { role: 'system', content: 'BP3', cacheTier: 'tier3' };
  const session = {
    messages: [bp1, bp2, bp3],
    mcpServerInstructions: {
      alpha: '  Alpha <instructions>.\nKeep this line.  ',
      beta: 'Beta instructions.',
      empty: ' <> ',
      missing: 'Not in the deferred pool.',
    },
  };

  assert.equal(
    applyInitialDeferredToolManifestToBp2(session, [
      'mcp__beta__read',
      'mcp__alpha__write',
      'mcp__alpha__read',
      'mcp__alpha__read',
      'mcp__empty__read',
      'mcp__bad name__read',
      '<invalid>',
      'shell',
    ]),
    true
  );
  assert.equal(
    bp2.content,
    [
      'BP2',
      '',
      '---',
      '',
      '<available-deferred-tools>',
      'Deferred tool names and purposes; schemas load on demand.',
      '- mcp__alpha__read',
      '- mcp__alpha__write',
      '- mcp__beta__read',
      '- mcp__empty__read',
      '- shell',
      '</available-deferred-tools>',
      '',
      '<mcp-instructions>',
      '## alpha',
      'Alpha instructions.',
      'Keep this line.',
      '## beta',
      'Beta instructions.',
      '</mcp-instructions>',
    ].join('\n')
  );
  assert.equal(session.messages[0], bp1);
  assert.equal(session.messages[1], bp2);
  assert.equal(session.messages[2], bp3);
  assert.equal(bp1.content, 'BP1');
  assert.equal(bp3.content, 'BP3');
});

test('MCP instruction caps and omission survive manifest rebuilds', () => {
  const session = {
    messages: [
      { role: 'system', content: 'BP1' },
      { role: 'system', content: 'BP2' },
    ],
    mcpServerInstructions: { alpha: 'a'.repeat(601) },
  };
  applyInitialDeferredToolManifestToBp2(session, ['mcp__alpha__read']);
  assert.ok(
    session.messages[1].content.endsWith(`<mcp-instructions>\n## alpha\n${'a'.repeat(597)}...\n</mcp-instructions>`)
  );
  const applied = session.messages[1].content;
  assert.equal(applyInitialDeferredToolManifestToBp2(session, ['shell'], { rebuild: 'true' }), false);
  assert.equal(session.messages[1].content, applied);
  assert.equal(applyInitialDeferredToolManifestToBp2(session, ['shell'], { rebuild: true }), true);
  assert.equal(
    session.messages[1].content,
    'BP2\n\n---\n\n<available-deferred-tools>\nDeferred tool names and purposes; schemas load on demand.\n- shell\n</available-deferred-tools>'
  );
});
