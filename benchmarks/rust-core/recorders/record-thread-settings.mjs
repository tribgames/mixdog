#!/usr/bin/env node
// Golden twins of the thread settings methods, each recorded from the real Node functions:
//  - route-set-wire.json: what `route/set` hands the runtime. The desktop's `setRoute`
//    (tui/session/session-api/routes-write.mjs `createRouteWrite`) over a fake runtime that records
//    the arguments of `runtime.setRoute`, for each request shape and selected route.
//
//   node benchmarks/rust-core/recorders/record-thread-settings.mjs --tree <dir>
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const SET = 'thread-settings';
const stage = stageSet(join(FIXTURES_ROOT, SET));

const { createRouteWrite } = await importFrom(tree, 'src/tui/session/session-api/routes-write.mjs');

const SELECTED = { provider: 'openai', model: 'gpt-5', effort: 'high', fast: true, autoEffort: false };
const routeCases = [];
const requests = [
  { provider: 'anthropic', model: 'claude-x' },
  { provider: 'anthropic', model: 'claude-x', effort: 'low', fast: false, applyToCurrentSession: true },
  { provider: 'openai', model: 'gpt-5', keepMainModel: false },
  { provider: 'openai', model: 'gpt-5', onlyIfEmpty: true },
  { provider: 'openai', model: 'gpt-5', sessionOnly: true },
  { provider: 'openai', model: 'gpt-5', sessionOnly: true, effort: 'high' },
  { provider: 'openai', model: 'gpt-5', sessionOnly: true, effort: 'low' },
  { provider: 'openai', model: 'gpt-5', sessionOnly: true, fast: true, autoEffort: false },
  { provider: 'openai', model: 'gpt-5', sessionOnly: true, fast: false },
  { provider: 'openai', model: 'gpt-5', sessionOnly: true, autoEffort: true },
  { provider: 'anthropic', model: 'claude-x', sessionOnly: true },
  { provider: 'anthropic', model: 'claude-x', sessionOnly: true, effort: 'medium', fast: true },
  { effort: 'low', sessionOnly: true },
  { fast: false, sessionOnly: true },
  { fast: true, sessionOnly: true },
  { effort: 'high', sessionOnly: true },
  { model: 'gpt-5-mini', sessionOnly: true },
  { provider: 'openai', model: 'gpt-5', sessionOnly: true, contextPercent: 50 },
  { provider: 'openai', model: 'gpt-5', sessionOnly: true, keepMainModel: false, applyToCurrentSession: true },
  { provider: 'anthropic', model: 'claude-x', modelParameters: { thinking: 'on' }, contextTokens: 100000, fallbacks: [{ provider: 'openai', model: 'gpt-5' }] },
  { provider: 'openai', model: 'gpt-5', applyToCurrentSession: false, keepMainModel: true, sessionOnly: false, onlyIfEmpty: false },
];
const selecteds = [
  SELECTED,
  { ...SELECTED, sessionProvider: 'anthropic', sessionModel: 'claude-x' },
  { ...SELECTED, sessionProvider: 'openai', sessionModel: 'gpt-5' },
  { provider: 'openai', model: 'gpt-5' },
];
for (const selected of selecteds) {
  for (const request of requests) {
    const calls = [];
    const runtime = {
      sessionGeneration: 7,
      setRoute: async (...args) => {
        calls.push(JSON.parse(JSON.stringify(args)));
        return { ...selected };
      },
    };
    const state = { commandBusy: false, ...selected };
    const setRoute = createRouteWrite(
      { pushItem() {}, nextId: () => 'x' },
      {
        runtime,
        getState: () => state,
        set() {},
        flushEmitImmediate() {},
        routeState: () => selected,
        syncContextStats() {},
        publishRoute() {},
      }
    )
    const result = await setRoute(request);
    routeCases.push({ selected, request, runtimeCalls: calls, result: JSON.parse(JSON.stringify(result ?? null)) });
  }
}
writeJson(join(stage, 'route-set-wire.json'), { cases: routeCases });

