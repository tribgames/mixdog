#!/usr/bin/env node
// Records what Node answers when the desktop calls a session capability with no session, which the desktop host serves from its
// control session (`ensureControlSession`, apps/desktop/src/main/session-host-transport.ts): the session is reserved and holds no
// conversation, its route is empty, and the runtime's config is the one every session shares. Three capabilities, each by Node's
// own function:
//  - `getOrchestrationMode` / `getConfiguredOrchestrationMode` / `setOrchestrationMode`: the real `createStyleAndModeApi`
//    (workflow-agents-api/style-and-mode.mjs), over a session or none. The action `getOrchestrationMode` is that api's, the
//    configured mode, whatever the addressed session holds (the runtime facade's `orchestrationMode` getter is the session's).
//  - `setAgentRoute`: the real `createAgentRouteApi` (workflow-agents-api/agent-route.mjs); the agent's route, not the session's.
//
//   node benchmarks/rust-core/recorders/record-control-session-actions.mjs --tree <git clone at b6f10295a with node_modules>
//
// Output: native/core/fixtures/control-session-actions/golden.json.
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'control-session-actions-')));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'control-session-actions');
const stage = stageSet(finalDir);
const { createStyleAndModeApi } = await importFrom(tree, 'src/session-runtime/workflow-agents-api/style-and-mode.mjs');

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

// --- orchestration mode: a session (or none) and a config, then the steps the desktop sends.
const CONVERSATION = [{ role: 'user', content: 'hello' }];
const MODE_SCENARIOS = [
  { name: 'control-reserved', config: {}, session: null },
  { name: 'control-reserved-stored-mode', config: { orchestrationMode: 'swarm' }, session: null },
  { name: 'control-empty-session', config: {}, session: { id: 'sess_control', orchestrationMode: 'balanced', messages: [] } },
  {
    name: 'session-with-conversation',
    config: { orchestrationMode: 'none' },
    session: { id: 'sess_talk', orchestrationMode: 'swarm', pendingOrchestrationMode: 'focused', messages: CONVERSATION },
  },
  { name: 'unknown-stored-mode', config: { orchestrationMode: 'bogus' }, session: { id: 'sess_a', orchestrationMode: 'swarm', messages: [] } },
];
const MODE_STEPS = [
  ['getOrchestrationMode'],
  ['getConfiguredOrchestrationMode'],
  ['setOrchestrationMode', 'none'],
  ['getOrchestrationMode'],
  ['getConfiguredOrchestrationMode'],
  ['setOrchestrationMode', 'focused'],
  ['getOrchestrationMode'],
  ['setOrchestrationMode', 'balanced'],
  ['getOrchestrationMode'],
  ['setOrchestrationMode', 'parallel'],
  ['getOrchestrationMode'],
];
const modes = [];
for (const scenario of MODE_SCENARIOS) {
  const state = { config: clone(scenario.config) };
  const adopt = (next) => {
    state.config = clone(next);
    return state.config;
  };
  const api = createStyleAndModeApi({
    getConfig: () => state.config,
    getSession: () => scenario.session,
    adoptConfig: adopt,
    saveConfigAndAdopt: adopt,
    displayConfig: () => state.config,
    getOutputStyleStatusCached: () => ({}),
    seedOutputStyleStatusCache() {},
    scheduleOutputStyleSave() {},
    invalidateContextStatusCache() {},
    settingsReachCurrentSession: () => true,
  });
  const steps = [];
  for (const [action, ...args] of MODE_STEPS) {
    let outcome;
    try {
      outcome = { value: clone(await api[action](...args)) };
    } catch (error) {
      outcome = { error: String(error?.message ?? error) };
    }
    steps.push({ action, args, ...outcome });
  }
  modes.push({ name: scenario.name, config: scenario.config, session: scenario.session, steps });
}

