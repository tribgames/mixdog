import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _registerMcpServerForTest,
  disconnectAll,
  executeMcpTool,
  getMcpServerStatus,
  getMcpTools,
} from './client.mjs';

test('resources and prompts become callable MCP feature tools', async () => {
  const scopeId = 'mcp-features-test';
  const calls = [];
  _registerMcpServerForTest(scopeId, 'catalog', [], {
    capabilities: {
      resources: {},
      prompts: {},
    },
    client: {
      listResources: async (params) => {
        calls.push(['listResources', params]);
        return { resources: [{ uri: 'file:///guide.md', name: 'Guide' }] };
      },
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      readResource: async ({ uri }) => ({ contents: [{ uri, text: '# Guide' }] }),
      listPrompts: async () => ({ prompts: [{ name: 'review' }] }),
      getPrompt: async ({ name, arguments: args }) => ({
        description: 'Review prompt',
        messages: [{ role: 'user', content: { type: 'text', text: `${name}:${args.depth}` } }],
      }),
    },
  });
  try {
    const names = getMcpTools(scopeId).map((tool) => tool.name);
    assert.deepEqual(names, [
      'mcp__catalog__mixdog_list_resources',
      'mcp__catalog__mixdog_list_resource_templates',
      'mcp__catalog__mixdog_read_resource',
      'mcp__catalog__mixdog_list_prompts',
      'mcp__catalog__mixdog_get_prompt',
    ]);
    assert.deepEqual(getMcpServerStatus(scopeId)[0]?.capabilities, {
      tools: false,
      prompts: true,
      resources: true,
    });

    const resources = await executeMcpTool(
      'mcp__catalog__mixdog_list_resources',
      { cursor: 'next-page' },
      { scopeId },
    );
    assert.match(resources, /file:\/\/\/guide\.md/);
    assert.deepEqual(calls, [['listResources', { cursor: 'next-page' }]]);

    const prompt = await executeMcpTool(
      'mcp__catalog__mixdog_get_prompt',
      { name: 'review', arguments: { depth: 'deep' } },
      { scopeId },
    );
    assert.match(prompt, /review:deep/);
  } finally {
    await disconnectAll({ scopeId });
  }
});
