// Records Node's `reconcileEmptySession` (`tool-policy-refresh.mjs`: `reconcileTurnSettings` ->
// `stagePolicy` + `applyPolicy`, `applyToolDenials`) over sessions as `composeSessionSystem` +
// `seedSessionMessages` build them: a Lead and delegated workers (plain, hidden with and without an
// allowlist, tool-free), and the sessions the reconcile leaves alone (a conversation, a running
// turn). The Rust `LeadSurfaceHost::reconcile_empty` must leave the same tool surface, denials and
// workflow on the same sessions; the prompt text is the composition's (its own goldens).
//
//   node benchmarks/rust-core/recorders/record-surface-reconcile.mjs --tree <dir with node_modules>
//
// Output: native/core/fixtures/surface-reconcile/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'surface-reconcile-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const { nodeRealTool, nodeToolDefinitions, writeJsonCompact } = await import('./lib/tool-definitions.mjs');
const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'surface-reconcile');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-surface-reconcile.mjs';
const at = (path) => importFrom(tree, path);
const { createToolPolicyRefresh } = await at('src/session-runtime/tool-policy-refresh.mjs');
const { composeSessionSystem, seedSessionMessages } = await at('src/runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs');

// The product's own definitions: the tools a session holds, and `standaloneTools`, which `modelStandaloneTools()` offers.
const real = await nodeRealTool(tree);
const { standaloneTools } = await nodeToolDefinitions(tree);
const doc = (name) => real(name);
const TOOLS = ['read', 'grep', 'edit', 'shell', 'agent', 'ask_user', 'session', 'web_search', 'web_fetch', 'memory', 'recall', 'load_tool', 'todo'];
const STANDALONE = standaloneTools.map((tool) => structuredClone(tool));
const CATALOG = TOOLS.map((name) => doc(name));
const FEATURE_DENIED = ['web_search', 'web_fetch', 'memory', 'recall'];

function sessionOf({ owner, agent, schemaAllowedTools, messages = null, liveTurnMessages = null, provider = 'anthropic' }) {
  const prompt = composeSessionSystem(
    { owner, systemPrompt: '', workflow: { delegatesAgents: true }, workflowContext: '# Active Workflow: Old', orchestrationMode: 'focused' },
    {
      profile: { skip: {} },
      providerName: provider,
      modelName: 'claude-opus-4-6',
      surface: { ownerIsAgent: owner === 'agent', resolvedAgent: agent, skills: [], toolsForRouting: [], ruleOmitTools: [], schemaAllowedTools },
    }
  );
  const tools = TOOLS.slice(0, 9).map((name) => doc(name));
  const session = {
    id: `sess_${owner}_${agent ?? 'none'}`,
    owner,
    agent,
    provider,
    model: 'claude-opus-4-6',
    schemaAllowedTools,
    promptIdentity: prompt.promptIdentity,
    callerDisallowedTools: ['get_goal'],
    disallowedTools: ['get_goal'],
    messages: messages ?? seedSessionMessages(prompt, []),
    tools,
    deferredToolCatalog: CATALOG,
    deferredCallableTools: tools.map((tool) => tool.name),
    workflow: { id: 'default', name: 'Default', description: '', source: 'built-in', delegatesAgents: true },
    orchestrationMode: 'focused',
    bp3CoreContext: prompt.sessionMarkerCore,
    bp3EnvSplit: true,
    bp3EnvironmentContext: prompt.environmentTailContext,
  };
  if (liveTurnMessages) session.liveTurnMessages = liveTurnMessages;
  return JSON.parse(JSON.stringify(session));
}

const names = (list) => (Array.isArray(list) ? list : []).map((tool) => (typeof tool === 'string' ? tool : tool.name));
const SOLO = { id: 'solo', name: 'Solo', description: 'Lead works alone.', source: 'built-in', delegatesAgents: false };
const SCENARIOS = [
  ['a Lead takes the workflow and the closed gates', { owner: 'user', agent: 'lead', schemaAllowedTools: null }],
  ['a Lead on the bridge route', { owner: 'user', agent: 'lead', schemaAllowedTools: null, provider: 'grok-oauth' }],
  ['a Lead with an allowlist keeps it', { owner: 'user', agent: 'lead', schemaAllowedTools: ['read', 'grep', 'agent'] }],
  ['a plain worker', { owner: 'agent', agent: 'worker', schemaAllowedTools: null }],
  ['a plain worker ignores a caller allowlist', { owner: 'agent', agent: 'worker', schemaAllowedTools: ['read', 'grep', 'agent'] }],
  ['a hidden worker honors its allowlist', { owner: 'agent', agent: 'title-agent', schemaAllowedTools: ['read', 'grep', 'agent'] }],
  ['a tool-free hidden worker', { owner: 'agent', agent: 'title-agent', schemaAllowedTools: [] }],
  ['a conversation is left alone', { owner: 'user', agent: 'lead', schemaAllowedTools: null, messages: 'conversation' }],
  ['a running turn is left alone', { owner: 'user', agent: 'lead', schemaAllowedTools: null, turns: 1 }],
];

const cases = [];
for (const [name, spec] of SCENARIOS) {
  const base = sessionOf({ ...spec, messages: null });
  const session = spec.messages === 'conversation' ? { ...base, messages: [...base.messages, { role: 'user', content: 'hello' }] } : structuredClone(base);
  const before = structuredClone(session);
  const refresh = createToolPolicyRefresh({
    getSession: () => session,
    getRoute: () => ({ provider: spec.provider ?? 'anthropic', model: 'claude-opus-4-6' }),
    getMode: () => 'full',
    getConfig: () => ({}),
    getDataDir: () => sandbox,
    getActiveTurnCount: () => spec.turns ?? 0,
    modelStandaloneTools: () => STANDALONE,
    featureDisallowedTools: () => FEATURE_DENIED,
    loadCoreMemoryContext: async () => '- Keep honorific speech.',
    loadInstructionFilesContext: () => '',
    activeWorkflowContext: () => ({ summary: SOLO, packContext: '# Active Workflow: Solo', leadPromptParts: () => ({}), orchestrationMode: 'none' }),
    invalidatePreSessionToolSurface: () => {},
  });
  const result = await refresh.reconcileEmptySession();
  const out = (s) => ({
    tools: names(s.tools),
    catalog: names(s.deferredToolCatalog),
    callable: names(s.deferredCallableTools),
    discovered: names(s.deferredDiscoveredTools),
    disallowedTools: s.disallowedTools,
    workflow: s.workflow,
    orchestrationMode: s.orchestrationMode,
    sessionMode: s.sessionMode ?? null,
  });
  const noMessages = ({ messages, ...rest }) => rest;
  cases.push({
    name,
    reconciled: result !== null,
    // The session as it was and the roles of its system messages, then as it is.
    before: noMessages(before),
    beforeMessages: before.messages,
    after: out(session),
    featureDenied: FEATURE_DENIED,
    workflowSummary: SOLO,
    orchestrationMode: 'none',
    // Node's `getRoute()`, which the rebuilt BP1 and the deferred surface read.
    route: { provider: spec.provider ?? 'anthropic', model: 'claude-opus-4-6' },
  });
}
await writeJsonCompact(tree, join(stage, 'golden.json'), { standalone: STANDALONE, cases });
writeSetManifest(stage, { set: 'surface-reconcile', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