// --- setWorkflow / setOrchestrationMode / setOutputStyle / switchContext ---
// The real `createWorkflowAgentsApi` (packs, style and mode) and `createContextSwitch` over fake
// session deps: what the session answers (`switchSessionWorkflow`, `switchSessionOrchestrationMode`,
// `settingsReachCurrentSession`) is each scenario's, the config file and the packs are real.
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
const s = 'src/session-runtime/';
const rc = 'src/runtime/agent/orchestrator/runtime-core/';
const { createWorkflowAgentsApi } = await importFrom(tree, `${s}workflow-agents-api.mjs`);
const { outputStyleStatus } = await importFrom(tree, `${s}output-styles.mjs`);
const { createContextSwitch } = await importFrom(tree, `${s}lifecycle/session-switch/context-switch.mjs`);
const wf = await importFrom(tree, `${rc}workflow.mjs`);
const cfgReal = await importFrom(tree, 'src/runtime/agent/orchestrator/config.mjs');
const { withGrandfatheredBuiltins } = await importFrom(tree, `${rc}builtin-features.mjs`);
const md = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');
const { configWithOutputStyle } = await importFrom(tree, `${s}config-lifecycle/config-writers.mjs`);

const shippedRoot = join(stage, 'shipped');
mkdirSync(shippedRoot, { recursive: true });
cpSync(join(tree, 'src', 'workflows'), join(shippedRoot, 'workflows'), { recursive: true });
const front = (lines) => `---\n${lines.join('\n')}\n---\nBody.\n`;
const STYLE_FILES = {
  'detailed.md': front(['description: Deep answers', 'aliases: long, full']),
  'simple.md': front(['title: Simple', 'description: Plain answers']),
  'minimal.md': front(['description: Short', 'aliases: Mini']),
  'extreme-minimal.md': front(['label: Extreme Minimal', 'aliases: xmin']),
};
mkdirSync(join(shippedRoot, 'output-styles'), { recursive: true });
for (const [name, text] of Object.entries(STYLE_FILES)) writeFileSync(join(shippedRoot, 'output-styles', name), text);

