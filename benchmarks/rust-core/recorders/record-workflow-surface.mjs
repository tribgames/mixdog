#!/usr/bin/env node
// Golden of the gated half of the workflow surface: `native/core/fixtures/workflow-surface/surface.json`.
//
// - `features`: `featureDisallowedToolsFor(withGrandfatheredBuiltins(config), ...)`
//   (`runtime-core/builtin-features.mjs`) for configs, MIXDOG_FEATURE_* overrides, desktop bridge
//   presence, git on PATH and tool profiles.
// - `denied`: `liveDeniedTools(session, workflow)` of `createPolicyStage` (`tool-policy/policy-stage.mjs`).
// - `standaloneTools` / `standalone`: the product's own standalone tool definitions (name, description,
//   inputSchema, annotations as Node holds them), and which of them `modelStandaloneTools()` of
//   `createToolSurface` (`session-runtime/tool-surface.mjs`) offers a session (the recorder checks the
//   surface hands out those very objects).
// - `targets`: `activeWorkflowContext(configForSession(config, id, mode), dir)` with `leadPartsFor` over a
//   sandboxed install (the `target` of the Rust surface).
//
//   node benchmarks/rust-core/recorders/record-workflow-surface.mjs --tree <tree>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';
import { nodeToolDefinitions } from './lib/tool-definitions.mjs';

