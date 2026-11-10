import assert from 'node:assert/strict';
import test from 'node:test';

import { providerSafeMcpToolName } from './client-config.mjs';
import { applyInitialDeferredToolManifestToBp2, buildSkillToolEnvelope } from '../context/collect.mjs';
import { applyDeferredToolSurface } from '../runtime-core/tool-catalog.mjs';
import { loadSkillToolDependencies } from '../runtime-core/skill-tool-loading.mjs';
import { filterMcpToolsForCwd } from '../runtime-core/extension-scopes.mjs';
import { isEditProgressTool } from '../session/loop/completion-guards.mjs';
import {
  displayToolSearchTarget,
  isMcpToolName,
  parseMcpToolName,
  stripToolPrefix,
} from '../../../shared/tool-primitives.mjs';
import { mcpServerNameOfTool } from '../../../shared/extension-scopes.mjs';

// A server whose name is too long to keep in a shortened tool name: the name's
// server part no longer matches it, so only metadata can tell the server.
const SERVER = 'plugin-very-long-documentation-server-name-x';
// Hand-made shortened names, so these paths cannot lean on the in-process record.
const SHORT = 'mcp__plugin-very-long-docu__list_all_pages_0a1b2c3d';
const SHORT_EDIT = 'mcp__plugin-very-long-docu__apply_patch_4e5f6a7b';
const tool = (name, leaf) => ({
  name,
  mcpServerName: SERVER,
  mcpToolName: leaf,
  description: `${leaf} tool`,
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
});

test('primitives read a shortened tool from metadata, or from the name record of this process', () => {
  const defined = tool(SHORT, 'list_all_available_documentation_pages');
  assert.deepEqual(parseMcpToolName(defined), { server: SERVER, tool: 'list_all_available_documentation_pages' });
  assert.equal(mcpServerNameOfTool(defined), SERVER);
  // Without metadata the old form still parses.
  assert.deepEqual(parseMcpToolName('mcp__ctx__resolve'), { server: 'ctx', tool: 'resolve' });
  assert.equal(mcpServerNameOfTool({ name: 'mcp__ctx__resolve' }), 'ctx');

  // A name built here (shortened) resolves by name alone too.
  const built = providerSafeMcpToolName(SERVER, 'list_all_available_documentation_pages');
  assert.notEqual(built, `mcp__${SERVER}__list_all_available_documentation_pages`);
  assert.deepEqual(parseMcpToolName(built), { server: SERVER, tool: 'list_all_available_documentation_pages' });
  assert.equal(stripToolPrefix(built), 'list_all_available_documentation_pages');
  assert.equal(isMcpToolName(built), true);
  assert.equal(displayToolSearchTarget(built), `${SERVER}.list_all_available_documentation_pages`);
  assert.equal(mcpServerNameOfTool(built), SERVER);
  // The guard sees the real tool name, not the hash tail of the shortened one.
  const builtMeta = providerSafeMcpToolName('docs.server', 'load_tool');
  assert.notEqual(builtMeta, 'mcp__docs.server__load_tool');
  assert.equal(isEditProgressTool(builtMeta, false), false);
});

test('scope filtering keys a shortened tool by its real server', () => {
  const scopes = { mcp: { [SERVER]: ['/nowhere'] } };
  assert.deepEqual(filterMcpToolsForCwd([tool(SHORT, 'list')], scopes, '/work'), []);
  assert.equal(filterMcpToolsForCwd([tool(SHORT, 'list')], { mcp: {} }, '/work').length, 1);
});

test('deferred listing attributes a shortened tool to its server line; instruction bodies stay out of BP2', () => {
  const session = {
    messages: [
      { role: 'system', content: 'BP1', cacheTier: 'tier1' },
      { role: 'system', content: 'BP2', cacheTier: 'tier2' },
    ],
    mcpServerInstructions: { [SERVER]: 'Use the docs server for pages.' },
    deferredToolCatalog: [tool(SHORT, 'list_all_available_documentation_pages')],
  };
  applyInitialDeferredToolManifestToBp2(session, [SHORT]);
  const bp2 = session.messages[1].content;
  assert.doesNotMatch(bp2, /## |mcp-instructions/);
  assert.match(bp2, new RegExp(`^- mcp__${SERVER}: Use the docs server for pages$`, 'm'));
  assert.doesNotMatch(bp2, new RegExp(SHORT));
});

test('a skill dependency of type mcp loads the shortened tools of that server', () => {
  const skill = { name: 'Skill', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } };
  const current = {
    provider: 'openai-oauth',
    tools: [skill, tool(SHORT, 'list_all_available_documentation_pages'), tool(SHORT_EDIT, 'apply_patch')],
    messages: [],
    toolSpec: 'full',
  };
  applyDeferredToolSurface(current, 'full');
  const loaded = loadSkillToolDependencies(
    buildSkillToolEnvelope('docs', '# Docs', '/skills/docs', {
      toolDependencies: [{ type: 'mcp', value: SERVER }],
    }),
    current
  );
  assert.ok(current.deferredCallableTools.includes(SHORT));
  assert.ok(current.deferredCallableTools.includes(SHORT_EDIT));
  assert.doesNotMatch(loaded.result, /no available connected tools/);
});
