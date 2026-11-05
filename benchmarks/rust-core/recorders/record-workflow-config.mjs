#!/usr/bin/env node
// Golden twin of the `config/` workflow, orchestration-mode, web-search-route, model-preference
// and onboarding methods: getWorkflowPack, saveWorkflowPack, createWorkflow, deleteWorkflow,
// getOrchestrationMode, getConfiguredOrchestrationMode, setWebSearchRoute, setModelPreferences,
// skipOnboarding, completeOnboarding.
//
// Each scenario is a start state (agent config, user data files) and a list of steps; the file
// records what Node answered (a value, or the error text), the agent config and the data-dir
// files after each step. Rust `mixdog_core::workflow` replays them and must equal all of it.
// The shipped packs are copied beside the scenarios (`shipped/workflows`) and are the install
// root of both sides.
//
//   node benchmarks/rust-core/recorders/record-workflow-config.mjs --tree <dir>
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'workflow-config');

const NOW = '2026-01-02T03:04:05.678Z';
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [NOW]));
  }
  static now() {
    return new RealDate(NOW).getTime();
  }
};

const s = 'src/session-runtime/';
const rc = 'src/runtime/agent/orchestrator/runtime-core/';
const { createWorkflowAgentsApi } = await importFrom(tree, `${s}workflow-agents-api.mjs`);
const { createProfileSettings } = await importFrom(tree, `${s}settings-profile-api.mjs`);
const { createWebSearchRouteApi } = await importFrom(tree, `${s}model-route/web-search-route.mjs`);
const { saveModelPreferences, isKnownProvider } = await importFrom(tree, `${s}services/provider-admin.mjs`);
const wf = await importFrom(tree, `${rc}workflow.mjs`);
const cfgHelpers = await importFrom(tree, `${rc}config-helpers.mjs`);
const caps = await importFrom(tree, `${rc}model-capabilities.mjs`);
const md = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');
const { ONBOARDING_VERSION } = await importFrom(tree, `${s}quick-web-search-models.mjs`);

const stage = stageSet(outDir);
const shippedRoot = join(stage, 'shipped');
mkdirSync(shippedRoot, { recursive: true });
cpSync(join(tree, 'src', 'workflows'), join(shippedRoot, 'workflows'), { recursive: true });

const PACK_BODY = '# Review\n\nRead twice.\n';
const SHIPPED_DEFAULT = readFileSync(join(shippedRoot, 'workflows', 'default', 'WORKFLOW.md'), 'utf8');
const SHIPPED_HEADLESS = readFileSync(join(shippedRoot, 'workflows', 'headless', 'WORKFLOW.md'), 'utf8');
const shippedDoc = (text) => md.readMarkdownDocument(text);
const headless = shippedDoc(SHIPPED_HEADLESS);

const LEAD = { provider: 'openai', model: 'gpt-5', effort: 'high' };
const user = (id, name, body = PACK_BODY) => ({ [`workflows/${id}/WORKFLOW.md`]: `---\nid: ${id}\nname: ${name}\n---\n${body}` });
const step = (method, params = {}) => ({ method, params });