// --- setAgentRoute: the real `createAgentRouteApi` over a config file's agents (the shape of record-route-admin.mjs `agentCases`,
// which Rust's `set_agent_route` test replays). The route is the agent's: the session the call is addressed to is not an input.
const rc = 'src/runtime/agent/orchestrator/runtime-core/';
const helpers = await importFrom(tree, `${rc}config-helpers.mjs`);
const caps = await importFrom(tree, `${rc}model-capabilities.mjs`);
const { createAgentRouteApi } = await importFrom(tree, 'src/session-runtime/workflow-agents-api/agent-route.mjs');
const { agentEditorId } = await importFrom(tree, 'src/session-runtime/workflow-agents-api/shared.mjs');
const { isHiddenAgent } = await importFrom(tree, 'src/runtime/agent/orchestrator/internal-agents.mjs');
const { isAgentDisabled } = await importFrom(tree, 'src/runtime/shared/agent-route-config.mjs');
const { subscribeAgentRouteChanges } = await importFrom(tree, 'src/session-runtime/agent-profile-changes.mjs');
const KNOWN = ['openai', 'openai-oauth', 'anthropic', 'anthropic-oauth', 'gemini', 'custom-harness'];
const agentRouteFromConfig = (cfg, id) => {
  const r = cfg.agents?.[id];
  return r && String(r.provider || '').trim() && String(r.model || '').trim() ? structuredClone(r) : null;
};
async function agentCase(config, agentId, request) {
  const id = agentEditorId(agentId);
  const meta = null;
  const resolveRoute = helpers.makeResolveRoute(helpers.makeResolveDefaultProvider((p) => KNOWN.includes(String(p || '').trim())));
  const rt = { config: structuredClone(config) };
  const log = { saves: 0, reloads: 0, ensured: [] };
  const published = [];
  const sub = subscribeAgentRouteChanges((agent, route) => {
    published.push({ id: agent, route: clone(route) });
  });
  const api = createAgentRouteApi({
    getConfig: () => rt.config,
    resolveRoute,
    saveConfigAndAdopt: (nextConfig) => {
      rt.config = structuredClone(nextConfig);
      log.saves += 1;
    },
    agentRouteFromConfig,
    ensureProvidersReady: async (providers) => {
      log.ensured.push(clone(providers));
    },
    lookupModelMeta: async () => structuredClone(meta),
    reloadFullConfig: () => {
      log.reloads += 1;
    },
  });
  const own0 = id ? clone(agentRouteFromConfig(config, id)) : null;
  let result;
  try {
    result = { value: clone(await api.setAgentRoute(agentId, structuredClone(request))) };
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  sub.unsubscribe();
  return {
    config,
    agentId,
    request,
    meta,
    known: KNOWN,
    fastByProvider: Object.fromEntries(KNOWN.map((p) => [p, caps.fastCapableFor(p, meta)])),
    oracle: { editorId: id || '', hidden: Boolean(id && isHiddenAgent(id)), disabled0: id ? isAgentDisabled(config, id) : false },
    ...result,
    after: {
      own: id ? clone(agentRouteFromConfig(rt.config, id)) : null,
      disabled: id ? isAgentDisabled(rt.config, id) : false,
      config: clone(rt.config),
      saves: log.saves,
      reloads: log.reloads,
      ensured: log.ensured,
      published,
    },
    own0,
  };
}
const agentRoutes = [
  await agentCase({}, 'maintainer', { provider: 'custom-harness', model: 'harness-model' }),
  await agentCase(
    { agents: { maintainer: { provider: 'custom-harness', model: 'harness-model' } }, disabledAgents: ['maintainer'] },
    'maintainer',
    { disabled: false }
  ),
];

writeJson(join(stage, 'golden.json'), {
  domain: 'control-session-actions',
  recorder: 'benchmarks/rust-core/recorders/record-control-session-actions.mjs',
  modes,
  agentRoutes,
});
writeSetManifest(stage, {
  set: 'control-session-actions',
  recorder: 'benchmarks/rust-core/recorders/record-control-session-actions.mjs',
  command: 'node benchmarks/rust-core/recorders/record-control-session-actions.mjs --tree <tree>',
  identityTree: tree,
  identityRef: NODE_COMMIT,
});
commitStage(stage, finalDir);
console.log(`recorded ${modes.length} orchestration-mode scenarios and ${agentRoutes.length} agent routes`);