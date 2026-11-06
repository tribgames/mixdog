// Records the goldens of the worker flows' decisions: the route a spawn resolves to and the task
// meta it carries (`spawn-preset.mjs`, `job-views/spawn-meta.mjs`), the spawn plan and its
// prepared session (`spawn-flow/spawn-plan.mjs`, `spawn-prep.mjs`), the deferred spawn job
// (`spawn-flow/deferred-spawn.mjs`) and a send to an existing worker (`send-flow.mjs`), each
// against fakes of the session manager, registry and surface that log every call they get.
//
//   node native/core/fixtures/agent/record-flows.mjs [--tree <node checkout with node_modules>]
//
// flows/preset.json  route resolution + meta cases
// flows/spawn.json   plan / prep / deferred-spawn scenarios
// flows/send.json    prepareSend / dispatchToExistingSession scenarios
// `tests/flows.rs` replays them. The spawn-prep deadline (`prepareWithDeadline`) is not recorded:
// nothing here fails a spawn on elapsed time, so every scenario runs without one.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitStage, parseArgs, refreshSetManifest, resolveTree, stageSet } from '../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
const stage = stageSet(here, ['flows']);
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-flows-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const START = Date.parse('2026-03-01T10:00:00.000Z');
let clock = START;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [clock]));
  }
  static now() {
    return clock;
  }
};

const load = (path) => import(pathToFileURL(join(nodeRoot, path)).href);
const { resolveAgentSpawnPreset } = await load('src/session-runtime/services/agent-tool/spawn-preset.mjs');
const spawnMeta = await load('src/session-runtime/services/agent-tool/job-views/spawn-meta.mjs');
const { presetDescriptor } = await load('src/session-runtime/services/agent-tool/spawn-flow/spawn-prep.mjs');