const SCENARIOS = [
  {
    name: 'pack-read',
    config: { workflow: { active: 'default' } },
    files: { ...user('review', 'Review') },
    steps: [
      step('getWorkflowPack', { workflowId: 'review' }),
      step('getWorkflowPack', { workflowId: 'default' }),
      step('getWorkflowPack', { workflowId: 'headless' }),
      step('getWorkflowPack', { workflowId: 'Review' }),
      step('getWorkflowPack', { workflowId: 'nope' }),
      step('getWorkflowPack', { workflowId: '  ' }),
      step('getWorkflowPack', { workflowId: '!!!' }),
    ],
  },
  {
    name: 'pack-save-create-delete',
    config: { workflow: { active: 'review' } },
    files: { ...user('review', 'Review') },
    steps: [
      step('saveWorkflowPack', { payload: { id: 'plan', name: ' Plan  it ', description: 'two\nlines', body: '  steps\n' } }),
      step('saveWorkflowPack', { payload: { id: 'plan', name: 'Plan', body: 'again' } }),
      step('saveWorkflowPack', { payload: { id: '', body: 'x' } }),
      step('saveWorkflowPack', { payload: { id: 'empty', body: '   ' } }),
      step('saveWorkflowPack', { payload: { id: 'noname', body: 'b' } }),
      step('saveWorkflowPack', { payload: { id: 'headless', name: headless.data?.name ?? headless.frontmatter?.name ?? 'Headless', description: headless.data?.description ?? headless.frontmatter?.description ?? '', body: headless.body } }),
      step('saveWorkflowPack', { payload: { id: 'default', name: 'My default', body: 'custom default' } }),
      step('createWorkflow', { payload: { name: 'Plan', body: 'dup name' } }),
      step('createWorkflow', { payload: { name: 'Plan', body: 'dup name again' } }),
      step('createWorkflow', { payload: { id: 'plan', name: 'x', body: 'b' } }),
      step('createWorkflow', { payload: { id: 'fresh-one', name: 'Fresh', body: 'b' } }),
      step('createWorkflow', { payload: { name: '   ', body: 'b' } }),
      step('createWorkflow', { payload: { name: '!!!', body: 'b' } }),
      step('deleteWorkflow', { workflowId: 'plan' }),
      step('deleteWorkflow', { workflowId: 'plan' }),
      step('deleteWorkflow', { workflowId: 'default' }),
      step('deleteWorkflow', { workflowId: 'headless' }),
      step('deleteWorkflow', { workflowId: 'review' }),
      step('deleteWorkflow', { workflowId: '' }),
      step('getWorkflowPack', { workflowId: 'default' }),
    ],
  },
  {
    name: 'orchestration-mode',
    config: {},
    steps: [step('getOrchestrationMode'), step('getConfiguredOrchestrationMode')],
  },
  { name: 'orchestration-mode-set', config: { orchestrationMode: 'parallel' }, steps: [step('getOrchestrationMode'), step('getConfiguredOrchestrationMode')] },
  { name: 'orchestration-mode-bogus', config: { orchestrationMode: 'bogus' }, steps: [step('getOrchestrationMode')] },
  {
    name: 'onboarding-skip',
    config: { providers: { openai: { apiKey: 'sk-DUMMY-1' } }, default: 'workflow-lead', presets: [{ id: 'workflow-lead', name: 'Lead', ...LEAD }] },
    steps: [step('skipOnboarding'), step('skipOnboarding')],
  },
  {
    name: 'onboarding-skip-legacy',
    config: { onboarding: { completed: true, version: 0 } },
    steps: [step('skipOnboarding')],
  },
  {
    name: 'onboarding-complete',
    config: { agents: { worker: { provider: 'anthropic', model: 'old' } } },
    main: { provider: 'openai', model: 'main-model' },
    customAgents: ['scribe'],
    steps: [
      step('completeOnboarding', { payload: {} }),
      step('completeOnboarding', { payload: { defaultRoute: { provider: 'openai', model: 'gpt-5', effort: 'high' } } }),
      step('completeOnboarding', { payload: { defaultRoute: { provider: 'openai' } } }),
      step('completeOnboarding', { payload: { defaultRoute: null } }),
      step('completeOnboarding', { payload: { workflowRoutes: { agent: { provider: 'gemini', model: 'g-2' }, memory: { provider: 'openai', model: 'm-1' } } } }),
      step('completeOnboarding', { payload: { workflowRoutes: { agent: null } } }),
      step('completeOnboarding', { payload: { workflowRoutes: { lead: { provider: 'anthropic', model: 'opus' } } } }),
      step('completeOnboarding', { payload: { agentRoutes: { maintainer: { provider: 'openai', model: 'x' }, scribe: { provider: 'openai', model: 'y' }, ghost: { provider: 'openai', model: 'z' } } } }),
      step('completeOnboarding', { payload: { webSearchRoute: { provider: '', toolType: 'web_search' } } }),
      step('completeOnboarding', { payload: { webSearchRoute: { provider: 'openai', model: 'gpt-5' } } }),
      step('completeOnboarding', { payload: { webSearchRoute: { provider: 'openai' } } }),
      step('completeOnboarding', {}),
    ],
  },
  {
    name: 'onboarding-complete-guide',
    config: { onboarding: { completed: true, starterGuide: { closed: true, welcomed: 1, visited: ['remote', 'remote', 'bogus', 'provider'] } } },
    steps: [step('completeOnboarding', { payload: {} }), step('skipOnboarding')],
  },
  {
    name: 'web-search-route',
    config: { providers: { openai: { apiKey: 'sk-DUMMY-1' } } },
    webSearch: { capable: true },
    steps: [
      step('setWebSearchRoute', { next: { provider: 'openai', model: 'gpt-5' } }),
      step('setWebSearchRoute', { next: { provider: '', toolType: 'web_search' } }),
      step('setWebSearchRoute', { next: { provider: 'openai', model: 'gpt-5', fallbacks: [{ provider: 'openai', model: 'gpt-5-mini' }] } }),
      step('setWebSearchRoute', { next: { provider: 'nope', model: 'm' } }),
      step('setWebSearchRoute', { next: { model: 'x' } }),
      step('setWebSearchRoute', { next: {} }),
      step('setWebSearchRoute', { next: null }),
    ],
  },
  {
    name: 'web-search-route-incapable',
    config: {},
    webSearch: { capable: false },
    steps: [step('setWebSearchRoute', { next: { provider: 'openai', model: 'gpt-5' } })],
  },
  {
    name: 'model-preferences',
    config: { modelSettings: { 'openai/gpt-5': { hidden: true, effort: 'high' }, 'openai/old': { favorite: true } } },
    steps: [
      step('setModelPreferences', { providerId: 'openai', changes: [{ model: 'gpt-5', hidden: false, favorite: true }, { model: 'old', favorite: false }, { model: ' new ', hidden: true }] }),
      step('setModelPreferences', { providerId: ' anthropic ', changes: [] }),
      step('setModelPreferences', { providerId: 'nope', changes: [] }),
      step('setModelPreferences', { providerId: '', changes: [] }),
      step('setModelPreferences', { providerId: 'openai', changes: 'x' }),
      step('setModelPreferences', { providerId: 'openai', changes: [null] }),
      step('setModelPreferences', { providerId: 'openai', changes: [{ model: '' }] }),
      step('setModelPreferences', { providerId: 'openai', changes: [{ model: 'm', extra: 1 }] }),
      step('setModelPreferences', { providerId: 'openai', changes: [{ model: 'm', hidden: 'yes' }] }),
      step('setModelPreferences', { providerId: 'openai', changes: [{ model: 'm', favorite: 1 }] }),
      step('setModelPreferences', { providerId: 'openai', changes: [{ model: 7 }] }),
    ],
  },
];

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function listFiles(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(root, full).split(sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const scrub = (value, dataDir) => JSON.parse(JSON.stringify(value ?? null, (_k, v) => (typeof v === 'string' ? v.split(dataDir).join('<data>').split(sep).join('/') : v)));

async function run(scenario) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-config-'));
  for (const [path, text] of Object.entries(scenario.files ?? {})) {
    mkdirSync(join(dataDir, path, '..'), { recursive: true });
    writeFileSync(join(dataDir, path), text);
  }
  const helpers = wf.createWorkflowHelpers({
    rootDir: shippedRoot,
    dataDir,
    readMarkdownDocument: md.readMarkdownDocument,
    normalizeAgentPermissionOrNone: md.normalizeAgentPermissionOrNone,
  });
  const routeHelpers = wf.createWorkflowRouteHelpers({ findPreset: cfgHelpers.findPreset });
  const state = { config: clone(scenario.config) };
  const main = scenario.main ?? { provider: 'openai', model: 'main-model' };
  let route = { ...main };
  const resolveRoute = cfgHelpers.makeResolveRoute(cfgHelpers.makeResolveDefaultProvider(isKnownProvider));
  const cfgMod = {
    getPluginData: () => dataDir,
    loadConfig: () => state.config,
    saveConfig: (next) => {
      state.config = clone(next);
    },
  };
  const deps = {
    ...helpers,
    rootDir: shippedRoot,
    getConfig: () => state.config,
    displayConfig: () => state.config,
    cfgMod,
    STANDALONE_DATA_DIR: dataDir,
    resolveRoute,
    agentRouteFromConfig: routeHelpers.agentRouteFromConfig,
    getRoute: () => route,
    setRouteState: (next) => {
      route = next;
    },
    saveConfigAndAdopt: (value) => {
      state.config = clone(value);
    },
    listCustomAgentIds: () => scenario.customAgents ?? [],
    lookupModelMeta: async () => ({}),
    ensureProvidersReady: async () => {},
    invalidateContextStatusCache() {},
    invalidatePreSessionToolSurface() {},
  };
  const api = createWorkflowAgentsApi(deps);
  Object.assign(
    api,
    createProfileSettings({
      getConfig: () => state.config,
      adoptConfig: (next) => {
        state.config = next;
      },
      saveConfigAndAdopt: deps.saveConfigAndAdopt,
      scheduleSkillsSave() {},
      cfgMod,
      hasOwn: Object.hasOwn,
      summarizeWorkflowRoutes: routeHelpers.summarizeWorkflowRoutes,
      ONBOARDING_VERSION,
    })
  );
  let webSearchState = null;
  const search = createWebSearchRouteApi({
    getConfig: () => state.config,
    getWebSearchRouteState: () => webSearchState,
    setWebSearchRouteState: (next) => {
      webSearchState = next;
    },
    webSearchCapableFor: () => scenario.webSearch?.capable === true,
    lookupModelMeta: async () => ({}),
    saveConfigAndAdopt: deps.saveConfigAndAdopt,
    ensureFullConfig() {},
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
    invalidateProviderCaches() {},
    collectWebSearchProviderModels: async () => [],
  });
  const calls = {
    getWorkflowPack: (p) => api.getWorkflowPack(p.workflowId),
    saveWorkflowPack: (p) => api.saveWorkflowPack(p.payload),
    createWorkflow: (p) => api.createWorkflow(p.payload),
    deleteWorkflow: (p) => api.deleteWorkflow(p.workflowId),
    getOrchestrationMode: () => api.getConfiguredOrchestrationMode(),
    getConfiguredOrchestrationMode: () => api.getConfiguredOrchestrationMode(),
    setWebSearchRoute: (p) => search.setWebSearchRoute(p.next),
    setModelPreferences: (p) => saveModelPreferences(cfgMod, p.providerId, p.changes),
    skipOnboarding: () => api.skipOnboarding(),
    completeOnboarding: (p) => api.completeOnboarding(p.payload),
  };
  const steps = [];
  for (const { method, params } of scenario.steps) {
    let outcome;
    try {
      outcome = { result: scrub(await calls[method](params), dataDir) };
    } catch (error) {
      outcome = { error: String(error?.message ?? error) };
    }
    steps.push({ method, params, ...outcome, config: scrub(state.config, dataDir), files: scrub(listFiles(dataDir), dataDir), route: scrub(route, dataDir) });
  }
  rmSync(dataDir, { recursive: true, force: true });
  return {
    name: scenario.name,
    config: scenario.config,
    files: scenario.files ?? {},
    main: scenario.main ?? null,
    customAgents: scenario.customAgents ?? [],
    webSearch: scenario.webSearch ?? null,
    steps,
  };
}

const recorded = [];
for (const scenario of SCENARIOS) recorded.push(await run(scenario));
writeJson(join(stage, 'scenarios.json'), { now: NOW, scenarios: recorded });
writeSetManifest(stage, {
  set: 'workflow-config',
  recorder: 'benchmarks/rust-core/recorders/record-workflow-config.mjs',
  command: 'node benchmarks/rust-core/recorders/record-workflow-config.mjs --tree <tree>',
  identityTree: tree,
});
commitStage(stage, outDir);
console.log(`workflow-config: ${recorded.length} scenarios, ${recorded.reduce((n, x) => n + x.steps.length, 0)} steps -> ${outDir}`);
