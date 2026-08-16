import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { join } from 'node:path';
import { createToolSurface } from './tool-surface.mjs';
import { createToolPolicyRefresh } from './tool-policy-refresh.mjs';
import { toSessionWorkflowMeta, workflowDisallowsAgentTool } from './workflow.mjs';
import { PATCH_TOOL_DEFS } from '../runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import { DEFERRED_DEFAULT_LEAD_TOOLS } from './tool-catalog-data.mjs';

const require = createRequire(import.meta.url);
const { omitToolRoutes, buildSharedToolContent } = require('../lib/rules-builder.cjs');

const SAMPLE_ROUTES = [
  'path/name only→`find`;',
  'web/current→`search`; returned URL body→`web_fetch`;',
  'prior work→`recall` (history only, never current local state);',
  'durable compact English memory→`memory`;',
  'explicit Project change→`cwd`',
].join('\n');

test('omitToolRoutes drops search and memory clauses independently', () => {
  const noSearch = omitToolRoutes(SAMPLE_ROUTES, ['search', 'web_fetch']);
  assert.equal(noSearch.includes('`search`'), false);
  assert.equal(noSearch.includes('`web_fetch`'), false);
  assert.equal(noSearch.includes('`recall`'), true);
  assert.equal(noSearch.includes('`memory`'), true);

  const noMemory = omitToolRoutes(SAMPLE_ROUTES, ['memory', 'recall']);
  assert.equal(noMemory.includes('`search`'), true);
  assert.equal(noMemory.includes('`recall`'), false);
  assert.equal(noMemory.includes('`memory`'), false);
});

test('shared tool rules omit disabled search and memory routes', () => {
  const pluginRoot = join(process.cwd(), 'src');
  const full = buildSharedToolContent({ PLUGIN_ROOT: pluginRoot });
  assert.match(full, /`search`/);
  assert.match(full, /`memory`/);
  const omitted = buildSharedToolContent({
    PLUGIN_ROOT: pluginRoot,
    omitTools: ['search', 'web_fetch', 'memory', 'recall'],
  });
  assert.doesNotMatch(omitted, /`search`/);
  assert.doesNotMatch(omitted, /`web_fetch`/);
  assert.doesNotMatch(omitted, /`recall`/);
  assert.doesNotMatch(omitted, /`memory`/);
  assert.match(omitted, /`find`/);
});

test('shared tool rules keep parallel-default and shell-boundary anchors', () => {
  // Advisory drift check: these phrases carry the routing policy that field
  // failures traced to (serial batching, shell-as-explorer). Update the
  // phrase here when the rule text intentionally changes.
  const full = buildSharedToolContent({ PLUGIN_ROOT: join(process.cwd(), 'src') });
  assert.match(full, /independent calls share one batch by default/i);
  assert.match(full, /unless explicitly\s+instructed or after verifying that a dedicated tool cannot do the job/i);
  assert.match(full, /Shell otherwise joins investigation only for facts requiring execution or\s+unsupported decoding/i);
  assert.match(full, /environment variable or the home directory\s+are resolved locations/i);
  assert.match(full, /Opening-round batching never licenses a guessed path/i);
  assert.match(full, /`glob\.path` must be\s+an established existing directory/i);
  assert.match(full, /location itself is unknown, use `find` first/i);
  assert.match(full, /Add File itself is the atomic absence check/i);
  assert.match(full, /inspect only if it reports that the target already exists/i);
  assert.match(full, /local Git repository inspection and mutation→`git`/i);
  assert.ok(DEFERRED_DEFAULT_LEAD_TOOLS.includes('git'));
});

test('apply_patch advertises direct Add File creation through missing parents', () => {
  const applyPatch = PATCH_TOOL_DEFS.find((tool) => tool.name === 'apply_patch');
  assert.match(applyPatch.description, /Add File atomically creates the file and missing parent directories/i);
  assert.match(applyPatch.description, /fails without changing anything if the target already exists/i);
  assert.match(applyPatch.description, /without a prior read, list, or mkdir/i);
  assert.match(applyPatch.freeformDescription, /Add File atomically creates the file and missing parent directories/i);
  assert.match(applyPatch.freeformDescription, /fails without changing anything if the target already exists/i);
  assert.match(applyPatch.freeformDescription, /without a prior read, list, or mkdir/i);
  assert.match(applyPatch.freeformDescription, /one file operation block per target path/i);
  assert.match(applyPatch.freeformDescription, /exact current lines already in context/i);
});

test('toSessionWorkflowMeta keeps delegatesAgents for Solo packs', () => {
  const meta = toSessionWorkflowMeta({
    id: 'solo',
    name: 'Solo',
    description: 'Lead works alone.',
    source: 'built-in',
    delegatesAgents: false,
  });
  assert.equal(meta.delegatesAgents, false);
  assert.equal(workflowDisallowsAgentTool(meta), true);
  assert.equal(workflowDisallowsAgentTool({ id: 'solo' }), false);
});

