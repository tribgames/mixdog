import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { join } from 'node:path';
import { createToolSurface } from './tool-surface.mjs';
import { createToolPolicyRefresh } from './tool-policy-refresh.mjs';
import { toSessionWorkflowMeta, workflowDisallowsAgentTool } from './workflow.mjs';
import { PATCH_TOOL_DEFS } from '../runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import { DEFERRED_DEFAULT_LEAD_TOOLS } from './tool-catalog-data.mjs';
import { LEAD_DISALLOWED_TOOLS } from './tool-defs.mjs';
import { GOAL_TOOL_DEFS } from './goal-runtime.mjs';
import { finalizeSessionToolList } from '../runtime/agent/orchestrator/session/manager/tool-resolution.mjs';
import { modelToolSchemaAllowlist } from './tool-profile.mjs';

const require = createRequire(import.meta.url);
const { omitToolRoutes, buildSharedToolContent, buildAgentRoleContent, buildLeadRoleContent } = require('../lib/rules-builder.cjs');

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

  // Exactly one edit dialect ships per model, so the rules must never describe
  // the tool that is absent from the surface.
  const patchOnly = buildSharedToolContent({ PLUGIN_ROOT: pluginRoot, omitTools: ['edit'] });
  assert.doesNotMatch(patchOnly, /`edit`/);
  assert.match(patchOnly, /Author files with `apply_patch`, not shell scripts\/redirection/i);
  assert.match(patchOnly, /source-file edits stay with `apply_patch`/i);
  const editOnly = buildSharedToolContent({ PLUGIN_ROOT: pluginRoot, omitTools: ['apply_patch'] });
  assert.doesNotMatch(editOnly, /`apply_patch`/);
  assert.doesNotMatch(editOnly, /Add File|Update File/);
  assert.match(editOnly, /Author files with `edit`, not shell scripts\/redirection/i);
  assert.match(editOnly, /source-file edits stay with `edit`\./i);
});

