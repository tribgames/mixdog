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

// Tool dependency is declared by `<!-- tools: … -->` markers, so this fixture
// carries the markers rather than prose the builder would have to match.
const SAMPLE_ROUTES = [
  '<!-- tools: web_search, web_fetch -->',
  '# Research',
  '',
  '<!-- tools: web_search, web_fetch -->',
  '- Research routes:',
  '<!-- tools: web_search -->',
  '  current or external information discovery→`web_search`;',
  '<!-- tools: web_fetch -->',
  '  page or documentation body retrieval from a known URL→`web_fetch`.',
  '<!-- tools: recall, memory -->',
  '# Memory',
  '',
  '<!-- tools: recall -->',
  '- past facts recorded in prior work or sessions→`recall`',
  '  (stored history only, never current local state).',
  '<!-- tools: memory -->',
  '- Durable memory creation or update→`memory`; store a compact English',
  '  statement.',
  '<!-- tools: memory -->',
  '- Use judgment to decide whether a durable memory should be stored.',
].join('\n');

test('omitToolRoutes strips markers and keeps every clause when nothing is omitted', () => {
  const kept = omitToolRoutes(SAMPLE_ROUTES, []);
  assert.equal(kept.includes('<!--'), false);
  assert.equal(kept.includes('`web_search`'), true);
  assert.equal(kept.includes('`web_fetch`'), true);
  assert.equal(kept.includes('`recall`'), true);
  assert.equal(kept.includes('`memory`'), true);
  assert.equal(kept.includes('# Research'), true);
  assert.equal(kept.includes('# Memory'), true);
  // The continuation line stays attached to the clause it belongs to.
  assert.match(kept, /→`recall`\n\s+\(stored history only, never current local state\)\./);
});

test('omitToolRoutes drops a clause only when every tool it declares is omitted', () => {
  const noSearchOnly = omitToolRoutes(SAMPLE_ROUTES, ['web_search']);
  assert.equal(noSearchOnly.includes('`web_search`'), false);
  assert.equal(noSearchOnly.includes('`web_fetch`'), true);
  // The section and its lead-in survive while one route remains.
  assert.equal(noSearchOnly.includes('# Research'), true);
  assert.equal(noSearchOnly.includes('Research routes:'), true);

  const noMemoryOnly = omitToolRoutes(SAMPLE_ROUTES, ['memory']);
  assert.equal(noMemoryOnly.includes('`recall`'), true);
  assert.equal(noMemoryOnly.includes('`memory`'), false);
  // Guidance that only makes sense with the memory tool goes with it.
  assert.equal(noMemoryOnly.includes('Use judgment'), false);
});

test('omitToolRoutes drops web search and memory clauses independently', () => {
  const noSearch = omitToolRoutes(SAMPLE_ROUTES, ['web_search', 'web_fetch']);
  assert.equal(noSearch.includes('`web_search`'), false);
  assert.equal(noSearch.includes('`web_fetch`'), false);
  assert.equal(noSearch.includes('`recall`'), true);
  assert.equal(noSearch.includes('`memory`'), true);

  const noMemory = omitToolRoutes(SAMPLE_ROUTES, ['memory', 'recall']);
  assert.equal(noMemory.includes('`web_search`'), true);
  assert.equal(noMemory.includes('`recall`'), false);
  assert.equal(noMemory.includes('`memory`'), false);
  assert.equal(noMemory.includes('# Memory'), false);

  const noResearch = omitToolRoutes(SAMPLE_ROUTES, ['web_search', 'web_fetch']);
  assert.equal(noResearch.includes('# Research'), false);
  assert.equal(noResearch.includes('Research routes:'), false);
  assert.equal(noResearch.includes('# Memory'), true);
});