const out = join(stage, 'flows');
mkdirSync(out, { recursive: true });
const write = (name, value) => writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`);

// ---- route resolution and meta ------------------------------------------------------------

const config = {
  default: 'main-preset',
  presets: [
    { id: 'main-preset', name: 'MAIN', provider: 'anthropic', model: 'opus', effort: 'high', fast: true },
    { id: 'opus-high', name: 'OPUS HIGH', provider: 'anthropic', model: 'opus', effort: 'high' },
    { id: 'broken', name: 'BROKEN', provider: 'anthropic' },
    { id: 'Named', name: 'The Named', provider: 'openai', model: 'gpt-x', effort: 'low', fast: false, autoEffort: false },
  ],
  agents: {
    worker: { provider: 'openai', model: 'gpt-5', effort: 'medium', fast: true, autoEffort: false, contextPercent: 40, fallbacks: [{ provider: 'anthropic', model: 'sonnet' }, { provider: 'openai', model: 'gpt-4' }, { provider: 'gemini' }] },
    plain: { provider: 'openai', model: 'gpt-5' },
    tuned: { provider: 'xai', model: 'grok', modelParameters: { temperature: 0.2 }, contextTokens: 120000.4, contextPercent: '55' },
    halfway: { provider: 'openai' },
    badfallbacks: { provider: 'openai', model: 'gpt-5', fallbacks: 'nope' },
    nested: { provider: 'openai', model: 'gpt-5', fallbacks: [{ provider: 'a', model: 'b', fallbacks: [] }] },
  },
};
const noMain = { ...config, default: 'missing' };

const presetCases = [
  { name: 'direct', args: { provider: ' openai ', model: 'gpt-x', effort: ' high ', fast: true, autoEffort: false, preset: 'mine' } },
  { name: 'direct_defaults', args: { provider: 'openai', model: 'gpt-x' } },
  { name: 'agent_route_with_fallbacks', args: { agent: 'worker' } },
  { name: 'agent_route_plain', args: { agent: 'Plain' } },
  { name: 'agent_route_tuned', args: { agent: 'tuned' } },
  { name: 'agent_alias_normalized', args: { agent: ' heavy_worker ' } },
  { name: 'incomplete_agent_route_falls_to_main', args: { agent: 'halfway' } },
  { name: 'bad_fallbacks', args: { agent: 'badfallbacks' } },
  { name: 'nested_fallbacks', args: { agent: 'nested' } },
  { name: 'main_preset', args: { agent: 'nobody' } },
  { name: 'named_preset_skips_the_agent_route', args: { agent: 'worker', preset: 'the named' } },
  { name: 'named_preset_by_id', args: { agent: 'worker', preset: 'NAMED' } },
  { name: 'alias_preset', args: { agent: 'worker', preset: 'opus-xhigh' } },
  { name: 'unknown_preset', args: { agent: 'worker', preset: 'ghost' } },
  { name: 'incomplete_preset', args: { agent: 'worker', preset: 'broken' } },
  { name: 'no_main_assignment', args: { agent: 'nobody' }, config: noMain },
  { name: 'provider_only_is_not_direct', args: { agent: 'nobody', provider: 'openai' } },
];
const preset = presetCases.map((c) => {
  const cfg = c.config ?? config;
  let result;
  try {
    result = { value: resolveAgentSpawnPreset(cfg, c.args) };
  } catch (error) {
    result = { error: error.message };
  }
  return { name: c.name, config: cfg, args: c.args, result };
});

const metaCases = [
  { name: 'pending_from_args', args: { agent: 'Worker', tag: ' t1 ', provider: 'openai', model: 'gpt-x', effort: 'high', fast: true, preset: 'p' } },
  { name: 'pending_resolves_the_default', args: { agent: 'worker' }, resolve: true },
  { name: 'pending_resolve_failure_shows_the_args', args: { agent: 'nobody', preset: 'ghost' }, resolve: true },
  { name: 'pending_extras', args: { agent: 'worker' }, resolve: true, extras: { respawned: true } },
  { name: 'pending_internal_knobs_dropped', args: { agent: 'worker' }, extras: { spawnPrepTimeoutMs: 5, idleTimeoutMs: 1, respawned: true } },
];
const metas = metaCases.map((c) => {
  let meta;
  const cfgMod = { loadConfig: () => config };
  meta = spawnMeta.pendingSpawnMeta(cfgMod, c.args, c.extras ?? {});
  return { name: c.name, args: c.args, extras: c.extras ?? {}, meta };
});

const prepared = [
  { name: 'prepared_agent_route', tag: 'scout', sessionId: 'sess_1', agent: 'worker', ...resolveAgentSpawnPreset(config, { agent: 'worker' }) },
  { name: 'prepared_main', tag: 'scout', sessionId: 'sess_1', agent: 'nobody', ...resolveAgentSpawnPreset(config, { agent: 'nobody' }) },
  { name: 'prepared_direct_named', tag: 'x', sessionId: 'sess_2', agent: 'a', ...resolveAgentSpawnPreset(config, { agent: 'a', provider: 'p', model: 'm', preset: 'custom' }) },
  { name: 'prepared_no_key', tag: 'x', sessionId: 'sess_2', agent: 'a', presetName: 'fallback-name', preset: { provider: 'p', model: 'm', effort: '' } },
].map((c) => {
  const p = { tag: c.tag, session: { id: c.sessionId }, agent: c.agent, preset: c.preset, presetName: c.presetName };
  const extras = c.name === 'prepared_main' ? { respawned: true } : {};
  const pending = spawnMeta.pendingSpawnMeta({ loadConfig: () => config }, { agent: c.agent, tag: c.tag });
  const job = { meta: pending, label: pending.tag, input: { type: 'spawn', tag: pending.tag } };
  const meta = spawnMeta.preparedSpawnMeta(p, extras);
  spawnMeta.mergeJobMeta(job, meta);
  return {
    name: c.name,
    in: { tag: c.tag, sessionId: c.sessionId, agent: c.agent, preset: c.preset, presetName: c.presetName, extras },
    meta,
    pending,
    merged: { meta: job.meta, label: job.label },
    descriptor: presetDescriptor(c.agent, c.preset, c.presetName),
  };
});

write('preset.json', { preset, metas, prepared });

// ---- a worker's world -----------------------------------------------------------------------

const bg = await load('src/runtime/shared/background-tasks.mjs');
const { createSpawnPreparer } = await load('src/session-runtime/services/agent-tool/spawn-flow/spawn-prep.mjs');
const { createDeferredSpawn } = await load('src/session-runtime/services/agent-tool/spawn-flow/deferred-spawn.mjs');
const { createJobStarter } = await load('src/session-runtime/services/agent-tool/spawn-flow/job-start.mjs');
const { createSpawnRunner } = await load('src/session-runtime/services/agent-tool/spawn-flow/spawn-run.mjs');
const { createSendFlow } = await load('src/session-runtime/services/agent-tool/send-flow.mjs');
const helpers = await load('src/session-runtime/services/agent-tool/helpers.mjs');
const gate = await load('src/session-runtime/workspace/admission-gate.mjs');
const botChain = await load('src/session-runtime/bot-chain.mjs');
const routeConfig = await load('src/runtime/shared/agent-route-config.mjs');
const { normalizeAgentPermission } = await load('src/runtime/shared/markdown-frontmatter.mjs');
const { mkdirSync: mkdir, writeFileSync: put } = await import('node:fs');

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await tick();
};
// Paths are recorded without a drive letter and with /: the golden is the same on every platform.
const norm = (_key, v) => (typeof v === 'string' && /^[A-Za-z]:[\\\\/]/.test(v) ? v.slice(2).replace(/\\\\/g, '/') : v);
const idOf = (value, id) => JSON.parse(id ? JSON.stringify(value).split(id).join('job') : JSON.stringify(value), norm);

const turnResult = (r) => ({
  content: r.content,
  ...(r.reportContent !== undefined ? { reportContent: r.reportContent } : {}),
  ...(r.termination ? { terminationReason: r.termination } : {}),
  iterations: r.iterations ?? 1,
  toolCallsTotal: r.toolCallsTotal ?? 0,
  ...(r.stopReason !== undefined ? { stopReason: r.stopReason } : {}),
});

const publicMeta = (meta) =>
  Object.fromEntries(Object.entries(meta || {}).filter(([k, v]) => v != null && v !== '' && !/timeoutms$/i.test(k)));

/** One agent definition on disk, as the data dir keeps it. */
function writeAgent(root, name, { kind, permission } = {}) {
  const dir = join(root, 'agents', name);
  mkdir(dir, { recursive: true });
  const lines = ['---', `name: ${name}`, ...(kind ? [`kind: ${kind}`] : []), ...(permission ? [`permission: ${permission}`] : []), '---', 'role text', ''];
  put(join(dir, 'AGENT.md'), lines.join('\n'));
}

// ---- spawn: plan, prep, deferred job ---------------------------------------------------------

const BASE_CONFIG = {
  default: 'main-preset',
  presets: [{ id: 'main-preset', name: 'MAIN', provider: 'anthropic', model: 'opus', effort: 'high' }],
  agents: { worker: { provider: 'openai', model: 'gpt-5', effort: 'medium' }, ctx: { provider: 'openai', model: 'gpt-5', contextPercent: 40 } },
};

const spawnScenarios = [
  { name: 'a_spawn_runs_to_completion', args: { agent: 'worker', prompt: 'do it', tag: 'scout' }, steps: [{ tool: 'diff-1' }, { terminal: { content: 'done' } }, { return: { content: 'done' } }] },
  { name: 'a_generated_tag_is_used', args: { agent: 'worker', prompt: 'do it' }, nextTag: 'worker-7', steps: [{ return: { content: 'ok' } }] },
  { name: 'a_directory_and_task_type_travel_with_the_session', args: { agent: 'worker', prompt: 'p', tag: 't', cwd: 'sub/dir', taskType: 'review', cacheKey: 'ck' }, callerCwd: '/work', steps: [{ return: { content: 'ok' } }] },
  { name: 'type_hint_stands_in_for_task_type', args: { agent: 'worker', prompt: 'p', tag: 't', typeHint: 'quick' }, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_locked_workspace_pins_the_worker', args: { agent: 'worker', prompt: 'p', tag: 't', cwd: 'elsewhere' }, callerCwd: '/work', lock: '/lead/worktree', steps: [{ return: { content: 'ok' } }] },
  { name: 'the_surface_may_move_the_workers_directory', args: { agent: 'worker', prompt: 'p', tag: 't' }, effectiveCwd: '/moved', steps: [{ return: { content: 'ok' } }] },
  { name: 'an_agent_permission_travels', args: { agent: 'worker', prompt: 'p', tag: 't' }, agents: { worker: { permission: 'read' } }, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_context_share_is_sized_from_the_model_window', args: { agent: 'ctx', prompt: 'p', tag: 't' }, agents: { ctx: {} }, window: { contextWindow: 200000, maxContextWindow: 1000000 }, steps: [{ return: { content: 'ok' } }] },
  { name: 'an_unknown_window_leaves_the_choice_as_stored', args: { agent: 'ctx', prompt: 'p', tag: 't' }, agents: { ctx: {} }, steps: [{ return: { content: 'ok' } }] },
  { name: 'an_explicit_model_needs_no_default', args: { agent: 'worker', prompt: 'p', tag: 't', provider: 'xai', model: 'grok', effort: 'low', fast: true }, steps: [{ return: { content: 'ok' } }] },
  { name: 'the_agent_is_required', args: { prompt: 'p', tag: 't' }, steps: [] },
  { name: 'an_unknown_agent_fails', args: { agent: 'ghost', prompt: 'p', tag: 't' }, agents: { ghost: null }, steps: [] },
  { name: 'a_turned_off_agent_fails', args: { agent: 'worker', prompt: 'p', tag: 't' }, config: { ...BASE_CONFIG, disabledAgents: ['worker'] }, steps: [] },
  { name: 'a_taken_tag_fails', args: { agent: 'worker', prompt: 'p', tag: 'busy' }, tags: { busy: 'sess_other' }, steps: [] },
  { name: 'an_ambiguous_tag_fails', args: { agent: 'worker', prompt: 'p', tag: 'amb' }, tags: { amb: 'THROW' }, steps: [] },
  { name: 'a_recover_flag_scans_sessions', args: { agent: 'worker', prompt: 'p', tag: 't', recover: true }, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_missing_prompt_fails', args: { agent: 'worker', tag: 't' }, steps: [] },
  { name: 'a_contact_agent_already_in_the_chain_fails', args: { agent: 'robot', prompt: 'p', tag: 't' }, agents: { robot: { kind: 'bot' } }, chain: ['robot', 'lead'], acting: 'lead', steps: [] },
  { name: 'a_free_contact_agent_spawns', args: { agent: 'robot', prompt: 'p', tag: 't' }, agents: { robot: { kind: 'bot' } }, config: { ...BASE_CONFIG, agents: { robot: { provider: 'openai', model: 'gpt-5' } } }, chain: ['lead'], acting: 'lead', steps: [{ return: { content: 'ok' } }] },
  { name: 'a_failing_session_creation_fails_the_job', args: { agent: 'worker', prompt: 'p', tag: 't' }, createThrows: 'boom', steps: [] },
  { name: 'a_job_cancelled_before_it_starts_runs_nothing', args: { agent: 'worker', prompt: 'p', tag: 't' }, cancel: 'before', steps: [{ return: { content: 'never' } }] },
  { name: 'a_job_cancelled_during_prep_closes_the_prepared_session', args: { agent: 'worker', prompt: 'p', tag: 't' }, cancel: 'during-prep', steps: [{ return: { content: 'never' } }] },
  { name: 'a_respawn_is_marked', args: { agent: 'worker', prompt: 'p', tag: 't' }, respawned: true, steps: [{ return: { content: 'ok' } }] },
  { name: 'an_abnormal_finish_fails_the_job', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ return: { content: '', termination: 'empty' } }] },
  { name: 'a_throwing_turn_fails_the_job', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ throw: { message: 'turn broke' } }] },
];

function newSpawnWorld(scenario) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-spawn-'));
  const source = mkdtempSync(join(tmpdir(), 'mixdog-source-'));
  const agents = { worker: {}, ...(scenario.agents || {}) };
  for (const [name, def] of Object.entries(agents)) if (def) writeAgent(root, name, def);
  const config = scenario.config || BASE_CONFIG;
  const calls = [];
  const notices = [];
  const session = { id: 'sess_w1', cwd: '/work', parentSessionId: 'lead', ownerSessionId: 'lead', messages: [{ role: 'user', content: 'earlier' }] };
  let job = null;
  const mgr = {
    getSession: (id) =>
      id === session.id ? session : id === 'lead' && (scenario.acting || scenario.chain) ? { id: 'lead', agent: scenario.acting || '', turnBotChain: scenario.chain || [] } : null,
    unloadSessionRuntime: (id, reason) => void calls.push(`unload:${reason}`),
    closeSession: async (id, reason) => void calls.push(`close:${id}:${reason}`),
    askSession: async (id, prompt, context, _a, cwd, _b, hooks) => {
      calls.push(`ask:${prompt}@${cwd}`);
      for (const step of scenario.steps || []) {
        if (step.tool) hooks.onToolResult({ uiDiff: step.tool });
        else if (step.terminal) hooks.onTerminalResult?.(turnResult(step.terminal));
        else if (step.return) return turnResult(step.return);
        else if (step.throw) throw new Error(step.throw.message);
      }
      return turnResult({ content: '' });
    },
  };
  const canonical = scenario.surface !== 'none';
  const sessionSurface = {
    canonical,
    createChild: async ({ spec, prompt, tag }) => {
      calls.push(['createChild', { spec, prompt, tag }]);
      if (scenario.createThrows) throw new Error(scenario.createThrows);
      if (scenario.cancel === 'during-prep') bg.cancelBackgroundTask(job.taskId, 'cancelled mid prep');
      return { session, ...(scenario.effectiveCwd ? { effectiveCwd: scenario.effectiveCwd } : {}) };
    },
    runTurn: ({ prompt, cwd, ...hooks }) => mgr.askSession(session.id, prompt, null, null, cwd, null, hooks),
  };
  const workerTurns = {
    claim: () => {
      calls.push('claim');
      return { submissionId: 'sub-1', release: (status) => void calls.push(`release:${status}`) };
    },
    observe: () => null,
  };
  const notifySessionCompletion = (owner, text, meta) => {
    notices.push({ session: owner, text, ...(meta?.model_visible === false ? { meta } : {}) });
    return true;
  };
  const createTurnReviewCollector = () => {
    let latest = null;
    let completed = false;
    return {
      onToolResult: (message) => {
        if (typeof message?.uiDiff === 'string') latest = message.uiDiff;
      },
      complete: () => {
        if (completed) return;
        completed = true;
        calls.push(`review:${JSON.stringify(latest === null ? [] : [latest])}`);
      },
    };
  };
  const cfgMod = {
    loadConfig: () => config,
    resolveRuntimeSpec: (preset, options) => ({ runtime: preset.provider, options }),
  };
  const tags = scenario.tags || {};
  const startJob = createJobStarter({ mgr, notifyStatusChange: () => calls.push('status'), notifySessionCompletion });
  const runner = createSpawnRunner({
    mgr,
    workerTurns,
    notifySessionCompletion,
    emitSubagentEvent: (kind, agent, payload) => void calls.push(`emit:${kind}${payload.status ? `:${payload.status}` : ''}`),
    sessionSurface,
    createTurnReviewCollector,
  });
  const { prepareSpawn } = createSpawnPreparer({
    cfgMod,
    dataDir: root,
    STANDALONE_SOURCE_ROOT: source,
    defaultCwd: '/default',
    mcpScopeId: null,
    nextTag: () => scenario.nextTag || 'worker-1',
    resolveTag: (tag, context, options) => {
      calls.push(`resolveTag:${tag}:${options?.scanSessions === true}`);
      if (tags[tag] === 'THROW') throw new Error(`tag "${tag}" is ambiguous`);
      return tags[tag] || null;
    },
    wantsSessionScan: helpers.wantsSessionScan ?? ((args) => args.recover === true || args.scanSessions === true || args.scan_sessions === true),
    bindTag: (tag, sess, extra) => void calls.push(['bindTag', tag, sess.id, extra]),
    ensureProvider: async () => void calls.push('ensureProvider'),
    sessionSurface,
    refreshTagsFromSessions: () => void calls.push('refresh'),
    mgr,
  });
  const deferred = createDeferredSpawn({
    mgr,
    forgetTerminalSession: (tag, id) => void calls.push(`forget:${tag}:${id}`),
    pendingSpawnMeta: (args, extras) => spawnMeta.pendingSpawnMeta(cfgMod, args, extras),
    preparedSpawnMeta: spawnMeta.preparedSpawnMeta,
    mergeJobMeta: spawnMeta.mergeJobMeta,
    upsertWorkerSessionDeferred: (sess, tag, extra) => void calls.push(['upsert', tag, sess.id, extra]),
    notifyStatusChange: () => void calls.push('status'),
    DEFAULT_SPAWN_PREP_TIMEOUT_MS: 0,
    startJob,
    prepareSpawn,
    runSpawn: runner.runSpawn,
  });
  return { root, source, agents, config, calls, notices, session, mgr, prepareSpawn, deferred, setJob: (j) => void (job = j), getJob: () => job };
}

/** What the real helpers answer about an agent, which the Rust side takes as its host's answers. */
function hostAnswers(w, scenario) {
  const agent = helpers.normalizeAgentName(scenario.args.agent);
  const answers = {};
  if (agent) {
    const kind = helpers.readAgentFrontmatterKind(agent, w.root, w.source);
    answers.agent = {
      name: agent,
      defined: helpers.agentDefinitionExists(agent, w.root, w.source),
      disabled: routeConfig.isAgentDisabled(w.config, agent),
      kind,
      contact: routeConfig.isContactAgentId(agent, kind),
      permission: normalizeAgentPermission(helpers.readAgentFrontmatterPermission(agent, w.root, w.source)) || null,
      candidates: routeConfig.configuredAgentRouteCandidates(w.config, agent),
    };
  }
  answers.delegation = { chain: botChain.delegationChainOf('lead', w.mgr.getSession), acting: botChain.actingAgentOf(w.mgr.getSession('lead'), 'lead') };
  return answers;
}

const spawn = [];
for (const scenario of spawnScenarios) {
  clock = START;
  const w = newSpawnWorld(scenario);
  const context = { callerSessionId: 'lead', ownerSessionId: 'lead', clientHostPid: 4242, cwd: scenario.callerCwd || '/work' };
  const host = hostAnswers(w, scenario);
  if (scenario.lock) gate.setWorkspaceCwdLock('lead', scenario.lock);
  let task = null;
  let startError = null;
  try {
    task = w.deferred.startDeferredSpawnJob(scenario.args, scenario.callerCwd ?? '/work', context, context, scenario.respawned ? { respawned: true } : {});
    w.setJob(task);
  } catch (error) {
    startError = error.message;
  }
  const pending = task ? idOf(publicMeta(task.meta), task.taskId) : null;
  if (task && scenario.cancel === 'before') bg.cancelBackgroundTask(task.taskId, 'cancelled early');
  await settle();
  await settle();
  if (scenario.lock) gate.setWorkspaceCwdLock('lead', null);
  const final = task
    ? idOf(
        {
          status: task.status,
          error: task.error ?? null,
          terminalReason: task.terminalReason ?? null,
          meta: publicMeta(task.meta),
          label: task.label,
          notified: task.notified === true,
          result: task.result ?? null,
        },
        task.taskId
      )
    : null;
  spawn.push({
    name: scenario.name,
    scenario: {
      args: scenario.args,
      callerCwd: scenario.callerCwd ?? '/work',
      context,
      respawned: scenario.respawned === true,
      config: w.config,
      tags: scenario.tags || {},
      nextTag: scenario.nextTag || 'worker-1',
      lock: scenario.lock || null,
      effectiveCwd: scenario.effectiveCwd || null,
      createThrows: scenario.createThrows || null,
      cancel: scenario.cancel || null,
      window: scenario.window || null,
      steps: scenario.steps || [],
      canonical: scenario.surface !== 'none',
    },
    host,
    result: { startError, pending, calls: idOf(w.calls, task?.taskId), notices: idOf(w.notices, task?.taskId), final },
  });
}
write('spawn.json', spawn);


// FINALIZE
refreshSetManifest(stage, nodeRoot);
commitStage(stage, here);
console.log('flows recorded');
process.exit(0);