function surfaceFor({ session = null, denied = [], standalone = [] } = {}) {
  return createToolSurface({
    mgr: { previewSessionTools: () => standalone },
    mode: 'full',
    standaloneTools: standalone,
    agentToolNames: new Set(['agent']),
    getSession: () => session,
    getRoute: () => ({ provider: 'grok-oauth' }),
    getConfig: () => ({ workflow: { active: 'solo' } }),
    cfgMod: { getPluginData: () => '' },
    loadWorkflowPack: () => ({ id: 'solo', delegatesAgents: false }),
    activeWorkflowId: () => 'solo',
    dataDir: '',
    getFeatureDisallowedTools: () => denied,
  });
}

test('modelStandaloneTools hides agent and disabled search/memory tools', () => {
  const standalone = [
    { name: 'read' },
    { name: 'agent' },
    { name: 'search' },
    { name: 'web_fetch' },
    { name: 'memory' },
    { name: 'recall' },
  ];
  const { modelStandaloneTools } = surfaceFor({
    session: { workflow: { id: 'solo', delegatesAgents: false } },
    denied: ['search', 'web_fetch', 'memory', 'recall'],
    standalone,
  });
  assert.deepEqual(modelStandaloneTools().map((tool) => tool.name), ['read']);
});

test('empty session refresh strips denied tools and BP1 routes', async () => {
  const session = {
    id: 'sess_empty',
    messages: [
      { role: 'system', content: '# Tool Use\nweb/current→`search`; returned URL body→`web_fetch`;\nprior work→`recall` (history only, never current local state);\ndurable compact English memory→`memory`;\n' },
      { role: 'system', content: '# Profile' },
      { role: 'system', content: '# Active Workflow: Cowork\n\n---\n\n# Lead Tools\n', cacheTier: 'tier3' },
    ],
    tools: [{ name: 'read' }, { name: 'agent' }, { name: 'search' }, { name: 'memory' }],
    deferredToolCatalog: [{ name: 'read' }, { name: 'agent' }, { name: 'search' }, { name: 'memory' }],
    deferredCallableTools: ['read', 'agent', 'search', 'memory'],
    workflow: { id: 'default', delegatesAgents: true },
    bp3EnvironmentContext: '- Shell: PowerShell.',
  };
  const { refreshEmptySessionToolPolicy } = createToolPolicyRefresh({
    getSession: () => session,
    getRoute: () => ({ provider: 'grok-oauth' }),
    getMode: () => 'full',
    getConfig: () => ({ workflow: { active: 'solo' } }),
    getDataDir: () => '',
    modelStandaloneTools: () => [{ name: 'read' }],
    featureDisallowedTools: () => ['search', 'web_fetch', 'memory', 'recall'],
    memoryToolsEnabled: () => false,
    loadCoreMemoryContext: async () => '# should not inject',
    activeWorkflowContext: () => ({
      summary: { id: 'solo', name: 'Solo', description: 'Lead works alone.', source: 'built-in', delegatesAgents: false },
      context: '# Active Workflow: Solo — Lead works alone.',
    }),
    invalidatePreSessionToolSurface: () => {},
  });
  const result = await refreshEmptySessionToolPolicy();
  assert.equal(result.appliedToCurrentSession, true);
  assert.equal(session.workflow.delegatesAgents, false);
  assert.deepEqual(session.tools.map((tool) => tool.name), ['read']);
  const bp1 = session.messages[0].content;
  assert.equal(bp1.includes('`search`'), false);
  assert.equal(bp1.includes('`memory`'), false);
  assert.match(session.messages[2].content, /# Active Workflow: Solo/);
  assert.equal(session.messages[2].content.includes('# Core Memory'), false);
});

test('refresh leaves a conversation session frozen', async () => {
  const session = {
    id: 'sess_live',
    messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
    tools: [{ name: 'agent' }, { name: 'search' }],
    workflow: { id: 'default', delegatesAgents: true },
  };
  const { refreshEmptySessionToolPolicy } = createToolPolicyRefresh({
    getSession: () => session,
    getRoute: () => ({ provider: 'grok-oauth' }),
    getMode: () => 'full',
    getConfig: () => ({}),
    getDataDir: () => '',
    modelStandaloneTools: () => [{ name: 'read' }],
    featureDisallowedTools: () => ['search'],
    memoryToolsEnabled: () => false,
    loadCoreMemoryContext: async () => '',
    activeWorkflowContext: () => ({
      summary: { id: 'solo', delegatesAgents: false },
      context: '# Active Workflow: Solo',
    }),
    invalidatePreSessionToolSurface: () => {},
  });
  const result = await refreshEmptySessionToolPolicy();
  assert.equal(result.appliedToCurrentSession, false);
  assert.deepEqual(session.tools.map((tool) => tool.name), ['agent', 'search']);
});