const clone = (v) => JSON.parse(JSON.stringify(v));
const user = (id, name) => ({ [`workflows/${id}/WORKFLOW.md`]: `---\nid: ${id}\nname: ${name}\ndescription: ${name} pack\n---\n# ${name}\n\nBody.\n` });
const SWITCHED_WORKFLOW = { appliedToCurrentSession: true, workflow: { id: 'review', name: 'Review' }, workflowSwitch: { fromId: 'default', from: 'Default', toId: 'review', to: 'Review', at: 1 } };
const DEFERRED_WORKFLOW = { appliedToCurrentSession: true, deferred: true, workflow: { id: 'review', name: 'Review' }, workflowSwitch: null };
const SWITCHED_MODE = { appliedToCurrentSession: true, mode: 'swarm', orchestrationModeSwitch: { from: 'balanced', to: 'swarm', at: 1 } };
const step = (method, params = {}) => ({ method, params });
const SETTINGS_SCENARIOS = [
  {
    name: 'workflow-configured',
    config: {},
    files: { ...user('review', 'Review') },
    reach: true,
    steps: [
      step('setWorkflow', { workflowId: 'review' }),
      step('setWorkflow', { workflowId: 'Review' }),
      step('setWorkflow', { workflowId: 'solo' }),
      step('setWorkflow', { workflowId: 'headless' }),
      step('setWorkflow', { workflowId: '  ' }),
      step('setWorkflow', { workflowId: 'nope' }),
      step('setWorkflow', { workflowId: '!!!' }),
      step('setWorkflow', { workflowId: 'review', options: { scope: 'global' } }),
    ],
  },
  { name: 'workflow-reach-false', config: { workflow: { active: 'review' } }, files: { ...user('review', 'Review') }, reach: false, steps: [step('setWorkflow', { workflowId: 'default' })] },
  { name: 'workflow-reach-unknown', config: {}, files: { ...user('review', 'Review') }, reach: null, steps: [step('setWorkflow', { workflowId: 'review' })] },
  {
    name: 'workflow-session-switched',
    config: { workflow: { active: 'default' } },
    files: { ...user('review', 'Review') },
    reach: false,
    switchedWorkflow: SWITCHED_WORKFLOW,
    steps: [step('setWorkflow', { workflowId: 'review', options: { scope: 'session' } }), step('setWorkflow', { workflowId: 'nope', options: { scope: 'session' } })],
  },
  {
    name: 'workflow-session-deferred',
    config: {},
    files: { ...user('review', 'Review') },
    reach: false,
    switchedWorkflow: DEFERRED_WORKFLOW,
    steps: [step('setWorkflow', { workflowId: 'review', options: { scope: 'session' } })],
  },
  {
    name: 'workflow-session-empty',
    config: {},
    files: { ...user('review', 'Review') },
    reach: true,
    switchedWorkflow: null,
    steps: [step('setWorkflow', { workflowId: 'review', options: { scope: 'session' } })],
  },
  {
    name: 'mode-configured',
    config: {},
    reach: true,
    steps: [
      step('setOrchestrationMode', { mode: 'swarm' }),
      step('setOrchestrationMode', { mode: 'none' }),
      step('setOrchestrationMode', { mode: 'balanced' }),
      step('setOrchestrationMode', { mode: 'focused', options: { scope: 'global' } }),
      step('setOrchestrationMode', { mode: 'parallel' }),
      step('setOrchestrationMode', { mode: '' }),
    ],
  },
  { name: 'mode-reach-false', config: { orchestrationMode: 'swarm' }, reach: false, steps: [step('setOrchestrationMode', { mode: 'none' })] },
  { name: 'mode-reach-unknown', config: {}, reach: null, steps: [step('setOrchestrationMode', { mode: 'focused' })] },
  { name: 'mode-session-switched', config: { orchestrationMode: 'balanced' }, reach: false, switchedMode: SWITCHED_MODE, steps: [step('setOrchestrationMode', { mode: 'swarm', options: { scope: 'session' } }), step('setOrchestrationMode', { mode: 'bogus', options: { scope: 'session' } })] },
  { name: 'mode-session-deferred', config: {}, reach: false, switchedMode: { appliedToCurrentSession: true, deferred: true, mode: 'swarm', orchestrationModeSwitch: null }, steps: [step('setOrchestrationMode', { mode: 'swarm', options: { scope: 'session' } })] },
  { name: 'mode-session-empty', config: {}, reach: true, switchedMode: null, steps: [step('setOrchestrationMode', { mode: 'swarm', options: { scope: 'session' } })] },
  {
    name: 'style',
    config: {},
    reach: true,
    steps: ['detailed', 'Simple', ' MINIMAL ', 'extreme minimal', 'xmin', 'long', 'nope', '', '---'].map((value) => step('setOutputStyle', { value })),
  },
  { name: 'style-reach-false', config: {}, rootKeys: { outputStyle: 'minimal' }, reach: false, steps: [step('setOutputStyle', { value: 'simple' }), step('setOutputStyle', { value: 'detailed' })] },
  { name: 'style-reach-unknown', config: {}, rootKeys: { outputStyle: 'detailed' }, reach: null, steps: [step('setOutputStyle', { value: 'minimal' })] },
  { name: 'style-stored-agent-copy', config: { outputStyle: 'minimal' }, rootKeys: { outputStyle: 'minimal' }, reach: true, steps: [step('setOutputStyle', { value: 'detailed' }), step('setOutputStyle', { value: 'simple' })] },
];

