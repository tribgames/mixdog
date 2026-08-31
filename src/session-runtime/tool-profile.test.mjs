import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HEADLESS_MODEL_TOOL_NAMES,
  filterModelToolsForProfile,
  modelToolAllowedForProfile,
  modelToolSchemaAllowlist,
} from './tool-profile.mjs';

test('headless tool profile is an explicit stable allowlist', () => {
  assert.deepEqual(modelToolSchemaAllowlist('headless'), [
    'find',
    'glob',
    'list',
    'grep',
    'code_graph',
    'read',
    'edit',
    'apply_patch',
    'git',
    'git_stage',
    'shell',
    'task',
    'load_tool',
    'web_search',
    'web_fetch',
    'office',
  ]);
  assert.deepEqual(modelToolSchemaAllowlist('interactive'), null);
  assert.equal(Object.isFrozen(HEADLESS_MODEL_TOOL_NAMES), true);
});

test('headless tool profile filters unknown and stateful tools fail-closed', () => {
  const tools = [
    { name: 'read' },
    { name: 'office' },
    { name: 'goal' },
    { name: 'future_interactive_tool' },
  ];
  assert.deepEqual(
    filterModelToolsForProfile(tools, 'headless').map((tool) => tool.name),
    ['read', 'office'],
  );
  assert.equal(modelToolAllowedForProfile('READ', 'headless'), true);
  assert.equal(modelToolAllowedForProfile('goal', 'headless'), false);
  assert.equal(modelToolAllowedForProfile('future_interactive_tool', 'headless'), false);
  assert.equal(filterModelToolsForProfile(tools, 'interactive'), tools);
});
