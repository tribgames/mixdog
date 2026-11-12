#!/usr/bin/env node
// What a spawn that pins a model resolves to, as Node has it after node-patches/node-fix-spawn-model-settings.patch (a clear
// Node bug fixed on both sides: the pinned model ran without the fast flag or the effort of a spawn on the agent's own route,
// and another model could answer a spawn that named one; now the named model is strict: no fallback chain, `fast: true` on a model
// without fast is refused, and no stored effort the model does not offer reaches the request). Recorded from b6f10295a with that patch applied, through the agent tool's own entry (`createAgentExecute`
// of agent-tool/execute.mjs: the request's model is resolved against the catalog, then the real spawn preparer resolves the
// route and builds the session spec). Per scenario: the request, the agent routes of the config, the catalog rows (as the
// model picker hydrates them) or none, the tool's answer, and the agent, preset name and preset of the spec the preparer
// hands to session creation.
//
//   node benchmarks/rust-core/recorders/record-spawn-model-settings.mjs --tree <git archive of b6f10295a with the patch applied, with node_modules>
//        --patch benchmarks/rust-core/recorders/node-patches/node-fix-spawn-model-settings.patch [--only <scenario>]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitStage, FIXTURES_ROOT, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-spawn-model-settings.mjs';
const args = parseArgs();
const tree = resolveTree(args);
// Checked before anything is recorded: the tree is the commit with the patch and nothing else.
const identity = nodeTreeIdentity(args, tree, REF);
if (!identity.patch) throw new Error('record from the export with --patch benchmarks/rust-core/recorders/node-patches/node-fix-spawn-model-settings.patch');