test('shared tool rules omit disabled web search and memory routes', () => {
  const pluginRoot = join(process.cwd(), 'src');
  const full = buildSharedToolContent({ PLUGIN_ROOT: pluginRoot });
  assert.match(
    full,
    /^# General\s+- When an internal Mixdog rule conflicts with the user's latest explicit\s+request, follow the user's request\./,
  );
  assert.match(full, /`web_search`/);
  assert.match(full, /`memory`/);
  const omitted = buildSharedToolContent({
    PLUGIN_ROOT: pluginRoot,
    omitTools: ['web_search', 'web_fetch', 'memory', 'recall'],
  });
  assert.doesNotMatch(omitted, /`web_search`/);
  assert.doesNotMatch(omitted, /`web_fetch`/);
  assert.doesNotMatch(omitted, /`recall`/);
  assert.doesNotMatch(omitted, /`memory`/);
  assert.doesNotMatch(omitted, /# Research/);
  assert.doesNotMatch(omitted, /# Memory/);
  assert.match(omitted, /`find`/);
});

test('shared tool rules keep workflow and shell-boundary anchors', () => {
  // Advisory drift check: update these anchors when the rule text
  // intentionally changes.
  const full = buildSharedToolContent({ PLUGIN_ROOT: join(process.cwd(), 'src') });
  assert.match(full, /Minimize tool turns through maximal useful parallelism/i);
  assert.match(full, /In each round, issue every necessary non-overlapping call whose inputs are\s+already known/i);
  assert.match(full, /Investigate, build, and verify only what the requested outcome requires, at\s+the level it requires/i);
  assert.match(full, /A check runs at the strictness the task requires; never raise a tool's own\s+severity beyond it/i);
  assert.match(full, /Cost is counted in\s+rounds, not calls/i);
  assert.match(full, /Plan the fewest evidence-complete dependent\s+rounds first/i);
  assert.match(full, /defer a call only when its target or arguments require an\s+earlier result/i);
  assert.match(full, /Route each remaining evidence facet once to its primary owner, preferring the\s+operation that directly returns the evidence needed for the next decision/i);
  assert.match(full, /summary, overview, or enumeration is not a prerequisite when that operation's\s+complete inputs are already known/i);
  assert.match(full, /apply\s+one analysis to many targets as one parameterized call/i);
  assert.match(full, /use Execution when the information can only be produced by running a program\s+or observing runtime state/i);
  assert.match(full, /Evidence or artifacts available only through program execution, calculation,\s+data transformation, generated output, or unsupported-format decoding→`shell`/i);
  assert.match(full, /an already-open shell is never a routing reason/i);
  assert.match(full, /Route the missing evidence to its primary owner/i);
  assert.match(full, /repository state, history, or diff→`git`/i);
  assert.match(full, /Ownership is exclusive: each evidence type has one owner/i);
  assert.match(full, /a\s+successful owner result closes that facet/i);
  assert.match(full, /Blocking checks cover only essential integrity, security, compatibility, and\s+buildability invariants/i);
  assert.match(full, /environment variable or the home directory are\s+resolved locations/i);
  assert.match(full, /Use read-only means for inspection; never mutate to clear an obstacle or\s+unexpected state/i);
  assert.match(full, /literal, regex, or text location→`grep`;\s+known-file content, range, or image→`read`/i);
  assert.match(full, /is never re-found, re-derived, or\s+re-verified at any granularity/i);
  assert.match(full, /Mine each returned result fully before opening the next round/i);
  assert.match(full, /Evidence that determines the answer, edit, or deliverable ends retrieval/i);
  assert.match(full, /Enter Verification only after all planned work is complete/i);
  assert.match(full, /use an umbrella suite only when the user explicitly requests it\s+or a documented project or release process requires it/i);
  assert.match(full, /If verification fails, collect all failures, leave Verification/i);
  assert.match(full, /A successful verification closes the task unless later changes affect it/i);
  assert.doesNotMatch(full, /affected failed checks once/i);
  assert.match(full, /Every repository mutation→`git`/i);
  assert.doesNotMatch(full, /always batch safely in parallel/i);
  assert.match(full, /A required new file is created directly: Add File is itself the atomic\s+absence check/i);
  assert.match(full, /Source: use exact current target text from any visible evidence/i);
  assert.match(full, /Placement: with `edit`, use an exact unique target string/i);
  assert.match(full, /with `apply_patch`, use exact unchanged context/i);
  assert.match(full, /Apply all determined changes in the fewest safe calls the active tool\s+supports/i);
  assert.match(full, /Batch scope: never split one file across concurrent edit calls/i);
  assert.match(full, /Commit, push, release, and deployment happen only on the user's explicit\s+request/i);
  assert.match(full, /past facts recorded in prior work or sessions→`recall`/i);
  assert.match(full, /Use judgment to decide whether a durable memory should be stored/i);
  assert.match(full, /Omit `project_id` for the current Project, use `"common"` for shared memory/i);
  const headings = ['# General', '# Tool Workflow', '# Research', '# Exploration', '# Editing', '# Execution', '# Verification', '# Delivery', '# Memory'];
  assert.deepEqual(headings.map((heading) => full.indexOf(heading)), headings.map((heading) => full.indexOf(heading)).toSorted((a, b) => a - b));
  assert.ok(DEFERRED_DEFAULT_LEAD_TOOLS.includes('git'));
});

test('apply_patch keeps grammar and mutation behavior on the freeform surface', () => {
  const applyPatch = PATCH_TOOL_DEFS.find((tool) => tool.name === 'apply_patch');
  assert.match(applyPatch.freeformDescription, /Add File atomically creates the file and missing parent directories/i);
  assert.match(applyPatch.freeformDescription, /failing without changes if the target already exists/i);
  assert.match(applyPatch.freeformDescription, /one Add\/Delete\/Update File block per target path/i);
  assert.match(applyPatch.freeformDescription, /Multi-file patches commit valid files and report rejected files separately/i);
  assert.equal(applyPatch.inputSchema.properties.patch.minLength, 1);
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

test('modelStandaloneTools hides agent and disabled web-search/memory tools', () => {
  const standalone = [
    { name: 'read' },
    { name: 'agent' },
    { name: 'web_search' },
    { name: 'web_fetch' },
    { name: 'memory' },
    { name: 'recall' },
  ];
  const { modelStandaloneTools } = surfaceFor({
    session: { workflow: { id: 'solo', delegatesAgents: false } },
    denied: ['web_search', 'web_fetch', 'memory', 'recall'],
    standalone,
  });
  assert.deepEqual(modelStandaloneTools().map((tool) => tool.name), ['read']);
});

test('empty session refresh strips denied tools and BP1 routes', async () => {
  const session = {
    id: 'sess_empty',
    messages: [
      { role: 'system', content: '# Tool Use\nweb/current→`web_search`; returned URL body→`web_fetch`;\nprior work→`recall` (history only, never current local state);\ndurable compact English memory→`memory`;\n' },
      { role: 'system', content: '# Profile' },
      { role: 'system', content: '# Active Workflow: Cowork\n\n---\n\n# Lead Tools\n', cacheTier: 'tier3' },
    ],
    tools: [{ name: 'read' }, { name: 'agent' }, { name: 'web_search' }, { name: 'memory' }],
    deferredToolCatalog: [{ name: 'read' }, { name: 'agent' }, { name: 'web_search' }, { name: 'memory' }],
    deferredCallableTools: ['read', 'agent', 'web_search', 'memory'],
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
    featureDisallowedTools: () => ['web_search', 'web_fetch', 'memory', 'recall'],
    memoryToolsEnabled: () => false,
    loadCoreMemoryContext: async () => '# should not inject',
    activeWorkflowContext: () => ({
      summary: { id: 'solo', name: 'Solo', description: 'Lead works alone.', source: 'built-in', delegatesAgents: false },
      context: '# Active Workflow: Solo — Lead works alone.',
    }),
    invalidatePreSessionToolSurface: () => {},
  });
  const bp1BeforeRefresh = session.messages[0];
  const bp3BeforeRefresh = session.messages[2];
  const result = await refreshEmptySessionToolPolicy();
  assert.equal(result.appliedToCurrentSession, true);
  assert.equal(session.workflow.delegatesAgents, false);
  assert.deepEqual(session.tools.map((tool) => tool.name), ['read']);
  const bp1 = session.messages[0].content;
  assert.equal(bp1.includes('`web_search`'), false);
  assert.equal(bp1.includes('`memory`'), false);
  assert.notEqual(session.messages[0], bp1BeforeRefresh);
  assert.notEqual(session.messages[2], bp3BeforeRefresh);
  assert.match(session.messages[2].content, /# Active Workflow: Solo/);
  assert.equal(session.messages[2].content.includes('# Core Memory'), false);
});

test('refresh leaves a conversation session frozen', async () => {
  const session = {
    id: 'sess_live',
    messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
    tools: [{ name: 'agent' }, { name: 'web_search' }],
    workflow: { id: 'default', delegatesAgents: true },
  };
  const { refreshEmptySessionToolPolicy } = createToolPolicyRefresh({
    getSession: () => session,
    getRoute: () => ({ provider: 'grok-oauth' }),
    getMode: () => 'full',
    getConfig: () => ({}),
    getDataDir: () => '',
    modelStandaloneTools: () => [{ name: 'read' }],
    featureDisallowedTools: () => ['web_search'],
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
  assert.deepEqual(session.tools.map((tool) => tool.name), ['agent', 'web_search']);
});