async function settingsRun(scenario) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ts-data-'));
  for (const [path, text] of Object.entries(scenario.files ?? {})) {
    mkdirSync(join(dataDir, path, '..'), { recursive: true });
    writeFileSync(join(dataDir, path), text);
  }
  const helpers = wf.createWorkflowHelpers({ rootDir: shippedRoot, dataDir, readMarkdownDocument: md.readMarkdownDocument, normalizeAgentPermissionOrNone: md.normalizeAgentPermissionOrNone });
  const cfgDir = mkdtempSync(join(tmpdir(), 'ts-cfg-'));
  process.env.MIXDOG_DATA_DIR = cfgDir;
  process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(cfgDir, 'backups');
  const cfgFile = join(cfgDir, 'mixdog-config.json');
  // The unified root: `agent` holds the agent config, `rootKeys` are the root's own.
  writeFileSync(cfgFile, JSON.stringify({ agent: clone(scenario.config), defaultsVersion: 2, ...(scenario.rootKeys ?? {}) }));
  const state = { config: withGrandfatheredBuiltins(clone(scenario.config)) };
  let baseline = clone(state.config);
  const adoptConfig = (next) => {
    state.config = withGrandfatheredBuiltins(next);
    return state.config;
  };
  const saveConfigAndAdopt = (next) => {
    const adopted = adoptConfig(next);
    const changes = cfgReal.createConfigPatch(baseline, adopted);
    baseline = clone(adopted);
    if (changes.length) {
      const seeds = ['builtins']
        .filter((key) => adopted[key] !== undefined && !changes.some((change) => change.path[0] === key))
        .map((key) => ({ path: [key], value: clone(adopted[key]), ifAbsent: true }));
      cfgReal.saveConfigPatch([...changes, ...seeds]);
    }
    return adopted;
  };
  const cfgMod = { ...cfgReal, getPluginData: () => dataDir };
  let outputStyleCache = null;
  const deps = {
    ...helpers,
    rootDir: shippedRoot,
    getConfig: () => state.config,
    displayConfig: () => state.config,
    cfgMod,
    STANDALONE_DATA_DIR: dataDir,
    getSession: () => ({}),
    adoptConfig,
    saveConfigAndAdopt,
    getOutputStyleStatusCached: () => outputStyleCache ?? outputStyleStatus(shippedRoot, cfgDir, { fresh: true }),
    seedOutputStyleStatusCache: (status) => {
      outputStyleCache = status;
    },
    scheduleOutputStyleSave: (id) => {
      // `flushOutputStyleSave`: the configured style is the root key.
      const root = JSON.parse(readFileSync(cfgFile, 'utf8'));
      writeFileSync(cfgFile, JSON.stringify(configWithOutputStyle(root, id)));
      outputStyleCache = null;
    },
    invalidateContextStatusCache() {},
    invalidatePreSessionToolSurface() {},
    settingsReachCurrentSession: scenario.reach === null ? () => undefined : () => scenario.reach,
    switchSessionWorkflow: 'switchedWorkflow' in scenario ? async () => clone(scenario.switchedWorkflow) : undefined,
    switchSessionOrchestrationMode: 'switchedMode' in scenario ? async () => clone(scenario.switchedMode) : undefined,
  };
  const api = createWorkflowAgentsApi(deps);
  const steps = [];
  for (const { method, params } of scenario.steps) {
    let outcome;
    try {
      const out =
        method === 'setWorkflow' ? await api.setWorkflow(params.workflowId, params.options)
        : method === 'setOrchestrationMode' ? await api.setOrchestrationMode(params.mode, params.options)
        : await api.setOutputStyle(params.value);
      outcome = { result: clone(out ?? null) };
    } catch (error) {
      outcome = { error: String(error?.message ?? error) };
    }
    const file = JSON.parse(readFileSync(cfgFile, 'utf8'));
    const { agent, defaultsVersion: _v, ...root } = file;
    steps.push({ method, params, ...outcome, agent: agent ?? {}, root });
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
  const { name, config, files, reach } = scenario;
  return { name, config, files: files ?? {}, reach, switchedWorkflow: scenario.switchedWorkflow, switchedMode: scenario.switchedMode, rootKeys: scenario.rootKeys ?? {}, steps };
}

