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
const {
  omitToolRoutes,
  buildSharedToolContent,
  buildAgentRoleContent,
  buildLeadRoleContent,
} = require('../lib/rules-builder.cjs');

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
  // Shared policy is tool policy only; precedence rules live with each role (Lead / agent common).
  assert.match(full, /^# Tool Calls\s+- Order on files/);
  assert.doesNotMatch(full, /# General|latest explicit request|Author model-facing/);
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
  assert.match(patchOnly, /Author files with `apply_patch`\./i);
  const editOnly = buildSharedToolContent({ PLUGIN_ROOT: pluginRoot, omitTools: ['apply_patch'] });
  assert.doesNotMatch(editOnly, /`apply_patch`/);
  assert.doesNotMatch(editOnly, /Add File|Update File/);
  assert.match(editOnly, /Author files with `edit`\./i);
});

test('rule allowlists omit unavailable capabilities and explicit denies still win', () => {
  const searchOnly = omitToolRoutes(SAMPLE_ROUTES, [], ['WEB_SEARCH']);
  assert.match(searchOnly, /# Research/);
  assert.match(searchOnly, /`web_search`/);
  assert.doesNotMatch(searchOnly, /web_fetch|recall|memory|<!--/);
  assert.equal(omitToolRoutes(SAMPLE_ROUTES, ['web_search'], ['web_search']), '');
  assert.equal(omitToolRoutes(SAMPLE_ROUTES, [], []), '');
});

test('headless rules omit Skill guidance while interactive rules retain it; goal policy lives in its tool and skill', () => {
  const PLUGIN_ROOT = join(process.cwd(), 'src');
  const interactive = buildSharedToolContent({ PLUGIN_ROOT });
  assert.match(interactive, /# Skills/);
  assert.doesNotMatch(interactive, /# Goals|`goal`/);
  const headless = buildSharedToolContent({
    PLUGIN_ROOT,
    allowTools: modelToolSchemaAllowlist('headless'),
    omitTools: ['edit'],
  });
  const role = buildLeadRoleContent({ PLUGIN_ROOT, includeLeadBrief: false });
  assert.doesNotMatch(`${headless}\n${role}`, /\bSkills?\b|\bGoals?\b|`goal`|goal-management/);
  // Loader guidance lives in the load_tool description, not the shared rules.
  assert.doesNotMatch(headless, /`load_tool`/);
  assert.match(headless, /`read`/);
  assert.doesNotMatch(
    buildSharedToolContent({ PLUGIN_ROOT, omitTools: ['sKiLl', 'GOAL'] }),
    /\bSkills?\b|\bGoals?\b|`goal`|goal-management/
  );
});

test('shared tool rules keep workflow and shell-boundary anchors', () => {
  // Advisory drift check: update these anchors when the rule text
  // intentionally changes.
  const full = buildSharedToolContent({ PLUGIN_ROOT: join(process.cwd(), 'src') }).replace(/\s+/g, ' ');
  // Destructive-action policy lives once, in its own section.
  assert.match(full, /# Destructive Actions/);
  assert.match(full, /any irreversible action only on the\s+user's explicit request/i);
  assert.match(full, /never roots, `~` or\s+unresolved variables\/globs/i);
  assert.match(full, /Report what is recoverable/i);
  assert.doesNotMatch(full, /Validate exact targets before destructive actions|deletion recoverability/i);
  assert.match(full, /Cheapest decisive evidence first \(existing state, a diff, a failing test\)/i);
  assert.match(full, /Sequence\s+only on a real dependency/i);
  assert.match(full, /Order on files: enumerate only when the scope is unknown/i);
  // Read call shape lives in the read description; the rule names the stage only.
  assert.match(full, /one read stage over every located\s+site/i);
  assert.doesNotMatch(full, /window per site|≤10 per call/i);
  assert.match(
    full,
    /A search after a read that could have\s+run before it is a wasted round; content in context is never read again/i
  );
  assert.match(full, /Trust documented guarantees; no availability checks or defensive branches —\s+in scripts too/i);
  assert.match(full, /Back up only when changes risk irreversible loss, not for routine code edits/i);
  assert.match(full, /direct references, no surveys or history/i);
  assert.match(full, /Reuse content\s+already delivered; changed sources and omitted ranges are new evidence/i);
  assert.match(full, /Use supplied commands unchanged except inputs, else documented defaults/i);
  assert.match(full, /Route by missing evidence: files\/ranges→`read`, text or regex→`grep`/i);
  // The shell boundary is stated once, in Execution.
  assert.match(full, /Tool names are not shell commands/i);
  assert.doesNotMatch(full, /`shell` only runs/i);
  assert.match(full, /Every independent call in the same response, never one per round/i);
  assert.match(full, /A tool that takes an array gets one call with the array whenever there are\s+several targets/i);
  assert.match(
    full,
    /`shell` only for evidence or artifacts that require execution: computation,\s+data transformation, generated output, unsupported-format decoding/i
  );
  assert.match(full, /An open\s+shell is never a routing reason/i);
  // Git routing lives in the shell tool description, not the shared rules.
  assert.doesNotMatch(full, /Git→`git`/i);
  assert.match(full, /no read\/list\/diff to confirm writes/i);
  assert.doesNotMatch(full, /Verify once after all edits/i);
  assert.match(full, /Generated data is not evidence/i);
  assert.match(
    full,
    /Check required behavior, exact outputs and essential integrity, security,\s+compatibility and buildability/i
  );
  assert.match(full, /Supplied\/home\/environment paths need no locator/i);
  assert.match(full, /keep backups unless the user requests removal/i);
  assert.match(full, /temp workspaces come from a unique-directory\s+allocator/i);
  assert.match(full, /files\/ranges→`read`, text or regex→`grep`,\s+declarations and relations→`code_graph`/i);
  // code_graph usage and the read stage live in their tool descriptions and Tool Calls.
  assert.doesNotMatch(full, /Structure questions|located windows|no backups for reading/i);
  assert.match(full, /a sample is not the input\s+domain/i);
  assert.match(full, /Retry only after a relevant change, at most one bounded transient retry/i);
  assert.match(full, /never bypass denial or cancellation/i);
  assert.match(full, /never hide errors, timeouts or cancellation\s+behind later success/i);
  assert.doesNotMatch(full, /fallback/i);
  assert.match(
    full,
    /locate every site \(`grep` `context:0`\/`mode:files`, `code_graph`; known\s+locations skip straight to the read\)/i
  );
  assert.match(full, /separate calls of the same tool only when the targets need\s+different options/i);
  assert.doesNotMatch(full, /UI\/edit sites/i);
  assert.match(
    full,
    /After all edits, cover each required check once: one runner per runtime,\s+independent checks in parallel/i
  );
  assert.match(full, /no\s+stricter flags or unrequested suites/i);
  assert.match(full, /rerun only failed or invalidated checks/i);
  assert.doesNotMatch(full, /Collect failures, finish fixes/i);
  // Goal lifecycle and completion policy live in the goal tool description and skill.
  assert.doesNotMatch(full, /Completion means the verified objective/i);
  assert.doesNotMatch(full, /affected failed checks once/i);
  // Git routing lives in the shell/git tool descriptions; Delivery no longer repeats it.
  assert.doesNotMatch(full, /source-file edits stay with/i);
  assert.doesNotMatch(full, /Every repository mutation→`git`/i);
  assert.doesNotMatch(full, /always batch safely in parallel/i);
  // Dialect-specific contracts live in tool descriptions; their tests are
  // separate from these shared-policy anchors.
  assert.match(full, /Target text comes from visible evidence, never reconstructed/i);
  assert.doesNotMatch(full, /Editing tool names are direct tool calls/i);
  // Call count and sequencing belong to Tool Calls; Editing keeps the per-file rule.
  assert.match(full, /Write each file complete in one pass/i);
  assert.doesNotMatch(full, /Fewest safe calls|result-dependent changes/i);
  assert.match(full, /Commit, push, release, deployment and any irreversible action/i);
  assert.match(full, /Stage selected diff changes with `git` using `action:"stage"`/i);
  assert.match(full, /A commit request includes selecting and staging/i);
  // Delivery's Git workflow is hidden without the unified tool.
  assert.doesNotMatch(
    buildSharedToolContent({ PLUGIN_ROOT: join(process.cwd(), 'src'), omitTools: ['git'] }),
    /# Delivery/
  );
  assert.match(full, /`recall` only on request or for an open decision/i);
  // The memory approval flow lives in the memory tool description.
  assert.doesNotMatch(full, /show exact content and scope and ask/i);
  assert.match(full, /nothing else; never\s+store inferred lessons as standing instructions/i);
  const headings = [
    // Batching comes first: every later rule assumes the calls it names are batched.
    '# Tool Calls',
    '# Tool Workflow',
    '# Research',
    '# Exploration',
    '# Editing',
    '# Destructive Actions',
    '# Execution',
    '# Verification',
    '# Delivery',
    '# Memory',
  ];
  assert.deepEqual(
    headings.map((heading) => full.indexOf(heading)),
    headings.map((heading) => full.indexOf(heading)).toSorted((a, b) => a - b)
  );
  assert.ok(DEFERRED_DEFAULT_LEAD_TOOLS.includes('git'));
  assert.equal(DEFERRED_DEFAULT_LEAD_TOOLS.includes('goal'), false);
  assert.equal(DEFERRED_DEFAULT_LEAD_TOOLS.includes('github'), false);
  assert.deepEqual(LEAD_DISALLOWED_TOOLS, ['get_goal', 'create_goal', 'set_goal_tasks', 'update_goal']);
});

test('agent common policy has workers verify their own changes and leaves review to Lead', () => {
  const rules = buildAgentRoleContent({ PLUGIN_ROOT: join(process.cwd(), 'src') });
  assert.match(rules, /^# Agent$/m);
  assert.match(rules, /the tests and checks you ran for your\s+own changes and their result/i);
  assert.match(rules, /Lead owns the independent review/i);
  assert.match(rules, /Lead's latest brief is your request and overrides\s+any internal rule/i);
  // The retrieval profile shares the same contract plus its read-only line.
  const retrieval = buildAgentRoleContent({ PLUGIN_ROOT: join(process.cwd(), 'src'), profile: 'retrieval' });
  assert.match(retrieval, /^# Agent$/m);
  assert.match(retrieval, /Read-only retrieval role/);
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
    { name: 'github' },
    { name: 'web_search' },
    { name: 'web_fetch' },
    { name: 'memory' },
    { name: 'recall' },
    { name: 'office' },
    { name: 'tidy' },
  ];
  const { modelStandaloneTools } = surfaceFor({
    session: { workflow: { id: 'solo', delegatesAgents: false } },
    denied: ['git', 'github', 'web_search', 'web_fetch', 'memory', 'recall', 'office', 'tidy'],
    standalone,
  });
  assert.deepEqual(
    modelStandaloneTools().map((tool) => tool.name),
    ['read']
  );
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
  })
    .modelStandaloneTools()
    .map((tool) => tool.name);
  const agent = surfaceFor({
    session: { owner: 'agent', visibility: 'agent-only', workflow: { delegatesAgents: true } },
    standalone,
  })
    .modelStandaloneTools()
    .map((tool) => tool.name);
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
    ['read', 'apply_patch', 'load_tool', 'cwd']
  );
});

test('Goal is deferred but remains discoverable on the native Lead tool surface', () => {
  const surface = surfaceFor({
    standalone: GOAL_TOOL_DEFS,
    provider: 'openai-oauth',
  }).activeToolSurface();
  assert.deepEqual(
    surface.tools.map((tool) => tool.name),
    []
  );
  assert.equal(surface.deferredCallableTools.includes('goal'), false);
  assert.equal(
    surface.deferredToolCatalog.some((tool) => tool.name === 'goal'),
    true
  );
  assert.equal(
    (surface.deferredToolCatalog || []).some((tool) => tool.name === 'create_goal'),
    false
  );
});

test('headless tool profile keeps task-scoped tools and removes persistent or interactive tools', () => {
  const standalone = [
    { name: 'read' },
    { name: 'load_tool' },
    { name: 'office' },
    { name: 'tidy' },
    { name: 'git' },
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

  for (const name of ['read', 'load_tool', 'office', 'tidy', 'git', 'web_search']) {
    assert.equal(catalogNames.has(name), true, `${name} should remain available`);
  }
  assert.equal(activeNames.has('office'), false);
  assert.equal(activeNames.has('tidy'), false);
  assert.equal(activeNames.has('git'), true);
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
  const visible = new Set([...session.tools.map((tool) => tool.name), ...(session.deferredCallableTools || [])]);
  assert.equal(visible.has('goal'), true);
  assert.equal(visible.has('update_goal'), false);
});

test('empty session refresh strips denied tools and BP1 routes', async () => {
  const session = {
    id: 'sess_empty',
    schemaAllowedTools: modelToolSchemaAllowlist('headless'),
    messages: [
      {
        role: 'system',
        content:
          '# Tool Use\nweb/current→`web_search`; returned URL body→`web_fetch`;\nprior work→`recall` (history only, never current local state);\ndurable compact English memory→`memory`;\n',
      },
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
      summary: {
        id: 'solo',
        name: 'Solo',
        description: 'Lead works alone.',
        source: 'built-in',
        delegatesAgents: false,
      },
      context: '# Active Workflow: Solo — Lead works alone.',
    }),
    invalidatePreSessionToolSurface: () => {},
  });
  const bp1BeforeRefresh = session.messages[0];
  const bp3BeforeRefresh = session.messages[2];
  const result = await refreshEmptySessionToolPolicy();
  assert.equal(result.appliedToCurrentSession, true);
  assert.equal(session.workflow.delegatesAgents, false);
  assert.deepEqual(
    session.tools.map((tool) => tool.name),
    ['read']
  );
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
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
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
  assert.deepEqual(
    session.tools.map((tool) => tool.name),
    ['agent', 'web_search']
  );
});
