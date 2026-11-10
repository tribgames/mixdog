import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HEADLESS_MODEL_TOOL_NAMES,
  disallowedModelToolNamesForProfile,
  filterModelToolsForProfile,
  modelToolAllowedForProfile,
  modelToolSchemaAllowlist,
  sessionToolProfile,
} from './tool-profile.mjs';

test('the heartbeat profile allows only the session and setup tools and their loader', () => {
  assert.deepEqual(modelToolSchemaAllowlist('heartbeat'), ['session', 'setup', 'load_tool']);
  const tools = [
    'session',
    'setup',
    'load_tool',
    'read',
    'find',
    'grep',
    'code_graph',
    'shell',
    'edit',
    'browser',
    'web_search',
    'web_fetch',
    'media',
    'agent',
    'goal',
    'Skill',
    'memory',
    'mcp__demo__tool',
  ].map((name) => ({ name }));
  assert.deepEqual(
    filterModelToolsForProfile(tools, 'heartbeat').map((tool) => tool.name),
    ['session', 'setup', 'load_tool']
  );
  assert.deepEqual(
    disallowedModelToolNamesForProfile(tools, 'heartbeat'),
    tools.slice(3).map((tool) => tool.name)
  );
  assert.equal(modelToolAllowedForProfile('SETUP', 'heartbeat'), true);
});

test('a session created as a heartbeat run gets the heartbeat profile, whatever profile it asked for', () => {
  const heartbeat = { ownerAgentId: 'lead', sourceType: 'exec', sourceName: 'heartbeat' };
  assert.equal(sessionToolProfile({ sessionProfile: heartbeat }), 'heartbeat');
  assert.equal(sessionToolProfile({ toolProfile: 'interactive', sessionProfile: heartbeat }), 'heartbeat');
  assert.equal(sessionToolProfile({ toolProfile: 'headless', sessionProfile: heartbeat }), 'heartbeat');
  assert.equal(sessionToolProfile({ sessionProfile: { ownerAgentId: 'lead', sourceType: 'exec' } }), 'interactive');
  assert.equal(sessionToolProfile({ toolProfile: 'headless', sessionProfile: null }), 'headless');
  assert.equal(sessionToolProfile(), 'interactive');
});

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
    'github',
    'shell',
    'task',
    'load_tool',
    'web_search',
    'web_fetch',
    'office',
    'tidy',
  ]);
  assert.deepEqual(modelToolSchemaAllowlist('interactive'), null);
  assert.equal(Object.isFrozen(HEADLESS_MODEL_TOOL_NAMES), true);
});

test('headless tool profile filters unknown and stateful tools fail-closed', () => {
  const tools = [{ name: 'read' }, { name: 'office' }, { name: 'goal' }, { name: 'future_interactive_tool' }];
  assert.deepEqual(
    filterModelToolsForProfile(tools, 'headless').map((tool) => tool.name),
    ['read', 'office']
  );
  assert.equal(modelToolAllowedForProfile('READ', 'headless'), true);
  assert.equal(modelToolAllowedForProfile('goal', 'headless'), false);
  assert.equal(modelToolAllowedForProfile('future_interactive_tool', 'headless'), false);
  assert.equal(filterModelToolsForProfile(tools, 'interactive'), tools);
});