// The runtime's own context switch over recording deps: what it does with its input.
const contextCases = [];
for (const input of [
  { cwd: '/work/a', desktopSession: { id: 'd1' } },
  { cwd: '/work/b', desktopSession: { id: 'd2' }, forResume: true },
  { cwd: '/work/c', desktopSession: 'not-an-object' },
  { cwd: '/work/d', desktopSession: null, forResume: false },
  { cwd: '/work/e', desktopSession: [1], forResume: 1 },
  { cwd: '/work/f', forResume: 0 },
  { cwd: '/work/g', forResume: '' },
  { cwd: '/work/h', forResume: 'yes' },
  { desktopSession: { id: 'd3' } },
  {},
  undefined,
]) {
  for (const open of [false, 'scratch', 'conversation']) {
    const calls = [];
    let session = open ? { id: 's1', messages: open === 'conversation' ? [{ role: 'user', content: 'hi' }] : [] } : null;
    const note = (name) => (...args) => {
      calls.push([name, ...args.map((a) => clone(a ?? null))]);
    };
    const { switchContext } = createContextSwitch(
      {
        getSession: () => session,
        setSession: (next) => {
          calls.push(['setSession', clone(next)]);
          session = next;
        },
        setRoute: note('setRoute'),
        getConfig: () => ({}),
        setDesktopSession: note('setDesktopSession'),
        createCurrentSession: async () => {},
        refreshRouteEffort: async () => calls.push(['refreshRouteEffort']),
        invalidateContextStatusCache: () => calls.push(['invalidateContextStatusCache']),
        invalidatePreSessionToolSurface: () => calls.push(['invalidatePreSessionToolSurface']),
        applyResolvedCwd: async (cwd) => calls.push(['applyResolvedCwd', cwd ?? null]),
        resolveRoute: () => ({ resolved: true }),
        clearRoutePreparation: () => calls.push(['clearRoutePreparation']),
      },
      {
        ingestSessionIntoMemory: async () => calls.push(['ingestSessionIntoMemory']),
        closeSurfaceSession: async (_session, reason, options) => calls.push(['closeSurfaceSession', reason, clone(options ?? null)]),
        releaseSessionWork: (id, reason) => calls.push(['releaseSessionWork', id, reason]),
      }
    );
    const result = await switchContext(input);
    contextCases.push({ input: input ?? null, open, result, calls });
  }
}