const dataDir = mkdtempSync(join(tmpdir(), 'spawn-model-settings-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { createAgentExecute } = await importFrom(tree, 'src/session-runtime/services/agent-tool/execute.mjs');
const { createSendFlow } = await importFrom(tree, 'src/session-runtime/services/agent-tool/send-flow.mjs');
const { createSpawnPreparer } = await importFrom(tree, 'src/session-runtime/services/agent-tool/spawn-flow/spawn-prep.mjs');
const helpers = await importFrom(tree, 'src/session-runtime/services/agent-tool/helpers.mjs');
const routeConfig = await importFrom(tree, 'src/runtime/shared/agent-route-config.mjs');
const botChain = await importFrom(tree, 'src/session-runtime/bot-chain.mjs');
const { normalizeAgentPermission } = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');

const opts = (...values) => values.map((value) => ({ value, label: value, description: '' }));
// Catalog rows as the model picker hydrates them (provider-models/row-hydration.mjs).
const row = (provider, id, display, extra) => ({ provider, id, display, catalogComplete: true, ...extra });
const CATALOG = [
  row('openai', 'gpt-fast', 'GPT Fast', { reasoningLevels: ['low', 'medium', 'high'], effortOptions: opts('low', 'medium', 'high'), defaultEffort: 'medium', savedEffort: 'low', fastCapable: true, fastPreferred: false }),
  row('openai', 'gpt-saved-fast', 'GPT Saved Fast', { reasoningLevels: ['low', 'medium', 'high'], effortOptions: opts('low', 'medium', 'high'), defaultEffort: 'medium', savedEffort: null, fastCapable: true, fastPreferred: true }),
  row('openai', 'gpt-default-high', 'GPT Default High', { reasoningLevels: ['low', 'medium', 'high', 'xhigh'], effortOptions: opts('low', 'medium', 'high', 'xhigh'), defaultEffort: null, savedEffort: null, fastCapable: true, fastPreferred: false }),
  row('xai', 'grok-plain', 'Grok Plain', { reasoningLevels: [], effortOptions: [], defaultEffort: null, savedEffort: null, fastCapable: false, fastPreferred: true }),
  row('anthropic', 'opus', 'Opus', { reasoningLevels: ['low', 'high'], effortOptions: opts('low', 'high'), defaultEffort: 'low', savedEffort: null, fastCapable: true, fastPreferred: true }),
  row('openai', 'twin-a', 'Twin', { effortOptions: [], fastCapable: false }),
  row('openai', 'twin-b', 'Twin', { effortOptions: [], fastCapable: false }),
];

const CONFIG = {
  default: 'main-preset',
  presets: [{ id: 'main-preset', name: 'MAIN', provider: 'anthropic', model: 'sonnet', effort: 'medium' }],
  agents: {
    worker: {
      provider: 'anthropic',
      model: 'opus',
      effort: 'high',
      fast: true,
      fallbacks: [
        { provider: 'openai', model: 'gpt-4' },
        { provider: 'gemini', model: 'pro' },
      ],
    },
    plain: { provider: 'openai', model: 'gpt-fast', effort: 'medium' },
    // Agents whose stored effort their own model does not offer: a spawn naming that model must not restore it.
    stale: { provider: 'openai', model: 'gpt-fast', effort: 'xhigh', fallbacks: [{ provider: 'gemini', model: 'pro' }] },
    staleless: { provider: 'xai', model: 'grok-plain', effort: 'high' },
  },
};

// The agent's configured model, changed after the spawn.
const MOVED = { ...CONFIG, agents: { ...CONFIG.agents, worker: { provider: 'openai', model: 'gpt-new', effort: 'low' } } };

const spawn = (extra, agent = 'worker') => ({ type: 'spawn', agent, prompt: 'do it', tag: undefined, ...extra });
const SCENARIOS = [
  { name: 'the_preset_route', args: spawn({}) },
  { name: 'a_model_alone_takes_the_models_defaults', args: spawn({ model: 'GPT Fast' }) },
  { name: 'a_model_alone_with_the_catalog_default_effort', args: spawn({ model: 'gpt-default-high' }) },
  { name: 'a_model_alone_with_its_saved_fast', args: spawn({ model: 'gpt-saved-fast' }) },
  { name: 'a_model_with_effort', args: spawn({ model: 'gpt-fast', effort: 'high' }) },
  { name: 'a_model_with_fast', args: spawn({ model: 'gpt-fast', fast: true }) },
  { name: 'a_model_with_effort_and_fast_off', args: spawn({ model: 'gpt-saved-fast', effort: 'LOW', fast: false }) },
  { name: 'a_model_that_does_not_offer_the_effort', args: spawn({ model: 'grok-plain', effort: 'high' }) },
  { name: 'fast_on_a_model_without_fast_is_refused', args: spawn({ model: 'grok-plain', fast: true }) },
  { name: 'fast_off_on_a_model_without_fast', args: spawn({ model: 'grok-plain', fast: false }) },
  { name: 'the_agents_own_model_with_a_stored_effort_it_does_not_offer', args: spawn({ model: 'gpt-fast' }, 'stale') },
  { name: 'the_agents_own_model_with_a_stored_effort_and_an_effort_it_does_not_offer', args: spawn({ model: 'gpt-fast', effort: 'nonsense' }, 'stale') },
  { name: 'the_agents_own_model_without_effort_options', args: spawn({ model: 'grok-plain' }, 'staleless') },
  { name: 'the_agents_own_model_with_an_effort_it_offers', args: spawn({ model: 'gpt-fast', effort: 'high' }, 'stale') },
  { name: 'an_effort_the_model_does_not_offer_is_snapped', args: spawn({ model: 'gpt-fast', effort: 'xhigh' }) },
  { name: 'the_agents_own_model_keeps_its_settings', args: spawn({ model: 'opus' }) },
  { name: 'the_agents_own_model_with_effort_and_fast', args: spawn({ model: 'opus', effort: 'low', fast: false }) },
  { name: 'a_model_narrowed_by_provider', args: spawn({ model: 'gpt-fast', provider: 'OpenAI' }) },
  { name: 'an_agent_without_fallbacks_pins_a_model', args: spawn({ model: 'grok-plain' }, 'plain') },
  { name: 'an_unknown_name', args: spawn({ model: 'nothing like it' }) },
  { name: 'an_ambiguous_name', args: spawn({ model: 'twin' }) },
  { name: 'a_provider_without_models', args: spawn({ model: 'gpt-fast', provider: 'ghost' }) },
  { name: 'a_provider_without_a_model', args: spawn({ provider: 'openai' }) },
  // The worker the spawn created, then the agent's configured model moved to another one, then a send (or a resume).
  { name: 'a_worker_spawned_on_the_agents_own_model_named_keeps_it_when_the_configuration_moves', args: spawn({ model: 'opus' }), followUp: { config: MOVED } },
  { name: 'a_resumed_worker_spawned_on_the_agents_own_model_named_keeps_it_when_the_configuration_moves', args: spawn({ model: 'opus' }), followUp: { config: MOVED, resumed: true } },
  { name: 'a_worker_spawned_on_another_named_model_keeps_it_when_the_configuration_moves', args: spawn({ model: 'gpt-fast' }), followUp: { config: MOVED } },
  { name: 'a_worker_spawned_without_a_model_follows_the_moved_configuration', args: spawn({}), followUp: { config: MOVED } },
  { name: 'no_catalog_takes_the_route_as_asked', args: spawn({ provider: 'openai', model: 'gpt-fast', effort: 'high', fast: true }), catalog: null },
  { name: 'no_catalog_and_no_provider', args: spawn({ model: 'gpt-fast' }), catalog: null },
];

function writeAgent(root, name) {
  const dir = join(root, 'agents', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENT.md'), ['---', `name: ${name}`, '---', 'role text', ''].join('\n'));
}

// The send (or resume) to the worker a spawn created, after the configuration changed, through the real send flow of a
// canonical surface whose worker is busy (the prompt queues; a route the flow applies shows as `setRoute`).
async function followUp(spec, { config, resumed }) {
  const { preset } = spec;
  const session = JSON.parse(
    JSON.stringify({ id: 'sess_w1', agent: spec.agent, cwd: '/work', presetName: spec.presetName, provider: preset.provider, model: preset.model, effort: preset.effort, fast: preset.fast, autoEffort: preset.autoEffort }),
  );
  const calls = [];
  const flow = createSendFlow({
    mgr: { getSession: () => session },
    cfgMod: { loadConfig: () => config },
    defaultCwd: '/default',
    sessionSurface: {
      canonical: true,
      setRoute: async ({ route }) => void calls.push(['setRoute', route]),
      enqueueTurn: async ({ prompt, context }) => {
        calls.push(['enqueueTurn', prompt, context]);
        return { queueDepth: 1 };
      },
    },
    canUseSessionSurface: () => true,
    registry: { tagForSession: () => 'scout' },
    views: { isSessionBusy: () => true },
    spawnFlow: { workerTurns: { observe: (s) => void calls.push(['observe', s.id]) } },
  });
  const prepared = { args: { tag: 'scout', prompt: 'follow up' }, session, sessionId: session.id, prompt: 'follow up' };
  const reply = await flow.dispatchToExistingSession(prepared, { callerSessionId: 'lead', ownerSessionId: 'lead', clientHostPid: 4242 }, resumed ? { resumed: true } : {});
  return { session, reply, calls: JSON.parse(JSON.stringify(calls)) };
}

async function record(scenario) {
  const root = mkdtempSync(join(tmpdir(), 'spawn-model-settings-agents-'));
  const source = mkdtempSync(join(tmpdir(), 'spawn-model-settings-source-'));
  for (const name of Object.keys(CONFIG.agents)) writeAgent(root, name);
  const catalog = scenario.catalog === undefined ? CATALOG : scenario.catalog;
  const created = [];
  const sessionSurface = {
    canonical: true,
    createChild: async ({ spec, prompt, tag }) => {
      created.push({ agent: spec.agent, presetName: spec.presetName, preset: spec.preset, prompt, tag });
      return { session: { id: 'sess_1', cwd: '/work' } };
    },
  };
  const cfgMod = { loadConfig: () => CONFIG, resolveRuntimeSpec: (preset, options) => ({ runtime: preset.provider, options }) };
  const { prepareSpawn } = createSpawnPreparer({
    cfgMod,
    dataDir: root,
    STANDALONE_SOURCE_ROOT: source,
    defaultCwd: '/default',
    nextTag: () => 'worker-1',
    resolveTag: () => null,
    wantsSessionScan: () => false,
    bindTag: () => {},
    ensureProvider: async () => {},
    sessionSurface,
    refreshTagsFromSessions: () => {},
    mgr: { getSession: () => null },
  });
  const context = { callerSessionId: 'lead', ownerSessionId: 'lead', clientHostPid: 4242, cwd: '/work' };
  const prepared = [];
  const execute = createAgentExecute({
    mgr: {},
    defaultCwd: '/work',
    awaitKeychainPrewarm: async () => {},
    registry: { resolveTombstoneOwners: () => {} },
    views: { renderJob: (job) => job.view },
    spawnFlow: {
      startDeferredSpawnJob: (spawnArgs, callerCwd, spawnContext) => {
        prepared.push(prepareSpawn(spawnArgs, callerCwd, spawnContext));
        return { taskId: 'job-1', view: { task_id: 'job-1', status: 'running', type: 'spawn' } };
      },
    },
    sendFlow: {},
    closeFlow: {},
    terminalTrace: {},
    listProviderModels: catalog ? async () => catalog : null,
  });
  const request = JSON.parse(JSON.stringify(scenario.args));
  const result = await execute(request, context);
  const settled = await Promise.allSettled(prepared);
  const failed = settled.find((entry) => entry.status === 'rejected');
  const agent = helpers.normalizeAgentName(request.agent);
  const kind = helpers.readAgentFrontmatterKind(agent, root, source);
  const host = {
    agent: {
      name: agent,
      defined: helpers.agentDefinitionExists(agent, root, source),
      disabled: routeConfig.isAgentDisabled(CONFIG, agent),
      kind,
      contact: routeConfig.isContactAgentId(agent, kind),
      permission: normalizeAgentPermission(helpers.readAgentFrontmatterPermission(agent, root, source)) || null,
      candidates: routeConfig.configuredAgentRouteCandidates(CONFIG, agent),
    },
    delegation: { chain: botChain.delegationChainOf('lead', () => null), acting: botChain.actingAgentOf(null, 'lead') },
  };
  rmSync(root, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
  const recorded = {
    name: scenario.name,
    scenario: { args: request, config: CONFIG, catalog, context },
    host,
    result: { answer: result, error: failed ? failed.reason.message : null, created },
  };
  if (scenario.followUp) {
    recorded.scenario.followUp = scenario.followUp;
    recorded.result.send = await followUp(created[0], scenario.followUp);
  }
  return recorded;
}

const ONLY = args.get('only') ?? null;
if (ONLY) {
  const scenario = SCENARIOS.find((entry) => entry.name === ONLY);
  if (!scenario) throw new Error(`no scenario ${ONLY}; one of ${SCENARIOS.map((entry) => entry.name).join(', ')}`);
  process.stdout.write(`${JSON.stringify(await record(scenario), null, 2)}\n`);
  process.exit(0);
}
const cases = [];
for (const scenario of SCENARIOS) cases.push(await record(scenario));
const FIXTURES = join(FIXTURES_ROOT, 'spawn-model-settings');
const out = stageSet(FIXTURES);
writeJson(join(out, 'cases.json'), {
  note: 'Node agent-tool execute (b6f10295a + node-fix-spawn-model-settings.patch): a spawn request, the config, the catalog, the tool answer and the session specs the spawn prepared.',
  cases,
});
writeSetManifest(out, {
  set: 'spawn-model-settings',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <git archive of ${REF} with ${identity.patch.file} applied, with node_modules> --patch ${identity.patch.file}`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    scenarios: cases.map((entry) => ({ name: entry.name, answer: entry.result.answer.slice(0, 80), created: entry.result.created.length })),
    exclusions: [
      'the job id in the answer of a spawn that started: the recorder\'s stand-in task is `job-1`, the Rust board generates its own id, so the replay reads the board\'s id as `job-1` (the rest of every answer is compared whole)',
      'the session spec the real spawn preparer hands to session creation is a projection, not the whole spec: compared are agent, presetName, preset, prompt and the tag; left out are runtimeSpec (the recorder\'s `resolveRuntimeSpec` is a stand-in, not the runtime registry), cwd (the recorder resolves it against the host\'s working directory), and owner, parentSessionId, ownerSessionId, visibility, clientHostPid, sourceType, sourceName, agentTag, taskType, permission, cacheKeyOverride and mcpScopeId (fixed by the caller context and the agent\'s definition, the same in every scenario here; the whole spec of a spawn is compared in fixtures/agent/flows/spawn.json)',
      'the follow-up send of a scenario with `followUp` runs the real send flow on a canonical surface with a busy worker whose session is the one the spawn created (agent, presetName, provider, model, effort, fast, autoEffort and cwd `/work`); its answer and the calls it made (setRoute, observe, enqueueTurn) are compared whole, the session store and the turn queue are stand-ins',
      'the session itself, the tag binding and the model catalog behind the listing are stand-ins on both sides (the catalog rows are the recorded input, as the model picker hydrates them)',
    ],
  },
});
commitStage(out, FIXTURES);
console.log(`spawn-model-settings: ${cases.length} cases`);
process.exit(0);