test('rule allowlists omit unavailable capabilities and explicit denies still win', () => {
  const searchOnly = omitToolRoutes(SAMPLE_ROUTES, [], ['WEB_SEARCH']);
  assert.match(searchOnly, /# Research/);
  assert.match(searchOnly, /`web_search`/);
  assert.doesNotMatch(searchOnly, /web_fetch|recall|memory|<!--/);
  assert.equal(omitToolRoutes(SAMPLE_ROUTES, ['web_search'], ['web_search']), '');
  assert.equal(omitToolRoutes(SAMPLE_ROUTES, [], []), '');
});

test('headless rules omit Skill and Goal guidance while interactive rules retain it', () => {
  const PLUGIN_ROOT = join(process.cwd(), 'src');
  const interactive = buildSharedToolContent({ PLUGIN_ROOT });
  assert.match(interactive, /# Skills/);
  assert.match(interactive, /# Goals/);
  const headless = buildSharedToolContent({
    PLUGIN_ROOT,
    allowTools: modelToolSchemaAllowlist('headless'),
    omitTools: ['edit'],
  });
  const role = buildLeadRoleContent({ PLUGIN_ROOT, includeLeadBrief: false });
  assert.doesNotMatch(`${headless}\n${role}`, /\bSkills?\b|\bGoals?\b|`goal`|goal-management/);
  assert.match(headless, /`load_tool`/);
  assert.match(headless, /`read`/);
  assert.doesNotMatch(
    buildSharedToolContent({ PLUGIN_ROOT, omitTools: ['sKiLl', 'GOAL'] }),
    /\bSkills?\b|\bGoals?\b|`goal`|goal-management/,
  );
});

test('shared tool rules keep workflow and shell-boundary anchors', () => {
  // Advisory drift check: update these anchors when the rule text
  // intentionally changes.
  const full = buildSharedToolContent({ PLUGIN_ROOT: join(process.cwd(), 'src') });
  assert.match(full, /Validate exact targets before destructive\/hard-to-reverse actions/i);
  assert.match(full, /never roots,\s+`~` or unresolved variables\/globs/i);
  assert.match(full, /Ask only for targets or destructive effects\s+not already approved/i);
  assert.match(full, /Define required outputs and final checks/i);
  assert.match(full, /Wait only for scope\/decision dependencies or conflicting effects/i);
  assert.match(full, /gather missing evidence → implement completely → verify → deliver/i);
  assert.match(full, /respect approvals and bound output/i);
  assert.match(full, /Use supplied commands unchanged except inputs, otherwise documented defaults/i);
  assert.match(full, /One evidence owner; known targets go directly there/i);
  assert.match(full, /When a diff establishes\s+the cause, edit site and required change, implement next/i);
  assert.match(full, /Batch required targets in each tool's arrays first, then parallelize independent\s+calls/i);
  assert.match(full, /Evidence or artifacts available only through program execution, calculation,\s+data transformation, generated output, or unsupported-format decoding→`shell`/i);
  assert.match(full, /an already-open shell is never a routing reason/i);
  assert.match(full, /State\/history\/diff→`git`/i);
  assert.match(full, /Trust documented guarantees and let intended operations report availability/i);
  assert.match(full, /Each call must advance required work, not add an optional branch/i);
  assert.match(full, /Check required behavior, exact outputs and essential integrity\/security\/\s+compatibility\/buildability/i);
  assert.match(full, /Supplied\/home\/environment paths need no locator/i);
  assert.match(full, /Use documented non-mutating readers directly, without prerequisite copies/i);
  assert.match(full, /preserve\s+exact originals and inspect a separate working copy before opening them/i);
  assert.match(full, /text\/regex→`grep`; content\/ranges\/images→`read`/i);
  assert.match(full, /Retry deterministic failures only after relevant change/i);
  assert.match(full, /allow one safe,\s+bounded transient retry/i);
  assert.match(full, /Never bypass denial\/cancellation or repeat unknown\s+mutations/i);
  assert.match(full, /Follow miss causes; a missing `code_graph` symbol alone gets one literal `grep` fallback/i);
  assert.match(full, /UI\/edit sites use `grep` and only missing anchored ranges/i);
  assert.match(full, /one\s+runner reports every outcome despite failures\. Otherwise use separate calls/i);
  assert.match(full, /No stricter flags or unrequested umbrella suites/i);
  assert.match(full, /A passed check settles only that check; finish the remaining required checks/i);
  assert.match(full, /Collect failures, finish fixes, and rerun only failed or invalidated checks/i);
  assert.match(full, /Completion requires the verified objective, not a turn-ending response/i);
  assert.doesNotMatch(full, /affected failed checks once/i);
  assert.match(full, /Git commands→`git`; source-file edits stay with `edit`\./i);
  assert.match(full, /Git commands→`git`; source-file edits stay with `apply_patch`\./i);
  assert.doesNotMatch(full, /Every repository mutation→`git`/i);
  assert.doesNotMatch(full, /always batch safely in parallel/i);
  // Dialect-specific contracts live in tool descriptions; their tests are
  // separate from these shared-policy anchors.
  assert.match(full, /Use exact current target text from visible evidence/i);
  assert.match(full, /Apply determined edits in the fewest safe supported calls/i);
  assert.match(full, /Defer only ambiguous or result-dependent changes/i);
  assert.match(full, /Commit, push, release, and deployment happen only on the user's explicit\s+request/i);
  assert.match(full, /past facts recorded in prior work or sessions→`recall`/i);
  assert.match(full, /show its exact content and scope/i);
  assert.match(full, /Never promote inferred lessons into standing instructions/i);
  const headings = ['# General', '# Tool Workflow', '# Research', '# Exploration', '# Editing', '# Execution', '# Verification', '# Delivery', '# Memory'];
  assert.deepEqual(headings.map((heading) => full.indexOf(heading)), headings.map((heading) => full.indexOf(heading)).toSorted((a, b) => a - b));
  assert.ok(DEFERRED_DEFAULT_LEAD_TOOLS.includes('git'));
  assert.equal(DEFERRED_DEFAULT_LEAD_TOOLS.includes('goal'), false);
  assert.equal(DEFERRED_DEFAULT_LEAD_TOOLS.includes('git_stage'), false);
  assert.deepEqual(LEAD_DISALLOWED_TOOLS, [
    'get_goal', 'create_goal', 'set_goal_tasks', 'update_goal',
  ]);
});

test('agent common policy delegates verification unless AGENT.md explicitly owns it', () => {
  const rules = buildAgentRoleContent({ PLUGIN_ROOT: join(process.cwd(), 'src') });
  assert.match(rules, /Unless an agent's own `AGENT\.md` explicitly assigns a review or verification/i);
  assert.match(rules, /skip builds, tests, lint, runtime checks/i);
  assert.match(rules, /Lead or an explicitly verification-assigned agent owns verification/i);
});

test('apply_patch descriptions keep creation and placement contracts on both surfaces', () => {
  const applyPatch = PATCH_TOOL_DEFS.find((tool) => tool.name === 'apply_patch');
  for (const description of [applyPatch.description, applyPatch.freeformDescription]) {
    assert.match(description, /exact, unique context; add a class\/function locator/i);
    assert.match(description, /New files and parents are created atomically/i);
    assert.match(description, /existing targets reject creation unchanged/i);
    assert.match(description, /Attempt it directly, without read\/list\/mkdir/i);
    assert.match(description, /Valid files commit; rejected files are reported separately/i);
  }
  assert.match(applyPatch.freeformDescription, /one Add\/Delete\/Update File block per path/i);
  assert.match(applyPatch.freeformDescription, /group its @@ hunks/i);
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

function surfaceFor({
  session = null,
  denied = [],
  standalone = [],
  provider = 'grok-oauth',
  toolProfile = 'interactive',
} = {}) {
  return createToolSurface({
    mgr: { previewSessionTools: () => standalone },
    mode: 'full',
    standaloneTools: standalone,
    agentToolNames: new Set(['agent']),
    getSession: () => session,
    getRoute: () => ({ provider }),
    getConfig: () => ({ workflow: { active: 'solo' } }),
    getToolProfile: () => toolProfile,
    cfgMod: { getPluginData: () => '' },
    loadWorkflowPack: () => ({ id: 'solo', delegatesAgents: false }),
    activeWorkflowId: () => 'solo',
    dataDir: '',
    getFeatureDisallowedTools: () => denied,
  });
}

test('modelStandaloneTools hides agent and disabled first-party feature tools', () => {
  const standalone = [
    { name: 'read' },
    { name: 'agent' },
    { name: 'git' },
    { name: 'git_stage' },
    { name: 'web_search' },
    { name: 'web_fetch' },
    { name: 'memory' },
    { name: 'recall' },
    { name: 'office' },
  ];
  const { modelStandaloneTools } = surfaceFor({
    session: { workflow: { id: 'solo', delegatesAgents: false } },
    denied: ['git', 'git_stage', 'web_search', 'web_fetch', 'memory', 'recall', 'office'],
    standalone,
  });
  assert.deepEqual(modelStandaloneTools().map((tool) => tool.name), ['read']);
});

test('Agent standalone and deferred tools match Lead except for agent control', () => {
  const standalone = [
    { name: 'agent' },
    { name: 'load_tool', annotations: { agentHidden: true } },
    { name: 'cwd', annotations: { agentHidden: true } },
    { name: 'memory' },
    { name: 'mcp__demo__tool' },
  ];
  const lead = surfaceFor({
    session: { owner: 'cli', workflow: { delegatesAgents: true } },
    standalone,
  }).modelStandaloneTools().map((tool) => tool.name);
  const agent = surfaceFor({
    session: { owner: 'agent', visibility: 'agent-only', workflow: { delegatesAgents: true } },
    standalone,
  }).modelStandaloneTools().map((tool) => tool.name);
  assert.deepEqual(lead, ['agent', 'load_tool', 'cwd', 'memory', 'mcp__demo__tool']);
  assert.deepEqual(agent, ['load_tool', 'cwd', 'memory', 'mcp__demo__tool']);
});

test('Agent base tools keep every Lead tool except agent regardless of agentHidden metadata', () => {
  const tools = [
    { name: 'agent' },
    { name: 'load_tool', annotations: { agentHidden: true } },
    { name: 'cwd', annotations: { agentHidden: true } },
    { name: 'read' },
    { name: 'apply_patch' },
  ];
  assert.deepEqual(
    finalizeSessionToolList(tools, { ownerIsAgent: true }).map((tool) => tool.name),
    ['read', 'apply_patch', 'load_tool', 'cwd'],
  );
});

test('Goal is deferred but remains discoverable on the native Lead tool surface', () => {
  const surface = surfaceFor({
    standalone: GOAL_TOOL_DEFS,
    provider: 'openai-oauth',
  }).activeToolSurface();
  assert.deepEqual(surface.tools.map((tool) => tool.name), []);
  assert.equal(surface.deferredCallableTools.includes('goal'), false);
  assert.equal(surface.deferredToolCatalog.some((tool) => tool.name === 'goal'), true);
  assert.equal((surface.deferredToolCatalog || []).some((tool) => tool.name === 'create_goal'), false);
});

test('headless tool profile keeps task-scoped tools and removes persistent or interactive tools', () => {
  const standalone = [
    { name: 'read' },
    { name: 'load_tool' },
    { name: 'office' },
    { name: 'git_stage' },
    { name: 'web_search' },
    { name: 'goal' },
    { name: 'agent' },
    { name: 'memory' },
    { name: 'recall' },
    { name: 'cwd' },
    { name: 'Skill' },
    { name: 'browser' },
    { name: 'computer' },
  ];
  const surface = surfaceFor({
    standalone,
    provider: 'openai-oauth',
    toolProfile: 'headless',
  }).activeToolSurface();
  const catalogNames = new Set((surface.deferredToolCatalog || []).map((tool) => tool.name));
  const activeNames = new Set((surface.tools || []).map((tool) => tool.name));

  for (const name of ['read', 'load_tool', 'office', 'git_stage', 'web_search']) {
    assert.equal(catalogNames.has(name), true, `${name} should remain available`);
  }
  assert.equal(activeNames.has('office'), false);
  assert.equal(activeNames.has('git_stage'), false);
  for (const name of ['goal', 'agent', 'memory', 'recall', 'cwd', 'Skill', 'browser', 'browser_devtools', 'computer']) {
    assert.equal(catalogNames.has(name), false, `${name} should be absent`);
    assert.equal(activeNames.has(name), false, `${name} should not be active`);
  }
});

test('Goal stays active while legacy Goal schemas are removed from restored sessions', () => {
  const read = { name: 'read', annotations: { readOnlyHint: true } };
  const legacyGoal = { name: 'update_goal', annotations: { readOnlyHint: false } };
  const goal = { name: 'goal', annotations: { readOnlyHint: false } };
  const session = {
    provider: 'grok-oauth',
    messages: [{ role: 'system', content: '# Existing session' }],
    tools: [read, legacyGoal],
    deferredToolCatalog: [read, legacyGoal],
    deferredCallableTools: ['read', 'update_goal'],
    deferredSelectedTools: ['read', 'update_goal'],
    deferredToolBp2Applied: true,
  };
  const surface = surfaceFor({ session, standalone: [read, goal] });
  const result = surface.activateTools(['goal']);
  assert.deepEqual(result.missing, []);
  const visible = new Set([
    ...session.tools.map((tool) => tool.name),
    ...(session.deferredCallableTools || []),
  ]);
  assert.equal(visible.has('goal'), true);
  assert.equal(visible.has('update_goal'), false);
});

test('empty session refresh strips denied tools and BP1 routes', async () => {
  const session = {
    id: 'sess_empty',
    schemaAllowedTools: modelToolSchemaAllowlist('headless'),
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
  assert.doesNotMatch(`${bp1}\n${session.messages[2].content}`, /\bSkills?\b|\bGoals?\b|`goal`|goal-management/);
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