// ---- session-switches.json: what a workflow / orchestration-mode choice does to the thread's own
// session (`createSessionSwitches`, tool-policy/session-switches.mjs, with its real overlay,
// notice and transcript-boundary code). Only the sources the runtime wires in are stubbed: the
// workflow context (`activeWorkflowContext`), the denied-tool list and the standalone tools; the
// stub tables ride in the golden so the Rust twin reads the same ones.
const { createSessionSwitches } = await importFrom(tree, 'src/session-runtime/tool-policy/session-switches.mjs');
const NOW = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => NOW;
const SUMMARY = (id, name, extra = {}) => ({ id, name, description: `${name} pack`, source: 'built-in', delegatesAgents: true, ...extra });
const SWITCH_WORKFLOWS = {
  alpha: { summary: SUMMARY('alpha', 'Alpha'), denied: [], packContext: 'PACK alpha', orchestrationContext: 'ORCH alpha', agentCatalogContext: 'AGENTS alpha' },
  beta: { summary: SUMMARY('beta', 'Beta'), denied: ['shell'], packContext: 'PACK beta', orchestrationContext: '', agentCatalogContext: '' },
  gamma: { summary: SUMMARY('gamma', 'Gamma', { delegatesAgents: false }), denied: ['agent'], packContext: 'PACK gamma', orchestrationContext: 'ORCH gamma', agentCatalogContext: 'AGENTS gamma' },
  delta: { summary: SUMMARY('delta', 'Delta'), denied: [], packContext: 'PACK delta', orchestrationContext: 'ORCH delta', agentCatalogContext: '' },
};
const { nodeRealTool, writeJsonCompact } = await import('./lib/tool-definitions.mjs');
const realTool = await nodeRealTool(tree);
const STANDALONE = [realTool('agent'), realTool('recall')];
// A data folder with no replacement files: the shipped mode texts, as a clean install reads them.
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'ts-switch-data-'));
const { orchestrationInstructions } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/orchestration.mjs');
const SWITCH_INSTRUCTIONS = Object.fromEntries(['none', 'focused', 'balanced', 'swarm'].map((mode) => [mode, orchestrationInstructions(mode)]));
const switchSession = (over = {}) => ({
  id: 'sess_a',
  promptIdentity: { v: 1 },
  workflow: { id: 'alpha', name: 'Alpha', description: 'Alpha pack', source: 'built-in', delegatesAgents: true },
  orchestrationMode: 'balanced',
  messages: [
    { role: 'system', content: 'sys', cacheTier: 'tier3' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ],
  tools: [{ name: 'shell', description: 'Run' }, { name: 'read', description: 'Read' }],
  deferredToolCatalog: [{ name: 'agent', description: 'Delegate work' }, { name: 'recall', description: 'Recall' }],
  disallowedTools: [],
  ...over,
});
const withoutAgent = { disallowedTools: ['agent'], deferredToolCatalog: [] };
const SWITCH_SCENARIOS = [
  { name: 'no-session', session: null, ops: [['workflow', 'beta'], ['mode', 'swarm'], ['pending']] },
  { name: 'empty-conversation', session: switchSession({ messages: [{ role: 'system', content: 'sys', cacheTier: 'tier3' }] }), ops: [['workflow', 'beta'], ['mode', 'swarm']] },
  { name: 'live-turn-only', session: switchSession({ messages: [{ role: 'system', content: 'sys' }], liveTurnMessages: [{ role: 'user', content: 'first prompt' }] }), inFlight: true, ops: [['workflow', 'beta'], ['mode', 'none']] },
  { name: 'idle-workflow-round-trip', session: switchSession(), ops: [['workflow', 'beta'], ['workflow', 'beta'], ['workflow', 'alpha'], ['workflow', 'gamma'], ['workflow', 'alpha']] },
  { name: 'idle-mode-round-trip', session: switchSession(), ops: [['mode', 'swarm'], ['mode', 'swarm'], ['mode', 'none'], ['mode', 'balanced'], ['mode', 'focused']] },
  { name: 'mode-loadable-agent', session: switchSession(), ops: [['mode', 'swarm']] },
  { name: 'mode-agent-reached', session: switchSession({ tools: [{ name: 'shell' }, { name: 'agent' }], deferredToolCatalog: [] }), ops: [['mode', 'swarm']] },
  { name: 'workflow-reopens-agent', session: switchSession({ ...withoutAgent, workflow: { id: 'gamma', name: 'Gamma', description: '', source: 'built-in', delegatesAgents: false } }), ops: [['workflow', 'alpha'], ['workflow', 'delta'], ['workflow', 'gamma']] },
  { name: 'workflow-reopens-unavailable', session: switchSession({ disallowedTools: ['agent', 'ghost'], deferredToolCatalog: [] }), ops: [['workflow', 'beta']] },
  { name: 'workflow-gone', session: switchSession(), ops: [['workflow', 'nope'], ['workflow', 'alpha']] },
  { name: 'in-flight-staged', session: switchSession(), inFlight: true, ops: [['workflow', 'beta'], ['mode', 'swarm'], ['workflow', 'gamma'], ['workflow', 'alpha'], ['mode', 'balanced']] },
  { name: 'in-flight-then-pending', session: switchSession(), inFlight: true, ops: [['workflow', 'beta'], ['mode', 'swarm'], ['idle'], ['pending']] },
  { name: 'pending-gone-workflow', session: switchSession({ pendingWorkflowId: 'nope', pendingOrchestrationMode: 'focused' }), ops: [['pending'], ['pending']] },
  { name: 'pending-workflow-only', session: switchSession({ pendingWorkflowId: 'delta' }), ops: [['pending']] },
  { name: 'agent-owner', session: switchSession({ owner: 'agent' }), ops: [['workflow', 'beta'], ['mode', 'swarm']] },
  { name: 'agent-mode', session: switchSession({ sessionMode: 'agent' }), ops: [['workflow', 'beta'], ['mode', 'swarm']] },
  { name: 'agent-home-id', session: switchSession({ id: 'sess_home_lead' }), ops: [['workflow', 'beta']] },
  { name: 'too-old', session: switchSession({ promptIdentity: undefined }), ops: [['workflow', 'beta'], ['mode', 'swarm']] },
  { name: 'legacy-mode', session: switchSession({ orchestrationMode: undefined }), ops: [['mode', 'swarm'], ['mode', 'none']] },
  { name: 'no-anchor', session: switchSession({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }] }), ops: [['workflow', 'beta'], ['mode', 'swarm']] },
  { name: 'deferred-delta', session: switchSession({ pendingDeferredToolDelta: { version: 1, type: 'deferred_tools_delta', revision: 3, added: [], removed: ['agent'] }, deferredToolDeltaRevision: 3, ...withoutAgent, workflow: { id: 'gamma', name: 'Gamma', description: '', source: 'built-in', delegatesAgents: false } }), ops: [['workflow', 'alpha']] },
];
const switchRecorded = [];
for (const scenario of SWITCH_SCENARIOS) {
  let session = scenario.session ? clone(scenario.session) : null;
  let inFlight = scenario.inFlight === true;
  let persisted = 0;
  const switches = createSessionSwitches({
    getSession: () => session,
    getConfig: () => ({ orchestrationMode: 'balanced' }),
    getDataDir: () => '/data',
    modelStandaloneTools: () => clone(STANDALONE),
    activeWorkflowContext: (config) => {
      const entry = SWITCH_WORKFLOWS[config?.workflow?.active] ?? SWITCH_WORKFLOWS.alpha;
      return {
        summary: entry.summary,
        orchestrationMode: config.orchestrationMode,
        packContext: entry.packContext,
        leadPromptParts: () => ({ orchestrationContext: entry.orchestrationContext, agentCatalogContext: entry.agentCatalogContext }),
      };
    },
    persistSession: async () => {
      persisted += 1;
    },
    liveDeniedTools: (_session, summary) => [...SWITCH_WORKFLOWS[summary.id].denied],
    turnInFlight: () => inFlight,
  });
  const steps = [];
  for (const [op, arg] of scenario.ops) {
    if (op === 'idle') {
      inFlight = false;
      steps.push({ op });
      continue;
    }
    let result;
    try {
      result = op === 'workflow' ? await switches.switchSessionWorkflow(arg) : op === 'mode' ? await switches.switchSessionOrchestrationMode(arg) : switches.applyPendingSessionSwitches();
      result = { ok: result ?? null };
    } catch (error) {
      result = { error: error.message };
    }
    const { messages, ...rest } = session ? clone(session) : { messages: null };
    steps.push({ op, arg: arg ?? null, ...result, session: session ? rest : null, boundaries: (messages ?? []).map((m) => m.meta ?? null), persisted });
  }
  switchRecorded.push({ name: scenario.name, session: scenario.session ?? null, inFlight: scenario.inFlight === true, steps });
}
Date.now = realNow;
await writeJsonCompact(tree, join(stage, 'session-switches.json'), { now: NOW, workflows: SWITCH_WORKFLOWS, standalone: STANDALONE, instructions: SWITCH_INSTRUCTIONS, scenarios: switchRecorded });

const settingsRecorded = [];
for (const scenario of SETTINGS_SCENARIOS) settingsRecorded.push(await settingsRun(scenario));
writeJson(join(stage, 'settings-scenarios.json'), { scenarios: settingsRecorded });
writeJson(join(stage, 'context-switch.json'), { cases: contextCases });

writeSetManifest(stage, {
  set: SET,
  recorder: 'benchmarks/rust-core/recorders/record-thread-settings.mjs',
  command: 'node benchmarks/rust-core/recorders/record-thread-settings.mjs --tree <tree>',
  identityTree: tree,
});
commitStage(stage, join(FIXTURES_ROOT, SET));
console.log(`thread settings: route cases ${routeCases.length}, settings scenarios ${settingsRecorded.length}, context cases ${contextCases.length}`);
