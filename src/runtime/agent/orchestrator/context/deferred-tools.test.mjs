import assert from 'node:assert/strict';
import test from 'node:test';
import { applyInitialDeferredToolManifestToBp2 } from './collect.mjs';
import { listedDeferredToolNames } from './deferred-tools.mjs';
import {
  CONNECTOR_TRIGGER_MAX_CHARS,
  CONNECTOR_TRIGGERS,
  connectorTrigger,
} from '../../../shared/connector-triggers.mjs';

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
    session.messages[1].content,
    [
      'BP2',
      '',
      '---',
      '',
      '<available-deferred-tools>',
      'Deferred tool names and selection triggers; schemas load on demand.',
      '- mcp__alpha: Alpha instructions. Keep this line.',
      '- mcp__beta: Beta instructions.',
      '- mcp__empty: Empty MCP server tools.',
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
  // A rewritten block is a fresh message (delta saves key on identity);
  // untouched blocks keep theirs.
  assert.equal(session.messages[0], bp1);
  assert.notEqual(session.messages[1], bp2);
  assert.equal(bp2.content, 'BP2');
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
    'BP2\n\n---\n\n<available-deferred-tools>\nDeferred tool names and selection triggers; schemas load on demand.\n- shell\n</available-deferred-tools>'
  );
});

test('deferred manifest prefers a tool trigger over its description', () => {
  const session = {
    messages: [
      { role: 'system', content: 'BP1' },
      { role: 'system', content: 'BP2' },
    ],
    deferredToolCatalog: [
      { name: 'web_search', trigger: 'Unfamiliar names; search first.', description: 'Cached web search.' },
      { name: 'mcp__docs__read', description: 'Read a remote document.' },
    ],
  };
  applyInitialDeferredToolManifestToBp2(session, ['web_search', 'mcp__docs__read']);
  const manifest = session.messages[1].content;
  assert.match(manifest, /^- web_search: Unfamiliar names; search first\.$/m);
  assert.match(manifest, /^- mcp__docs: Read a remote document$/m);
});

const mcpDef = (server, tool, description) => ({
  name: `mcp__${server}__${tool}`,
  description,
  inputSchema: { type: 'object', properties: {} },
});

test('MCP tools are listed once per server: curated, instruction, description and name triggers', () => {
  const catalog = [
    mcpDef('notion', 'search', 'Search the workspace.'),
    mcpDef('notion', 'create_page', 'Create a page.'),
    mcpDef('acme', 'deploy', 'Ignored when the server has instructions.'),
    mcpDef('tracker', 'zeta', 'Zeta tool. More text.'),
    mcpDef('tracker', 'alpha', `Alpha <tool> ${'x'.repeat(200)}. Second sentence.`),
    // A shortened name still groups under the server its definition names.
    { ...mcpDef('bare', 'x', ''), name: 'mcp__bare__x', mcpServerName: 'bare', mcpToolName: 'x' },
    { name: 'web_search', trigger: 'Unfamiliar names; search first.' },
  ];
  const session = {
    messages: [
      { role: 'system', content: 'BP1' },
      { role: 'system', content: 'BP2' },
    ],
    deferredToolCatalog: catalog,
    mcpServerInstructions: { acme: 'Acme deploy pipeline: ship builds to staging and production.' },
  };
  applyInitialDeferredToolManifestToBp2(
    session,
    catalog.map((tool) => tool.name)
  );
  const block = session.messages[1].content.match(/<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>/)[0];
  const lines = block.split('\n').slice(2, -1);
  assert.deepEqual(
    lines.map((line) => line.split(':')[0]),
    ['- mcp__acme', '- mcp__bare', '- mcp__notion', '- mcp__tracker', '- web_search']
  );
  assert.doesNotMatch(block, /mcp__\w+__\w+/);
  assert.match(block, /^- mcp__notion: Notion pages, databases and workspace search;/m);
  assert.match(block, /^- mcp__acme: Acme deploy pipeline: ship builds to staging and production\.$/m);
  assert.match(block, /^- mcp__bare: Bare MCP server tools\.$/m);
  const tracker = lines.find((line) => line.startsWith('- mcp__tracker: '));
  assert.match(tracker, /^- mcp__tracker: Alpha tool x+\.\.\.$/);
  assert.ok(tracker.length - '- mcp__tracker: '.length <= 100);
  assert.match(block, /^- web_search: Unfamiliar names; search first\.$/m);
});

test('the deferred manifest is byte-identical across sessions and pool orders', () => {
  const catalog = [
    mcpDef('notion', 'search', 'Search pages.'),
    mcpDef('notion', 'create_page', 'Open a page.'),
    mcpDef('custom', 'run', 'Run a job.'),
    { name: 'shell', description: 'Run commands.' },
  ];
  const build = (pool, extra) => {
    const session = {
      messages: [
        { role: 'system', content: 'BP1' },
        { role: 'system', content: 'BP2' },
      ],
      deferredToolCatalog: structuredClone(catalog),
      mcpServerInstructions: {},
      ...extra,
    };
    applyInitialDeferredToolManifestToBp2(session, pool);
    return session.messages[1].content;
  };
  const names = catalog.map((tool) => tool.name);
  const first = build(names, { id: 'one', agentId: 'alpha', cwd: '/a' });
  const second = build([...names].reverse(), { id: 'two', agentId: 'beta', cwd: '/b' });
  assert.equal(first, second);
  assert.match(first, /^- mcp__notion: Notion pages/m);
  assert.match(first, /^- mcp__custom: Run a job$/m);
});

test('curated connector triggers are single English lines within 100 characters', () => {
  assert.equal(Object.keys(CONNECTOR_TRIGGERS).length, 17);
  for (const [id, line] of Object.entries(CONNECTOR_TRIGGERS)) {
    assert.ok(line.length <= CONNECTOR_TRIGGER_MAX_CHARS, `${id}: ${line.length}`);
    assert.match(line, /^[\x20-\x7e]+$/, id);
    assert.doesNotMatch(line, /[<>]/, id);
  }
  assert.equal(connectorTrigger('google_calendar'), CONNECTOR_TRIGGERS['google-calendar']);
  assert.equal(connectorTrigger('HuggingFace'), CONNECTOR_TRIGGERS['hugging-face']);
  assert.equal(connectorTrigger('my-server'), '');
});

test('listed names follow their server line', () => {
  const session = { deferredToolCatalog: [mcpDef('docs', 'read', 'Read.')] };
  const rendered = '<available-deferred-tools>\n- mcp__docs: Read.\n- shell\n</available-deferred-tools>';
  assert.deepEqual(listedDeferredToolNames(session, ['mcp__docs__read', 'mcp__other__x', 'shell'], rendered), [
    'mcp__docs__read',
    'shell',
  ]);
});