const tree = resolveTree(parseArgs());
const sandbox = mkdtempSync(join(tmpdir(), 'mixdog-workflow-surface-'));
for (const [name, dir] of [['HOME', 'home'], ['USERPROFILE', 'home'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata']]) {
  mkdirSync(join(sandbox, dir), { recursive: true });
  process.env[name] = join(sandbox, dir);
}
process.env.MIXDOG_HOME = join(sandbox, 'mixdog-home');
process.env.MIXDOG_DATA_DIR = join(sandbox, 'mixdog-home', 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

const rc = 'src/runtime/agent/orchestrator/runtime-core/';
const { featureDisallowedToolsFor, withGrandfatheredBuiltins } = await importFrom(tree, `${rc}builtin-features.mjs`);
const { createWorkflowHelpers } = await importFrom(tree, `${rc}workflow.mjs`);
const { normalizeAgentPermissionOrNone, readMarkdownDocument } = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');
const { createPolicyStage } = await importFrom(tree, 'src/session-runtime/tool-policy/policy-stage.mjs');
const { createToolSurface } = await importFrom(tree, 'src/session-runtime/tool-surface.mjs');
const { configForSession, configForWorkflow, leadPartsFor } = await importFrom(tree, 'src/session-runtime/tool-policy/surface-helpers.mjs');

// ---- features -----------------------------------------------------------------------------------

const FEATURE_ENV = ['WEB_SEARCH', 'MEMORY', 'GIT', 'OFFICE', 'TIDY', 'MEDIA', 'BROWSER', 'COMPUTER', 'TERMINAL', 'VISUALIZE', 'LOCAL_PROVIDER', 'AUTO_EFFORT'].map((name) => `MIXDOG_FEATURE_${name}`);
const INSTALLED = { builtins: { git: { installed: true }, memory: { installed: true }, office: { installed: true }, tidy: { installed: true } } };
const EXPLORE = { agents: { explore: { provider: 'openai', model: 'gpt-5' } } };
const NO_FACTS = { browser: false, computer: false, terminal: false, visualize: false, git: false };
const ALL_FACTS = { browser: true, computer: true, terminal: true, visualize: false, git: true };
const feature = (name, config, { env = {}, facts = NO_FACTS, profile = 'interactive' } = {}) => ({ name, config, env, facts, profile });

const FEATURES = [
  feature('empty-config-nothing-installed', {}),
  feature('empty-config-with-git-on-path', {}, { facts: { ...NO_FACTS, git: true } }),
  feature('everything-installed-and-present', { ...INSTALLED, ...EXPLORE }, { facts: ALL_FACTS }),
  feature('grandfathered-profile', { presets: [], default: 'x' }, { facts: ALL_FACTS }),
  feature('explicit-empty-builtins', { presets: [], builtins: {} }, { facts: ALL_FACTS }),
  feature('modules-switched-off', { ...INSTALLED, ...EXPLORE, modules: { webSearch: { enabled: false }, git: { enabled: false }, office: { enabled: false }, tidy: { enabled: false }, media: { enabled: false }, visualize: { enabled: false } } }, { facts: ALL_FACTS }),
  feature('modules-entry-without-enabled', { ...INSTALLED, modules: { git: {}, office: 'no', media: { enabled: null } } }, { facts: ALL_FACTS }),
  feature('memory-tools-off', { ...INSTALLED, memoryTools: { enabled: false } }),
  feature('memory-tools-entry-not-an-object', { ...INSTALLED, memoryTools: false }),
  feature('reactions-off', { ...INSTALLED, reactions: false }),
  feature('reactions-not-false', { ...INSTALLED, reactions: 0 }),
  feature('explore-route-incomplete', { ...INSTALLED, agents: { explore: { provider: 'openai' } } }),
  feature('explore-route-padded', { ...INSTALLED, agents: { explore: { provider: ' openai ', model: ' m ' } } }),
  feature('explore-route-is-a-preset-name', { ...INSTALLED, agents: { explore: 'preset-1' } }),
  feature('explore-route-is-an-array', { ...INSTALLED, agents: { explore: [{ provider: 'p', model: 'm' }] } }),
  feature('explore-switched-off', { ...INSTALLED, ...EXPLORE, disabledAgents: ['explore'] }),
  feature('explore-switched-off-by-another-spelling', { ...INSTALLED, ...EXPLORE, disabledAgents: [' Explore '] }),
  feature('bridges-by-env', {}, { env: { MIXDOG_FEATURE_BROWSER: '1', MIXDOG_FEATURE_COMPUTER: 'yes', MIXDOG_FEATURE_TERMINAL: 'on' } }),
  feature('bridges-off-by-env', {}, { facts: ALL_FACTS, env: { MIXDOG_FEATURE_BROWSER: '0', MIXDOG_FEATURE_COMPUTER: 'false', MIXDOG_FEATURE_TERMINAL: ' NO ' } }),
  feature('empty-env-is-no-override', { ...INSTALLED }, { facts: ALL_FACTS, env: { MIXDOG_FEATURE_BROWSER: '', MIXDOG_FEATURE_GIT: '  ' } }),
  feature('env-wins-over-the-config', { ...INSTALLED, modules: { webSearch: { enabled: false } } }, {
    env: { MIXDOG_FEATURE_WEB_SEARCH: '1', MIXDOG_FEATURE_MEMORY: '0', MIXDOG_FEATURE_GIT: 'off', MIXDOG_FEATURE_OFFICE: 'false', MIXDOG_FEATURE_TIDY: '0', MIXDOG_FEATURE_MEDIA: 'no', MIXDOG_FEATURE_VISUALIZE: '1' },
  }),
  feature('env-installs-what-the-config-lacks', {}, { env: { MIXDOG_FEATURE_MEMORY: '1', MIXDOG_FEATURE_GIT: '1', MIXDOG_FEATURE_OFFICE: 'true', MIXDOG_FEATURE_TIDY: 'on' } }),
  feature('visualize-bridge-present', {}, { facts: { ...NO_FACTS, visualize: true } }),
  feature('visualize-bridge-present-module-off', { modules: { visualize: { enabled: false } } }, { facts: { ...NO_FACTS, visualize: true } }),
  feature('headless-everything-denied', {}, { profile: 'headless' }),
  feature('headless-with-everything-active', { ...INSTALLED, ...EXPLORE }, { facts: ALL_FACTS, profile: 'headless', env: { MIXDOG_FEATURE_VISUALIZE: '1' } }),
  feature('headless-one-listed-tool-active', { ...INSTALLED, ...EXPLORE, modules: { webSearch: { enabled: false } } }, { facts: ALL_FACTS, profile: 'headless' }),
  feature('headless-all-listed-denied-git-present', { builtins: {}, modules: { webSearch: { enabled: false } } }, { facts: { ...NO_FACTS, git: true }, profile: 'headless' }),
  feature('headless-all-listed-denied-git-absent', { builtins: {}, modules: { webSearch: { enabled: false } } }, { profile: 'headless' }),
  feature('headless-all-listed-denied-by-env', { ...INSTALLED }, { profile: 'headless', env: { MIXDOG_FEATURE_WEB_SEARCH: '0', MIXDOG_FEATURE_OFFICE: '0', MIXDOG_FEATURE_TIDY: '0', MIXDOG_FEATURE_GIT: '0' } }),
  feature('interactive-all-listed-denied', { builtins: {}, modules: { webSearch: { enabled: false } } }),
  feature('heartbeat-profile', {}, { profile: 'heartbeat' }),
  feature('unknown-profile-is-interactive', {}, { profile: 'bogus' }),
];

function recordFeatures(index, scenario) {
  const saved = Object.fromEntries(FEATURE_ENV.map((name) => [name, process.env[name]]));
  for (const name of FEATURE_ENV) delete process.env[name];
  Object.assign(process.env, scenario.env);
  try {
    if (scenario.facts.visualize) {
      const dir = join(sandbox, `bridges-${index}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'visualize-bridge.json'), JSON.stringify({ version: 1, port: 40123, token: 'golden-token', pid: process.pid }));
      process.env.MIXDOG_BRIDGE_DISCOVERY_DIR = dir;
    }
    return featureDisallowedToolsFor(withGrandfatheredBuiltins(scenario.config), {
      browserAvailable: scenario.facts.browser,
      computerAvailable: scenario.facts.computer,
      terminalAvailable: scenario.facts.terminal,
      gitAvailable: scenario.facts.git,
      toolProfile: scenario.profile,
    });
  } finally {
    delete process.env.MIXDOG_BRIDGE_DISCOVERY_DIR;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// ---- live denied tools --------------------------------------------------------------------------

const HOME_BOT = 'sess_home_botty';
const MEMBER = 'sess_rmem_abcdef_botty';
const WORKFLOWS = {
  delegating: { id: 'review', name: 'Review', description: '', source: 'user', delegatesAgents: true },
  solo: { id: 'default', name: 'Default', description: '', source: 'built-in', delegatesAgents: false },
  configuredEmpty: { id: 'x', name: 'X', agentsConfigured: true, agents: [] },
  configuredFull: { id: 'x', name: 'X', agentsConfigured: true, agents: ['worker'] },
  agentsNotArray: { id: 'x', agentsConfigured: true, agents: 'none' },
  bare: {},
  none: null,
};
const DENIED = [
  { name: 'coding-session', session: { id: 'sess_task', callerDisallowedTools: ['get_goal', 'create_goal'] }, workflow: 'delegating', features: ['web_search'] },
  { name: 'coding-session-no-delegation', session: { id: 'sess_task', callerDisallowedTools: [] }, workflow: 'solo', features: [] },
  { name: 'bot-home-chat', session: { id: HOME_BOT, callerDisallowedTools: ['get_goal'] }, workflow: 'delegating', features: ['memory', 'recall'] },
  { name: 'bot-home-chat-solo-keeps-no-agent', session: { id: HOME_BOT, callerDisallowedTools: [] }, workflow: 'solo', features: [] },
  { name: 'bot-home-chat-stored-coding-mode', session: { id: HOME_BOT, sessionMode: 'coding', callerDisallowedTools: [] }, workflow: 'solo', features: [] },
  { name: 'room-member-seat', session: { id: MEMBER, callerDisallowedTools: [] }, workflow: 'solo', features: ['git'] },
  { name: 'owner-by-agent-in-a-home-id', session: { id: HOME_BOT, owner: ' Agent ', callerDisallowedTools: [] }, workflow: 'solo', features: [] },
  { name: 'agent-owner-room-seat', session: { id: MEMBER, owner: 'agent', callerDisallowedTools: [] }, workflow: 'delegating', features: [] },
  { name: 'owner-agent-session', session: { id: 'sess_w', owner: 'agent', callerDisallowedTools: ['agent'] }, workflow: 'delegating', features: ['react', 'agent'] },
  { name: 'agent-mode-by-owner-agent-id', session: { id: 'sess_x', ownerAgentId: 'botty', callerDisallowedTools: [] }, workflow: 'solo', features: [] },
  { name: 'configured-empty-agents', session: { id: 'sess_task', callerDisallowedTools: [] }, workflow: 'configuredEmpty', features: [] },
  { name: 'configured-full-agents', session: { id: 'sess_task', callerDisallowedTools: [] }, workflow: 'configuredFull', features: [] },
  { name: 'agents-not-an-array', session: { id: 'sess_task', callerDisallowedTools: [] }, workflow: 'agentsNotArray', features: [] },
  { name: 'workflow-bare', session: { id: 'sess_task', callerDisallowedTools: [] }, workflow: 'bare', features: [] },
  { name: 'workflow-null', session: { id: HOME_BOT, callerDisallowedTools: [] }, workflow: 'none', features: [] },
  { name: 'odd-names-are-text-or-dropped', session: { id: 'sess_task', callerDisallowedTools: ['', null, 0, false, 7, 'Shell', ' padded ', 'agent'] }, workflow: 'delegating', features: ['', 'x', 'x'] },
  { name: 'duplicates-are-kept', session: { id: 'sess_task', callerDisallowedTools: ['a', 'a'] }, workflow: 'delegating', features: ['a', 'react'] },
  { name: 'no-id', session: { callerDisallowedTools: [] }, workflow: 'delegating', features: [] },
  { name: 'caller-denials-missing', session: { id: 'sess_task' }, workflow: 'delegating', features: [] },
  { name: 'caller-denials-null', session: { id: 'sess_task', callerDisallowedTools: null }, workflow: 'delegating', features: [] },
  { name: 'caller-denials-a-number', session: { id: 'sess_task', callerDisallowedTools: 3 }, workflow: 'delegating', features: [] },
  { name: 'caller-denials-an-object', session: { id: 'sess_task', callerDisallowedTools: { a: 1 } }, workflow: 'delegating', features: [] },
  { name: 'caller-denials-true', session: { id: 'sess_task', callerDisallowedTools: true }, workflow: 'delegating', features: [] },
  { name: 'caller-denials-a-string-spreads-into-characters', session: { id: 'sess_task', callerDisallowedTools: 'a\u{1f600}b' }, workflow: 'delegating', features: [] },
  { name: 'caller-denials-an-empty-string', session: { id: 'sess_task', callerDisallowedTools: '' }, workflow: 'delegating', features: [] },
  { name: 'caller-denials-missing-on-a-bot-chat', session: { id: HOME_BOT }, workflow: 'solo', features: ['x'] },
];

// Node throws on a session record without an iterable `callerDisallowedTools` (a spread of
// `undefined`, `null`, a number or an object): recorded as `{ threw: true }`.
function recordDenied(scenario) {
  const stage = createPolicyStage({ getDataDir: () => sandbox, featureDisallowedTools: () => scenario.features });
  try {
    return { tools: stage.liveDeniedTools(scenario.session, WORKFLOWS[scenario.workflow]) };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { threw: true };
  }
}

// ---- standalone tools ---------------------------------------------------------------------------

// The product's own standalone tool definitions (`wireToolSurface` in `boot/tools.mjs`), whole.
const { standaloneTools: STANDALONE_TOOLS, agentToolNames: AGENT_TOOL_NAMES } = await nodeToolDefinitions(tree);
const standalone = (name, session, { profile = 'interactive', features = [], delegatable = 1 } = {}) => ({ name, session, profile, features, delegatable });
const STANDALONE = [
  standalone('no-session-delegatable', null),
  standalone('no-session-none-delegatable', null, { delegatable: 0 }),
  standalone('session-with-id', { id: 'sess_task', workflow: { id: 'review', delegatesAgents: true }, orchestrationMode: 'balanced' }),
  standalone('session-without-agents-in-agent-mode', { id: 'sess_home_botty', workflow: { id: 'x', delegatesAgents: false } }),
  standalone('session-without-agents-in-coding-mode', { id: 'sess_task', workflow: { id: 'x', delegatesAgents: false } }),
  standalone('session-configured-empty', { id: 'sess_task', workflow: { id: 'x', agentsConfigured: true, agents: [] } }),
  standalone('session-prompt-workflow-wins', { id: 'sess_home_botty', workflow: { id: 'a', delegatesAgents: true }, workflowOverlay: { prompt: { id: 'b', delegatesAgents: false } } }),
  standalone('session-prompt-workflow-allows', { id: 'sess_home_botty', workflow: { id: 'a', delegatesAgents: false }, workflowOverlay: { prompt: { id: 'b', delegatesAgents: true } } }),
  standalone('session-only-a-mode', { orchestrationMode: 'none' }),
  standalone('session-empty-object', {}),
  standalone('session-agent-home-no-id', { sessionMode: 'agent' }, { delegatable: 0 }),
  standalone('session-agent-home-no-id-agents', { sessionMode: 'agent' }, { delegatable: 3 }),
  standalone('agent-owned', { id: 'sess_w', owner: 'agent', workflow: { id: 'a', delegatesAgents: true } }),
  standalone('agent-only-visibility', { id: 'sess_w', visibility: 'agent-only' }),
  standalone('features-denied', { id: 'sess_task' }, { features: ['web_search', 'web_fetch', 'memory', 'recall', 'git'] }),
  standalone('features-denied-padded-names', { id: 'sess_task' }, { features: [' git', 'GITHUB', 'office'] }),
  standalone('headless', { id: 'sess_task' }, { profile: 'headless' }),
  standalone('headless-features', { id: 'sess_task' }, { profile: 'headless', features: ['git', 'web_fetch', 'load_tool'] }),
  standalone('heartbeat', { id: 'sess_task' }, { profile: 'heartbeat' }),
  standalone('heartbeat-agent-owned', { id: 'sess_w', owner: 'agent' }, { profile: 'heartbeat' }),
  standalone('unknown-profile', { id: 'sess_task' }, { profile: 'bogus' }),
];

function recordStandalone(scenario) {
  const surface = createToolSurface({
    mgr: {},
    mode: 'lead',
    standaloneTools: STANDALONE_TOOLS,
    agentToolNames: AGENT_TOOL_NAMES,
    getSession: () => scenario.session,
    getRoute: () => ({}),
    getConfig: () => ({}),
    getToolProfile: () => scenario.profile,
    cfgMod: { getPluginData: () => sandbox },
    delegatableAgentIds: () => Array.from({ length: scenario.delegatable }, (_, i) => `a${i}`),
    dataDir: sandbox,
    getFeatureDisallowedTools: () => scenario.features,
  });
  // The surface hands out the definition objects themselves: their projection is the table's.
  return surface.modelStandaloneTools().map((tool) => {
    if (STANDALONE_TOOLS.find((known) => known.name === tool.name) !== tool) throw new Error(`${tool.name} is not the listed definition`);
    return tool.name;
  });
}

// ---- targets ------------------------------------------------------------------------------------

const pack = (fields, body) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`;
const TARGET_ROOT = {
  'workflows/default/WORKFLOW.md': pack({ name: 'Default', description: 'The shipped default' }, '# Default\n\nShipped default body.\n'),
  'workflows/headless/WORKFLOW.md': pack({ name: 'Headless', description: 'No agents' }, '# Headless\n\nShipped headless.\n'),
  'agents/worker/AGENT.md': 'Worker body.',
  'agents/worker/agent.json': JSON.stringify({ name: 'Worker', description: 'Does the work' }),
  ...Object.fromEntries(['none', 'focused', 'balanced', 'swarm'].map((mode) => [`orchestration/${mode}.md`, `Orchestration text of ${mode}.\r\n`])),
};
const TARGET_DATA = {
  'workflows/review/WORKFLOW.md': pack({ name: 'Review', description: 'Checks twice' }, '# Review\n\nRead twice.\n'),
  'agents/botty/AGENT.md': '---\nkind: bot\n---\nBot body.',
  'agents/botty/agent.json': JSON.stringify({ name: 'Botty', description: 'Chats' }),
  'agents/lead/agent.json': JSON.stringify({ name: 'Mimi' }),
};
const TARGET_CONFIG = { orchestrationMode: 'swarm', workflow: { active: 'headless' } };
const TARGET_SESSIONS = [{ id: 'sess_task' }, { id: HOME_BOT }, { id: 'sess_x', owner: 'agent' }];
const TARGET_CALLS = [];
for (const workflowId of ['review', 'default', 'headless', 'solo', 'Review', 'nope', '']) {
  for (const mode of [null, 'none', 'focused', 'balanced', 'swarm', 'bogus']) {
    for (const session of TARGET_SESSIONS) TARGET_CALLS.push({ workflowId, mode, session });
  }
}

function lay(folder, files) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(folder, ...path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

function recordTargets() {
  const root = join(sandbox, 'target', 'root');
  const data = join(sandbox, 'target', 'data');
  mkdirSync(root, { recursive: true });
  mkdirSync(data, { recursive: true });
  process.env.MIXDOG_ROOT = root;
  process.env.MIXDOG_DATA_DIR = data;
  lay(root, TARGET_ROOT);
  lay(data, TARGET_DATA);
  const helpers = createWorkflowHelpers({ rootDir: root, dataDir: () => data, readMarkdownDocument, normalizeAgentPermissionOrNone });
  const calls = TARGET_CALLS.map((call) => {
    const config = call.mode === null ? configForWorkflow(TARGET_CONFIG, call.workflowId) : configForSession(TARGET_CONFIG, call.workflowId, call.mode);
    const target = helpers.activeWorkflowContext(config, data);
    const parts = leadPartsFor(call.session, target.leadPromptParts);
    return {
      ...call,
      target: {
        summary: target.summary,
        orchestrationMode: target.orchestrationMode,
        packContext: target.packContext,
        orchestrationContext: parts.orchestrationContext,
        agentCatalogContext: parts.agentCatalogContext,
        contactCatalogContext: parts.contactCatalogContext,
      },
    };
  });
  return { root: TARGET_ROOT, data: TARGET_DATA, config: TARGET_CONFIG, calls };
}

const features = FEATURES.map((scenario, index) => ({ ...scenario, denied: recordFeatures(index, scenario) }));
const denied = DENIED.map((scenario) => ({ ...scenario, workflow: WORKFLOWS[scenario.workflow], ...recordDenied(scenario) }));
const standaloneRows = STANDALONE.map((scenario) => ({ ...scenario, tools: recordStandalone(scenario) }));
const targets = recordTargets();
rmSync(sandbox, { recursive: true, force: true });
writeJson(join(FIXTURES_ROOT, 'workflow-surface', 'surface.json'), {
  standaloneTools: STANDALONE_TOOLS,
  agentTools: [...AGENT_TOOL_NAMES],
  features,
  denied,
  standalone: standaloneRows,
  targets,
});
console.log(`recorded ${features.length} feature, ${denied.length} denied, ${standaloneRows.length} standalone, ${targets.calls.length} target cases`);
