import assert from 'node:assert/strict';
import test from 'node:test';

import { collectStandaloneToolDefs } from './tool-defs.mjs';

const named = (result) => result.standaloneTools.map((tool) => tool.name);

function collect(overrides = {}) {
  return collectStandaloneToolDefs({
    webSearchToolDefs: {
      TOOL_DEFS: [
        { name: 'web_search' },
        { name: 'image_fetch', public: false },
        { name: 'web_search_internal_helper' },
      ],
    },
    memoryToolDefs: { TOOL_DEFS: [{ name: 'memory' }, { name: 'recall' }, { name: 'memory_admin' }] },
    channelToolDefs: { TOOL_DEFS: [{ name: 'channel' }, { name: 'channel_admin' }] },
    codeGraphToolDefs: { CODE_GRAPH_TOOL_DEFS: [{ name: 'code_graph' }, { name: 'code_graph_debug' }] },
    browserToolDefs: [{ name: 'browser' }, { name: 'browser_devtools' }, { name: 'browser_internal' }],
    computerToolDefs: [{ name: 'computer' }],
    officeToolDefs: [{ name: 'office' }],
    mediaToolDefs: [{ name: 'media' }],
    setupToolDefs: [{ name: 'setup' }],
    goalTools: [{ name: 'get_goal' }],
    agentTools: [{ name: 'agent' }, { name: 'task' }],
    isChannelTool: (name) => name === 'channel',
    ...overrides,
  });
}

test('only admitted tool names from the optional modules reach the session surface', () => {
  const names = named(collect());

  assert.deepEqual(names, [
    'load_tool', 'Skill', 'cwd',
    'web_search',
    'memory', 'recall',
    'channel',
    'code_graph',
    'browser', 'browser_devtools',
    'computer',
    'office',
    'media',
    'setup',
    'get_goal',
    'agent', 'task',
  ]);
});

test('non-public web-search tools are callable internally but never advertised', () => {
  const result = collect();

  assert.equal(named(result).includes('image_fetch'), false);
  assert.equal(result.internalToolDefs.some((tool) => tool.name === 'image_fetch'), true);
  // The internal set is a superset: every model-facing tool stays callable.
  assert.deepEqual(
    result.internalToolDefs.slice(0, result.standaloneTools.length),
    result.standaloneTools,
  );
});

test('a missing optional tool-def module contributes nothing', () => {
  const names = named(collect({
    webSearchToolDefs: null,
    memoryToolDefs: null,
    channelToolDefs: null,
    codeGraphToolDefs: null,
  }));

  assert.deepEqual(names.filter((name) => (
    ['web_search', 'memory', 'recall', 'channel', 'code_graph'].includes(name)
  )), []);
  assert.equal(names.includes('load_tool'), true);
});

test('the skills gate removes the Skill tool and agent names track the live agent defs', () => {
  const result = collect({ skillToolEnabled: false });

  assert.equal(named(result).includes('Skill'), false);
  assert.deepEqual([...result.agentToolNames], ['agent', 'task']);
  assert.deepEqual([...collect({ agentTools: [] }).agentToolNames], []);
});
