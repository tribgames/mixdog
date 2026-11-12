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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFlowHooks } from './flow-hooks.mjs';
import { commitStage, parseArgs, refreshSetManifest, resolveTree, stageSet } from '../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
const stage = stageSet(here, ['flows']);
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-flows-'));
process.env.MIXDOG_DATA_DIR = dataDir;

installFlowHooks();

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
const { createTurnReviewCollector } = await load('src/session-runtime/services/agent-tool/turn-review.mjs');
const { providerRosterFiles } = await load('src/runtime/shared/llm/provider-catalog-registry.mjs');
const { resolvePluginData } = await load('src/runtime/shared/plugin-paths.mjs');
const { rmSync } = await import('node:fs');
const { _resetTurnSnapshotForTest } = await load('src/runtime/shared/turn-snapshot.mjs');
const { AgentStallAbortError } = await load('src/runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs');
const { armTurnTimeout, reapTurnShellJobs, takeStoppedShellJobs } = await load('src/runtime/agent/orchestrator/session/manager/turn-reap.mjs');
const { runtimeState } = await load('src/runtime/agent/orchestrator/session/manager/runtime-state.mjs');
const { createAgentTree } = await load('src/standalone/session-service/agent-tree.mjs');

/** The loader hook's report of the real review store's calls (see flow-hooks.mjs). */
const reviewSpy = (calls) => (kind, args, result) => {
  if (kind === 'begin') calls.push(['reviewBegin', args[0], args[1], { tag: args[2]?.tag, agent: args[2]?.agent }]);
  else if (result === true) calls.push(['reviewComplete', args[1]]);
};
const { mkdirSync: mkdir, writeFileSync: put } = await import('node:fs');

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await tick();
};
// Paths are recorded without a drive letter and with /: the golden is the same on every platform.
const norm = (_key, v) => (typeof v === 'string' && /^[A-Za-z]:[\\/]/.test(v) ? v.slice(2).replace(/\\/g, '/') : v);
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
  agents: { worker: { provider: 'openai', model: 'gpt-5', effort: 'medium' }, ctx: { provider: 'openai', model: 'gpt-5', contextPercent: 40 }, ctxtok: { provider: 'openai', model: 'gpt-5', contextTokens: 300000 }, ctxw: { provider: 'openai-oauth', model: 'gpt-5', contextPercent: 40 }, ctxwtok: { provider: 'openai-oauth', model: 'gpt-5', contextTokens: 300000 } },
};

/** Forwarded files in every shape a caller may send: stored references keep only their reference
 *  fields; anything else is dropped (handoffContent). */
const ATTACHMENT_PARTS = [
  { type: 'file', attachmentRef: 'a'.repeat(64), mimeType: 'application/pdf', filename: 'doc.pdf', sizeBytes: 12, path: '/secret/doc.pdf', data: 'inline' },
  { type: 'image', attachmentRef: 'b'.repeat(64) },
  { type: 'text', attachmentRef: 'c'.repeat(64), filename: 'notes.txt', sizeBytes: -1, mimeType: 'x'.repeat(120) },
  { type: 'file', attachmentRef: 'not-a-reference' },
  { type: 'video', attachmentRef: 'd'.repeat(64) },
  null,
];

/** The progress watchdog's idle-stop sentence (`evaluateAgentWatchdogAbort`). */
const STALE = 'agent task stale (600000ms without stream/tool progress)';

/** Background shells registered when a stalled turn's world opens: offsets are ms from the clock,
 *  the turn's ask started 5 s before it (`askOffset`). `kill` is what the job's cancel hook
 *  confirms: `confirmed` / `unconfirmed` set a kill outcome, `none` leaves a promoted job. */
const SHELL_JOBS = [
  { id: 'old', startedOffset: -20000, kill: 'confirmed' },
  { id: 'mine-a', startedOffset: -3000, kill: 'confirmed' },
  { id: 'mine-b', startedOffset: -1000, kill: 'unconfirmed' },
  { id: 'mine-c', startedOffset: 0, kill: 'none' },
  { id: 'theirs', startedOffset: -1000, session: 'sess_other', kill: 'confirmed' },
];
const ASK_OFFSET = -5000;
const SHELL_SESSION = 'sess_w1';
let shellWorlds = 0;
let dryWorlds = 0;
/** Task ids carry a per-world prefix; the golden names the jobs by their own ids. */
const unprefixed = (value) => JSON.parse(JSON.stringify(value).replace(/real\d+_/g, ''));

/** Registers `jobs` as running background shells; returns their task ids. */
function registerShellJobs(prefix, jobs) {
  return jobs.map((job) => {
    const taskId = `${prefix}${job.id}`;
    bg.registerBackgroundTask({
      taskId,
      startedAtMs: START + job.startedOffset,
      surface: 'shell',
      label: job.id,
      meta: { sessionId: job.session ?? SHELL_SESSION },
      cancel: () => {
        const task = bg.getBackgroundTask(taskId);
        if (job.kill === 'confirmed') task.cancelOutcome = Promise.resolve({ terminated: true });
        else if (job.kill === 'unconfirmed') task.cancelOutcome = Promise.resolve({ terminated: false });
      },
    });
    return taskId;
  });
}

/** The watchdog's stop of the session's turn: the reap armed before the abort, and the sweep after
 *  the turn unwound (`armTurnTimeout`, `reapTurnShellJobs`). */
function reapStalledTurn() {
  armTurnTimeout(SHELL_SESSION);
  reapTurnShellJobs(SHELL_SESSION, runtimeState.get(SHELL_SESSION));
}

/** What real Node's reap leaves for the handoff, from a world of its own (the reap is one-shot per
 *  task): the stopped / stopping job ids the Rust host takes as its answer. */
async function dryReap(scenario) {
  const prefix = `dry${(dryWorlds += 1)}_`;
  registerShellJobs(prefix, scenario.shellJobs);
  runtimeState.set(SHELL_SESSION, { askStartedAt: START + ASK_OFFSET, closed: false, controller: new AbortController() });
  reapStalledTurn();
  const taken = await takeStoppedShellJobs(SHELL_SESSION);
  runtimeState.delete(SHELL_SESSION);
  const alias = (ids) => ids.map((id) => id.slice(prefix.length));
  return { stopped: alias(taken.stopped), stopping: alias(taken.stopping) };
}

const spawnScenarios = [
  { name: 'a_spawn_runs_to_completion', args: { agent: 'worker', prompt: 'do it', tag: 'scout' }, steps: [{ tool: 'diff-1' }, { terminal: { content: 'done' } }, { return: { content: 'done' } }] },
  { name: 'a_generated_tag_is_used', args: { agent: 'worker', prompt: 'do it' }, nextTag: 'worker-7', steps: [{ return: { content: 'ok' } }] },
  { name: 'a_directory_and_task_type_travel_with_the_session', args: { agent: 'worker', prompt: 'p', tag: 't', cwd: 'sub/dir', taskType: 'review', cacheKey: 'ck' }, callerCwd: '/work', steps: [{ return: { content: 'ok' } }] },
  { name: 'type_hint_stands_in_for_task_type', args: { agent: 'worker', prompt: 'p', tag: 't', typeHint: 'quick' }, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_locked_workspace_pins_the_worker', args: { agent: 'worker', prompt: 'p', tag: 't', cwd: 'elsewhere' }, callerCwd: '/work', lock: '/lead/worktree', steps: [{ return: { content: 'ok' } }] },
  { name: 'the_surface_may_move_the_workers_directory', args: { agent: 'worker', prompt: 'p', tag: 't' }, effectiveCwd: '/moved', steps: [{ return: { content: 'ok' } }] },
  { name: 'an_agent_permission_travels', args: { agent: 'worker', prompt: 'p', tag: 't' }, agents: { worker: { permission: 'read' } }, steps: [{ return: { content: 'ok' } }] },
  { name: 'an_unknown_window_leaves_the_choice_as_stored', args: { agent: 'ctx', prompt: 'p', tag: 't' }, agents: { ctx: {} }, steps: [{ return: { content: 'ok' } }] },
  { name: 'an_explicit_model_needs_no_default', args: { agent: 'worker', prompt: 'p', tag: 't', provider: 'xai', model: 'grok', effort: 'low', fast: true }, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_delegated_spawn_is_owned_by_its_owner', args: { agent: 'worker', prompt: 'p', tag: 't', cwd: 'elsewhere' }, owner: 'boss', lock: '/boss/worktree', lockOwner: 'boss', steps: [{ return: { content: 'ok' } }] },
  { name: 'a_lock_held_by_another_session_does_not_pin_the_worker', args: { agent: 'worker', prompt: 'p', tag: 't', cwd: 'elsewhere' }, callerCwd: '/work', owner: 'boss', lock: '/other/worktree', lockOwner: 'someone-else', steps: [{ return: { content: 'ok' } }] },
  { name: 'an_in_process_spawn_builds_the_session_itself', surface: 'none', args: { agent: 'worker', prompt: 'do it', tag: 'scout' }, steps: [{ tool: 'diff-1' }, { return: { content: 'done' } }] },
  { name: 'an_in_process_spawn_may_move_the_workers_directory', surface: 'none', effectiveCwd: '/moved', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ return: { content: 'ok' } }] },
  { name: 'an_in_process_spawn_fails_when_the_provider_cannot_start', surface: 'none', ensureThrows: 'provider unavailable', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [] },
  { name: 'a_context_share_is_sized_from_the_model_window', args: { agent: 'ctxw', prompt: 'p', tag: 't' }, agents: { ctxw: {} }, window: { contextWindow: 200000, maxContextWindow: 1000000 }, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_token_choice_is_sized_from_the_model_window', args: { agent: 'ctxwtok', prompt: 'p', tag: 't' }, agents: { ctxwtok: {} }, window: { contextWindow: 200000, maxContextWindow: 1000000 }, steps: [{ return: { content: 'ok' } }] },
  { name: 'forwarded_files_ride_along_the_first_turn', args: { agent: 'worker', prompt: 'look', tag: 't', attachmentParts: ATTACHMENT_PARTS, context: { room: 1 } }, steps: [{ return: { content: 'ok' } }] },
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
  // A running turn is cancelled (agent close / agent-tree cancel): the owner hears once, as cancelled, with what the turn had said (job-task spawn-flow.test.mjs).
  { name: 'a_running_turn_cancelled_reports_its_partial_output_once', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ say: 'half of the review' }, { cancelTask: 'cancelled by agent close' }, { say: 'late words' }, { return: { content: 'late' } }] },
  { name: 'a_running_turn_cancelled_without_output_sends_the_header_only_notice', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ cancelTask: 'cancelled by agent close' }, { return: { content: '' } }] },
  // The agent tree's own cancel (`cancelAgentTree`, real) of the worker's session while its turn runs: the session's running task is cancelled with the tree's reason first, so the owner hears once, as cancelled, with what the turn had said (spawn-flow.test.mjs).
  { name: 'an_agent_tree_cancel_reports_the_partial_output_once', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ say: 'partial review' }, { cancelTree: 'agent session cancelled' }, { say: 'late words' }, { return: { content: 'late' } }] },
  // The same cancel with agents below the worker (sess_c1 and sess_c3 under it, sess_c2 under sess_c1) and jobs: the agents close descendants first, each after the jobs it started and those bound to it; a job another session started is left running.
  { name: 'an_agent_tree_cancel_closes_the_descendants_and_cancels_their_jobs', args: { agent: 'worker', prompt: 'p', tag: 't' }, tree: { children: [{ id: 'sess_c1', parent: 'sess_w1' }, { id: 'sess_c2', parent: 'sess_c1' }, { id: 'sess_c3', parent: 'sess_w1' }], jobs: [{ as: 'owned', tag: 'grandkid', caller: 'sess_c1' }, { as: 'bound', tag: 'kid', sessionId: 'sess_c1', caller: 'sess_w1' }, { as: 'other', tag: 'stranger', caller: 'sess_x' }] }, steps: [{ say: 'partial review' }, { cancelTree: 'agent session cancelled' }, { say: 'late words' }, { return: { content: 'late' } }] },
  // The completion goes to the caller that started the job: a routing id or a notify callback on the context does not take it.
  { name: 'a_completion_goes_to_the_immutable_caller_owner', args: { agent: 'worker', prompt: 'p', tag: 't' }, staleContext: true, steps: [{ return: { content: 'owner handoff' } }] },
  // A host-set skill selection reaches the worker's turn on both runtimes, an empty one as an empty selection; none is invented.
  { name: 'a_host_skill_selection_reaches_the_turn', args: { agent: 'worker', prompt: 'p $payload-skill', tag: 't', skillSelection: 'trusted $a' }, trackSelection: true, steps: [{ return: { content: 'ok' } }] },
  { name: 'no_skill_selection_is_invented', args: { agent: 'worker', prompt: 'p', tag: 't' }, trackSelection: true, steps: [{ return: { content: 'ok' } }] },
  { name: 'an_in_process_spawn_passes_an_empty_selection', surface: 'none', args: { agent: 'worker', prompt: 'p', tag: 't', skillSelection: '' }, trackSelection: true, steps: [{ return: { content: 'ok' } }] },
  { name: 'an_in_process_spawn_invents_no_selection', surface: 'none', args: { agent: 'worker', prompt: 'p', tag: 't' }, trackSelection: true, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_respawn_is_marked', args: { agent: 'worker', prompt: 'p', tag: 't' }, respawned: true, steps: [{ return: { content: 'ok' } }] },
  { name: 'an_abnormal_finish_fails_the_job', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ return: { content: '', termination: 'empty' } }] },
  { name: 'a_throwing_turn_fails_the_job', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ throw: { message: 'turn broke' } }] },
  // The progress watchdog stopped the turn (a real `AgentStallAbortError`): what the owner gets.
  { name: 'a_stalled_turn_hands_its_partial_output_to_the_owner', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ say: 'first half' }, { say: 'second half' }, { stall: STALE }] },
  { name: 'a_stall_may_carry_its_own_handoff', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ say: 'ignored' }, { stall: STALE, partialHandoff: 'carried text' }] },
  { name: 'a_stall_with_an_empty_own_handoff_fails_the_job', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ say: 'unused' }, { stall: STALE, partialHandoff: '' }] },
  { name: 'a_stall_with_no_output_fails_the_job', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ stall: 'agent first transport stale (120000ms)' }] },
  { name: 'a_first_output_stall_with_output_hands_it_over', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ say: 'some text' }, { stall: 'agent first semantic response stale (600000ms)' }] },
  { name: 'a_row_of_only_a_dot_is_no_output', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ say: '.' }, { stall: STALE }] },
  { name: 'an_abort_that_is_not_a_stall_fails_the_job', args: { agent: 'worker', prompt: 'p', tag: 't' }, steps: [{ say: 'some text' }, { throw: { message: 'This operation was aborted' } }] },
  { name: 'a_stall_names_the_shell_jobs_it_stopped', args: { agent: 'worker', prompt: 'p', tag: 't' }, shellJobs: SHELL_JOBS, steps: [{ say: 'half done' }, { stall: STALE }] },
  { name: 'a_stall_with_no_output_names_the_shell_jobs_on_the_error', args: { agent: 'worker', prompt: 'p', tag: 't' }, shellJobs: SHELL_JOBS, steps: [{ stall: STALE }] },
  { name: 'a_stall_names_no_shell_job_when_the_turn_started_none', args: { agent: 'worker', prompt: 'p', tag: 't' }, shellJobs: [{ id: 'old', startedOffset: -20000, kill: 'confirmed' }, { id: 'theirs', startedOffset: -1000, session: 'sess_other', kill: 'confirmed' }], steps: [{ say: 'half done' }, { stall: STALE }] },
];

function newSpawnWorld(scenario) {
  _resetTurnSnapshotForTest();
  const root = mkdtempSync(join(tmpdir(), 'mixdog-spawn-'));
  const source = mkdtempSync(join(tmpdir(), 'mixdog-source-'));
  const agents = { worker: {}, ...(scenario.agents || {}) };
  for (const [name, def] of Object.entries(agents)) if (def) writeAgent(root, name, def);
  const config = scenario.config || BASE_CONFIG;
  const calls = [];
  const notices = [];
  const session = { id: 'sess_w1', cwd: '/work', parentSessionId: 'lead', ownerSessionId: 'lead', messages: [{ role: 'user', content: 'earlier' }] };
  let job = null;
  const selections = [];
  const staleNotify = { calls: 0 };
  // The real agent tree (agent-cancel.mjs): its cancel of a session closes the session and every agent below it,
  // descendants first, each after the background tasks it started and those bound to it. Its runtimes log their
  // closes like the manager's own close, `close:<session>:<reason>`.
  const runtimes = new Map();
  const runtimeFor = (id) => {
    if (!runtimes.has(id)) {
      runtimes.set(id, {
        terminal: false,
        isSessionTerminal() {
          return this.terminal;
        },
        readModelMessages: () => ({ messageCount: 0, messages: [] }),
        async closeCanonicalSession(reason) {
          this.terminal = true;
          calls.push(`close:${id}:${reason}`);
          return true;
        },
      });
    }
    return runtimes.get(id);
  };
  const tree = (scenario.steps || []).some((step) => step.cancelTree !== undefined)
    ? createAgentTree({ listSessions: async () => [], readStoredSession: async () => null, sessionOwner: (id) => ({ runtime: runtimeFor(id) }), stateBusy: () => false, entryForSession: async (id) => ({ runtime: runtimeFor(id) }), retainUnwatched() {}, createSession: async () => ({ sessionId: 'sess_w1' }) })
    : null;
  if (tree) {
    tree.linkAgentDescriptor({ id: 'sess_w1', parentSessionId: 'lead', ownerSessionId: 'lead', status: 'running' });
    for (const child of scenario.tree?.children || []) tree.linkAgentDescriptor({ id: child.id, parentSessionId: child.parent, status: 'idle' });
  }
  // The runs of the other jobs of a tree scenario end with the scenario, after their state has been read: a cancelled one
  // has not reported by then (its notification waits for its run), so no completion of theirs is in the order compared.
  const stays = {};
  stays.promise = new Promise((resolve) => (stays.resolve = resolve));
  let created = 0;
  const sessionsById = { [session.id]: session };
  const holds = {};
  const hold = (n) => {
    if (!holds[n]) {
      holds[n] = {};
      holds[n].promise = new Promise((resolve) => (holds[n].resolve = resolve));
    }
    return holds[n];
  };
  const shellIds = scenario.shellJobs ? registerShellJobs(`real${(shellWorlds += 1)}_`, scenario.shellJobs) : [];
  if (scenario.shellJobs) runtimeState.set(SHELL_SESSION, { askStartedAt: START + ASK_OFFSET, closed: false, controller: new AbortController() });
  const mgr = {
    getSession: (id) =>
      sessionsById[id] ?? (id === 'lead' && (scenario.acting || scenario.chain) ? { id: 'lead', agent: scenario.acting || '', turnBotChain: scenario.chain || [] } : null),
    unloadSessionRuntime: (id, reason) => void calls.push(`unload:${reason}`),
    closeSession: async (id, reason) => void calls.push(`close:${id}:${reason}`),
    askSession: async (id, prompt, context, _a, cwd, _b, hooks) => {
      calls.push(['ask', prompt, cwd]);
      // Whether the turn was handed a skill selection, and which: an absent one is `{}`.
      if (scenario.trackSelection) selections.push(Object.hasOwn(hooks, 'skillSelection') ? { skillSelection: hooks.skillSelection } : {});
      for (const step of scenario.steps || []) {
        if (step.tool) hooks.onToolResult({ uiDiff: step.tool });
        else if (step.terminal) hooks.onTerminalResult?.(turnResult(step.terminal));
        else if (step.return) return turnResult(step.return);
        else if (step.throw) throw new Error(step.throw.message);
        else if (step.say !== undefined) session.messages.push({ role: 'assistant', content: step.say });
        else if (step.cancelTask !== undefined) bg.cancelBackgroundTask(job.taskId, step.cancelTask);
        else if (step.cancelTree !== undefined) {
          await tree.cancelAgentTree(id, step.cancelTree);
        }
        else if (step.stall !== undefined) {
          if (scenario.shellJobs) reapStalledTurn();
          const error = new AgentStallAbortError(step.stall);
          if (step.partialHandoff !== undefined) error.partialHandoff = step.partialHandoff;
          throw error;
        }
      }
      return turnResult({ content: '' });
    },
  };
  const canonical = scenario.surface !== 'none';
  const sessionSurface = {
    canonical,
    createChild: async ({ spec, prompt, tag }) => {
      const n = (created += 1);
      calls.push(['createChild', { spec, prompt, tag }]);
      if (scenario.createThrows) throw new Error(scenario.createThrows);
      if (scenario.cancel === 'during-prep') bg.cancelBackgroundTask(job.taskId, 'cancelled mid prep');
      // A race holds the nth creation open until the script releases it.
      if (scenario.holdCreate?.includes(n)) await hold(n).promise;
      const made = n === 1 ? session : { ...session, id: `sess_w${n}` };
      sessionsById[made.id] = made;
      return { session: made, ...(scenario.effectiveCwd ? { effectiveCwd: scenario.effectiveCwd } : {}) };
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
  // The REAL review collector and review store run; the loader hook reports their calls.
  globalThis.__flowStub = {
    review: reviewSpy(calls),
    prepareAgentSession: (spec) => {
      calls.push(['prepareSession', spec]);
      return { session, ...(scenario.effectiveCwd ? { effectiveCwd: scenario.effectiveCwd } : {}) };
    },
  };
  const cfgMod = {
    loadConfig: () => config,
    resolveRuntimeSpec: (preset, options) => ({ runtime: preset.provider, options }),
  };
  const tags = { ...(scenario.tags || {}) };
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
    bindTag: (tag, sess, extra) => {
      calls.push(['bindTag', tag, sess.id, extra]);
      tags[tag] = sess.id;
    },
    ensureProvider: async (_config, provider) => {
      calls.push(['ensureProvider', provider]);
      if (scenario.ensureThrows) throw new Error(scenario.ensureThrows);
    },
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
  return { root, source, agents, config, calls, notices, session, shellIds, mgr, selections, staleNotify, startJob, stays: stays.promise, endStays: stays.resolve, release: (n) => hold(n).resolve(), prepareSpawn, deferred, setJob: (j) => void (job = j), getJob: () => job };
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
  if (scenario.shellJobs) scenario.dry = await dryReap(scenario);
  const w = newSpawnWorld(scenario);
  const context = {
    callerSessionId: 'lead',
    ownerSessionId: scenario.owner ?? 'lead',
    clientHostPid: 4242,
    cwd: scenario.callerCwd || '/work',
    // A stale routing id, session id and notify callback: none takes the completion (`callerSessionId || sessionId`).
    ...(scenario.staleContext ? { routingSessionId: 'wrong-lead', sessionId: 'wrong-session', notifyFn: () => { w.staleNotify.calls += 1; return true; } } : {}),
  };
  const host = hostAnswers(w, scenario);
  if (scenario.shellJobs) host.stoppedShellJobs = scenario.dry;
  const lockOwner = scenario.lockOwner ?? 'lead';
  if (scenario.lock) gate.setWorkspaceCwdLock(lockOwner, scenario.lock);
  // A populated provider-model cache: the roster file the window lookup reads.
  const rosterFiles = scenario.window ? providerRosterFiles('openai-oauth').map((name) => join(resolvePluginData(), name)) : [];
  if (scenario.window && !rosterFiles.length) throw new Error('openai-oauth has no roster file');
  for (const file of rosterFiles) put(file, JSON.stringify({ models: [{ id: 'gpt-5', ...scenario.window }] }));
  let task = null;
  let startError = null;
  // The other jobs of a tree scenario, started by the sessions that own them before the worker's, and running (admitted, working) before its turn does.
  const extraJobs = {};
  for (const job of scenario.tree?.jobs || []) {
    extraJobs[job.as] = w.startJob('spawn', { tag: job.tag, ...(job.sessionId ? { sessionId: job.sessionId } : {}) }, () => w.stays, { callerSessionId: job.caller, clientHostPid: 4242 });
  }
  if (scenario.tree?.jobs) await settle();
  try {
    task = w.deferred.startDeferredSpawnJob(scenario.args, scenario.callerCwd ?? '/work', context, context, scenario.respawned ? { respawned: true } : {});
    w.setJob(task);
  } catch (error) {
    startError = error.message;
  }
  // The other jobs are named by their alias (`job_<alias>`), as the races are.
  const asAlias = (value) => {
    let text = JSON.stringify(value);
    for (const [alias, job] of Object.entries(extraJobs)) text = text.split(job.taskId).join(`job_${alias}`);
    return JSON.parse(text);
  };
  const pending = task ? idOf(publicMeta(task.meta), task.taskId) : null;
  if (task && scenario.cancel === 'before') bg.cancelBackgroundTask(task.taskId, 'cancelled early');
  await settle();
  await settle();
  if (scenario.lock) gate.setWorkspaceCwdLock(lockOwner, null);
  const shellStatuses = scenario.shellJobs ? Object.fromEntries(w.shellIds.map((id) => [id.replace(/^real\d+_/, ''), bg.getBackgroundTask(id)?.status ?? null])) : null;
  if (scenario.shellJobs) {
    runtimeState.delete(SHELL_SESSION);
    bg.cancelBackgroundTasks({ surface: 'shell', notify: false, reason: 'recorder cleanup' });
  }
  for (const file of rosterFiles) rmSync(file, { force: true });
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
      lockOwner,
      owner: context.ownerSessionId,
      window: scenario.window || null,
      ensureThrows: scenario.ensureThrows || null,
      effectiveCwd: scenario.effectiveCwd || null,
      createThrows: scenario.createThrows || null,
      cancel: scenario.cancel || null,
      steps: scenario.steps || [],
      ...(scenario.tree ? { tree: scenario.tree } : {}),
      ...(scenario.shellJobs ? { shellJobs: scenario.shellJobs, askOffset: ASK_OFFSET } : {}),
      canonical: scenario.surface !== 'none',
    },
    host,
    result: {
      startError,
      pending,
      calls: asAlias(unprefixed(idOf(w.calls, task?.taskId))),
      notices: asAlias(unprefixed(idOf(w.notices, task?.taskId))),
      final: unprefixed(final),
      ...(shellStatuses ? { shellTasks: shellStatuses } : {}),
      ...(scenario.trackSelection ? { selections: w.selections } : {}),
      ...(scenario.staleContext ? { staleNotifyCalls: w.staleNotify.calls } : {}),
      ...(scenario.tree?.jobs ? { extraJobs: Object.fromEntries(Object.entries(extraJobs).map(([alias, job]) => [alias, idOf({ status: job.status, error: job.error ?? null, terminalReason: job.terminalReason ?? null, meta: publicMeta(job.meta), label: job.label, notified: job.notified === true }, null)])) } : {}),
    },
  });
  w.endStays();
}
write('spawn.json', spawn);

// ---- send: a follow-up to an existing worker ------------------------------------------------

const OWN = { agent: 'worker', presetName: 'AGENT WORKER', provider: 'openai', model: 'gpt-5', effort: 'medium' };
const MOVED = { ...BASE_CONFIG, agents: { ...BASE_CONFIG.agents, worker: { provider: 'xai', model: 'grok', effort: 'high', fast: true } } };

const sendScenarios = [
  // prepareSend
  { name: 'prepare_by_tag', op: 'prepare', args: { tag: 'scout', prompt: 'hello' } },
  { name: 'prepare_by_session_id', op: 'prepare', args: { sessionId: 'sess_w1', prompt: 'hello' }, tags: { sess_w1: 'sess_w1' } },
  { name: 'prepare_needs_a_target', op: 'prepare', args: { prompt: 'hello' } },
  { name: 'prepare_unknown_target', op: 'prepare', args: { tag: 'ghost', prompt: 'hello' } },
  { name: 'prepare_closed_session', op: 'prepare', args: { tag: 'scout', prompt: 'hello' }, session: { closed: true } },
  { name: 'prepare_needs_a_prompt', op: 'prepare', args: { tag: 'scout' } },
  { name: 'prepare_recover_scans', op: 'prepare', args: { tag: 'scout', prompt: 'hello', recover: true } },
  // dispatch: a job
  { name: 'an_idle_in_process_worker_runs_a_send_job', op: 'dispatch', steps: [{ tool: 'diff-1' }, { terminal: { content: 'sent' } }, { return: { content: 'sent' } }] },
  { name: 'an_idle_canonical_worker_runs_a_send_job', op: 'dispatch', surface: 'canonical', steps: [{ return: { content: 'sent' } }] },
  { name: 'a_resumed_send_is_marked', op: 'dispatch', extras: { resumed: true }, steps: [{ return: { content: 'sent' } }] },
  { name: 'a_send_job_keeps_the_sessions_route_in_its_card', op: 'dispatch', session: { fast: true, autoEffort: false, effort: 'low' }, steps: [{ return: { content: 'sent' } }] },
  { name: 'an_abnormal_send_fails_the_job', op: 'dispatch', steps: [{ return: { content: '', termination: 'empty' } }] },
  { name: 'a_throwing_send_fails_the_job', op: 'dispatch', steps: [{ throw: { message: 'send broke' } }] },
  { name: 'a_canonical_session_reports_a_handoff_only_result', op: 'dispatch', surface: 'canonical', steps: [{ return: { content: 'plain' } }] },
  // dispatch: queued behind a running turn
  { name: 'a_busy_canonical_worker_queues_the_prompt', op: 'dispatch', surface: 'canonical', busy: true, enqueueReturns: { queueDepth: 3 }, extras: { reused: true } },
  { name: 'a_busy_canonical_worker_that_will_not_queue_runs_a_job', op: 'dispatch', surface: 'canonical', busy: true, enqueueReturns: null, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_busy_in_process_worker_queues_the_prompt', op: 'dispatch', busy: true, pendingDepth: 2 },
  { name: 'a_busy_in_process_worker_without_a_queue_runs_a_job', op: 'dispatch', busy: true, noPending: true, steps: [{ return: { content: 'ok' } }] },
  { name: 'the_callers_context_travels_with_the_queued_prompt', op: 'dispatch', busy: true, pendingDepth: 1, args: { tag: 'scout', prompt: 'hi', context: { room: 1 } } },
  // dispatch: the route a worker follows
  { name: 'an_idle_in_process_worker_takes_the_followed_route_in_place', op: 'dispatch', config: MOVED, session: OWN, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_busy_in_process_worker_holds_the_followed_route', op: 'dispatch', config: MOVED, session: OWN, busy: true, pendingDepth: 1 },
  { name: 'a_canonical_worker_applies_the_followed_route_through_the_surface', op: 'dispatch', surface: 'canonical', config: MOVED, session: OWN, afterSetRoute: { provider: 'xai', model: 'grok', effort: 'high', fast: true }, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_worker_already_on_the_route_changes_nothing', op: 'dispatch', config: BASE_CONFIG, session: OWN, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_stale_hold_is_dropped_when_the_session_is_back_on_the_route', op: 'dispatch', config: BASE_CONFIG, session: { ...OWN, heldRoute: { provider: 'xai', model: 'grok' } }, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_held_route_that_matches_is_left', op: 'dispatch', config: MOVED, session: { ...OWN, heldRoute: { provider: 'xai', model: 'grok', effort: 'high', fast: true } }, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_worker_on_an_explicit_preset_keeps_it', op: 'dispatch', config: MOVED, session: { ...OWN, presetName: 'custom-preset' }, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_worker_on_the_agents_stored_name_follows', op: 'dispatch', config: MOVED, session: { ...OWN, presetName: undefined, preset: 'agent-worker' }, steps: [{ return: { content: 'ok' } }] },
  { name: 'an_agent_without_a_route_follows_nothing', op: 'dispatch', config: { ...BASE_CONFIG, agents: {} }, session: OWN, steps: [{ return: { content: 'ok' } }] },
  { name: 'an_explicit_route_goes_through_the_surface', op: 'dispatch', surface: 'canonical', route: { provider: 'xai', model: 'grok' }, afterSetRoute: { provider: 'xai', model: 'grok' }, steps: [{ return: { content: 'ok' } }] },
  { name: 'an_explicit_route_on_an_in_process_worker_fails', op: 'dispatch', route: { provider: 'xai', model: 'grok' }, steps: [] },
  // forwarded files
  { name: 'a_send_job_carries_forwarded_files', op: 'dispatch', args: { tag: 'scout', prompt: 'look', attachmentParts: ATTACHMENT_PARTS }, steps: [{ return: { content: 'ok' } }] },
  { name: 'a_busy_canonical_worker_queues_the_prompt_with_its_files', op: 'dispatch', surface: 'canonical', busy: true, enqueueReturns: { queueDepth: 2 }, args: { tag: 'scout', prompt: 'look', attachmentParts: ATTACHMENT_PARTS } },
  { name: 'a_busy_in_process_worker_queues_the_prompt_with_its_files', op: 'dispatch', busy: true, pendingDepth: 3, args: { tag: 'scout', prompt: 'look', attachmentParts: ATTACHMENT_PARTS } },
  { name: 'a_part_list_with_no_usable_part_is_plain_text', op: 'dispatch', args: { tag: 'scout', prompt: 'look', attachmentParts: [{ type: 'video' }, null] }, steps: [{ return: { content: 'ok' } }] },
  // the turn review
  { name: 'a_send_collects_its_latest_diff_for_the_owner', op: 'dispatch', steps: [{ tool: 'diff-1' }, { tool: 'diff-2' }, { terminal: { content: 'sent' } }, { return: { content: 'sent' } }] },
  { name: 'a_failed_send_still_completes_its_review', op: 'dispatch', steps: [{ tool: 'diff-1' }, { throw: { message: 'send broke' } }] },
  // adopting the caller
  { name: 'a_send_hands_the_worker_to_its_caller', op: 'adopt' },
  { name: 'a_send_without_a_caller_session_rebinds_nothing_to_it', op: 'adopt', noCaller: true },
  // wake
  { name: 'an_idle_worker_is_woken_with_an_empty_prompt', op: 'wake', steps: [{ return: { content: 'woken' } }] },
  { name: 'a_busy_worker_is_not_woken', op: 'wake', busy: true },
  { name: 'a_closed_worker_is_not_woken', op: 'wake', session: { closed: true } },
];

function newSendWorld(sc) {
  _resetTurnSnapshotForTest();
  const calls = [];
  const notices = [];
  const session = { id: 'sess_w1', agent: 'worker', provider: 'openai', model: 'gpt-5', cwd: '/work', parentSessionId: 'lead', ownerSessionId: 'lead', clientHostPid: 4242, messages: [{ role: 'user', content: 'earlier' }], ...(sc.session || {}) };
  for (const [k, v] of Object.entries(session)) if (v === undefined) delete session[k];
  const canonical = sc.surface === 'canonical';
  let asks = 0;
  let inFlight = 0;
  const holds = {};
  const hold = (n) => {
    if (!holds[n]) {
      holds[n] = {};
      holds[n].promise = new Promise((resolve) => (holds[n].resolve = resolve));
    }
    return holds[n];
  };
  const mgr = {
    getSession: (id) => (id === session.id ? session : null),
    updateSessionRoute: (id, route, options) => void calls.push(['updateSessionRoute', id, route, options.crossProvider]),
    holdSessionRoute: (id, route) => void calls.push(['holdSessionRoute', id, route]),
    ...(sc.noPending
      ? {}
      : {
          enqueuePendingMessage: (id, prompt) => {
            calls.push(['enqueuePending', id, prompt]);
            return sc.pendingDepth ?? 1;
          },
        }),
    unloadSessionRuntime: (id, reason) => void calls.push(`unload:${reason}`),
    closeSession: async (id, reason) => void calls.push(`close:${id}:${reason}`),
    askSession: async (id, prompt, context, _a, cwd, _b, hooks) => {
      calls.push(['ask', prompt, cwd]);
      asks += 1;
      inFlight += 1;
      try {
        if (sc.holdAsk?.includes(asks)) await hold(asks).promise;
        return await script(hooks);
      } finally {
        inFlight -= 1;
      }
    },
  };
  const script = async (hooks) => {
      for (const step of sc.steps || []) {
        if (step.tool) hooks.onToolResult({ uiDiff: step.tool });
        else if (step.terminal) hooks.onTerminalResult?.(turnResult(step.terminal));
        else if (step.return) return turnResult(step.return);
        else if (step.throw) throw new Error(step.throw.message);
      }
      return turnResult({ content: '' });
  };
  const sessionSurface = {
    canonical,
    runTurn: ({ prompt, cwd, ...hooks }) => mgr.askSession(session.id, prompt, null, null, cwd, null, hooks),
    enqueueTurn: async ({ prompt, context }) => {
      calls.push(['enqueueTurn', prompt, context]);
      return sc.enqueueReturns ?? null;
    },
    setRoute: async ({ route }) => {
      calls.push(['setRoute', route]);
      Object.assign(session, sc.afterSetRoute || {});
    },
  };
  const notifySessionCompletion = (owner, text, meta) => {
    notices.push({ session: owner, text, ...(meta?.model_visible === false ? { meta } : {}) });
    return true;
  };
  const workerTurns = {
    claim: () => {
      calls.push('claim');
      return { submissionId: 'sub-1', release: (status) => void calls.push(`release:${status}`) };
    },
    observe: (s) => void calls.push(['observe', s.id]),
  };
  const runner = createSpawnRunner({
    mgr,
    workerTurns,
    notifySessionCompletion,
    emitSubagentEvent: () => {},
    sessionSurface,
    createTurnReviewCollector,
  });
  globalThis.__flowStub = {
    review: reviewSpy(calls),
    rebindDelegation: async (id, caller) => {
      calls.push(['rebindDelegation', id, caller ?? null]);
      return false;
    },
  };
  const startJob = createJobStarter({ mgr, notifyStatusChange: () => calls.push('status'), notifySessionCompletion });
  const tags = sc.tags || { scout: 'sess_w1' };
  const flow = createSendFlow({
    mgr,
    cfgMod: { loadConfig: () => sc.config || BASE_CONFIG },
    dataDir: null,
    STANDALONE_SOURCE_ROOT: null,
    defaultCwd: '/default',
    sessionSurface,
    canUseSessionSurface: () => canonical,
    registry: {
      refreshTagsFromSessions: () => void calls.push('refresh'),
      wantsSessionScan: (args) => args.recover === true || args.scanSessions === true || args.scan_sessions === true,
      resolveTag: (tag, context, options) => {
        calls.push(`resolveTag:${tag}:${options?.scanSessions === true}`);
        return tags[tag] || null;
      },
      tagForSession: () => 'scout',
    },
    views: {
      isSessionBusy: () => sc.busy === true || inFlight > 0,
      renderJob: (job) => ({ task_id: job.taskId, status: job.status, tag: job.meta.tag, sessionId: job.meta.sessionId }),
    },
    spawnFlow: {
      workerTurns,
      workerNotifyFn: runner.workerNotifyFn,
      notifyOwnerAgentCompletionEarly: runner.notifyOwnerAgentCompletionEarly,
      startJob: (type, meta, run, ctx) => {
        const job = startJob(type, meta, run, ctx);
        lastJob = job;
        return job;
      },
    },
  });
  return { calls, notices, session, flow, release: (n) => hold(n).resolve(), getJob: () => lastJob };
}
let lastJob = null;

const send = [];
for (const sc of sendScenarios) {
  clock = START;
  lastJob = null;
  const w = newSendWorld(sc);
  const context = { callerSessionId: 'lead', ownerSessionId: 'lead', clientHostPid: 4242 };
  const args = sc.args || { tag: 'scout', prompt: 'follow up' };
  const record = { name: sc.name, scenario: { op: sc.op, args, session: w.session, surface: sc.surface || 'process', busy: sc.busy === true, noPending: sc.noPending === true, pendingDepth: sc.pendingDepth ?? 1, enqueueReturns: sc.enqueueReturns ?? null, afterSetRoute: sc.afterSetRoute || null, config: sc.config || BASE_CONFIG, tags: sc.tags || { scout: 'sess_w1' }, noCaller: sc.noCaller === true, extras: sc.extras || {}, route: sc.route || null, steps: sc.steps || [] } };
  record.scenario.session = JSON.parse(JSON.stringify(w.session));
  let result;
  try {
    if (sc.op === 'prepare') {
      const prepared = await w.flow.prepareSend(args, context);
      result = { prepared: { sessionId: prepared.sessionId, prompt: prepared.prompt, args: prepared.args } };
    } else if (sc.op === 'adopt') {
      await w.flow.adoptCaller({ args, session: w.session, sessionId: w.session.id, prompt: 'x' }, sc.noCaller ? {} : context);
      result = { adopted: true };
    } else if (sc.op === 'wake') {
      result = { woke: w.flow.wakeIdleWorker('sess_w1') };
    } else {
      const prepared = { args, session: w.session, sessionId: w.session.id, prompt: 'follow up', ...(sc.route ? { route: sc.route } : {}) };
      const reply = await w.flow.dispatchToExistingSession(prepared, context, sc.extras || {});
      result = typeof reply === 'string' && reply.startsWith('agent message queued') ? { queued: reply } : { task: true };
    }
  } catch (error) {
    result = { error: error.message };
  }
  await settle();
  await settle();
  const task = lastJob;
  record.result = {
    ...result,
    calls: idOf(w.calls, task?.taskId),
    notices: idOf(w.notices, task?.taskId),
    final: task
      ? idOf({ status: task.status, error: task.error ?? null, terminalReason: task.terminalReason ?? null, meta: publicMeta(task.meta), notified: task.notified === true, result: task.result ?? null }, task.taskId)
      : null,
  };
  send.push(record);
}
write('send.json', send);

// ---- races: two requests meeting on one tag or worker, a cancel meeting a settle -----------
//
// Each race is a script over a world whose slow steps (a session's creation, a turn's ask) wait
// for the script to release them, so the interleaving is forced and the same in every runtime.
// Node's ordering decides the outcome; the goldens record whatever it gives.

const taskState = (task) => ({
  status: task.status,
  error: task.error ?? null,
  terminalReason: task.terminalReason ?? null,
  meta: publicMeta(task.meta),
  notified: task.notified === true,
  result: task.result ?? null,
});
const maskJobs = (value, jobs) => {
  let text = JSON.stringify(value);
  for (const [alias, task] of Object.entries(jobs)) if (task) text = text.split(task.taskId).join(`job_${alias}`);
  return JSON.parse(text, norm);
};
const sameEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const raceScenarios = [
  {
    name: 'two_spawns_meeting_on_one_tag_before_either_binds_both_run',
    kind: 'spawn',
    scenario: { holdCreate: [1], steps: [{ return: { content: 'ok' } }] },
    ops: [
      { op: 'start', as: 'a', args: { agent: 'worker', prompt: 'p', tag: 'dup' } },
      { op: 'until', head: 'createChild', count: 1 },
      { op: 'start', as: 'b', args: { agent: 'worker', prompt: 'p', tag: 'dup' } },
      { op: 'until', log: 'resolveTag:dup:false', count: 2 },
      { op: 'until', log: 'unload:agent-turn-complete', count: 1 },
      { op: 'until', log: 'status', count: 4 },
      { op: 'until', notices: 1 },
      { op: 'release', n: 1 },
      { op: 'settle' },
    ],
  },
  {
    name: 'a_spawn_after_the_first_bound_the_tag_loses',
    kind: 'spawn',
    scenario: { steps: [{ return: { content: 'ok' } }] },
    ops: [
      { op: 'start', as: 'a', args: { agent: 'worker', prompt: 'p', tag: 'dup' } },
      { op: 'settle' },
      { op: 'until', log: 'status', count: 3 },
      { op: 'start', as: 'b', args: { agent: 'worker', prompt: 'p', tag: 'dup' } },
      { op: 'settle' },
    ],
  },
  {
    name: 'a_spawn_cancelled_while_its_session_is_created_closes_it_and_the_other_completes',
    kind: 'spawn',
    scenario: { holdCreate: [1], steps: [{ return: { content: 'ok' } }] },
    ops: [
      { op: 'start', as: 'a', args: { agent: 'worker', prompt: 'p', tag: 'one' } },
      { op: 'until', head: 'createChild', count: 1 },
      { op: 'start', as: 'b', args: { agent: 'worker', prompt: 'p', tag: 'two' } },
      { op: 'until', log: 'resolveTag:two:false', count: 1 },
      { op: 'until', log: 'unload:agent-turn-complete', count: 1 },
      { op: 'until', log: 'status', count: 4 },
      { op: 'cancel', as: 'a', reason: 'cancelled mid create' },
      { op: 'until', log: 'status', count: 5 },
      { op: 'release', n: 1 },
      { op: 'settle' },
    ],
  },
  {
    name: 'a_send_meeting_a_running_send_is_queued_behind_it',
    kind: 'send',
    scenario: { holdAsk: [1], pendingDepth: 1, steps: [{ return: { content: 'first' } }] },
    ops: [
      { op: 'dispatch', as: 'a' },
      { op: 'until', log: ['ask', 'follow up', '/work'], count: 1 },
      { op: 'dispatch', as: 'b' },
      { op: 'release', n: 1 },
      { op: 'settle' },
    ],
  },
  {
    name: 'a_cancel_meeting_a_running_send_settles_it_once',
    kind: 'send',
    scenario: { holdAsk: [1], steps: [{ return: { content: 'late' } }] },
    ops: [
      { op: 'dispatch', as: 'a' },
      { op: 'until', log: ['ask', 'follow up', '/work'], count: 1 },
      { op: 'cancel', as: 'a', reason: 'cancelled mid turn' },
      { op: 'until', log: 'status', count: 2 },
      { op: 'release', n: 1 },
      { op: 'settle' },
    ],
  },
  {
    name: 'a_cancel_after_a_send_settled_changes_nothing',
    kind: 'send',
    scenario: { steps: [{ terminal: { content: 'done' } }, { return: { content: 'done' } }] },
    ops: [{ op: 'dispatch', as: 'a' }, { op: 'settle' }, { op: 'cancel', as: 'a', reason: 'too late' }, { op: 'settle' }],
  },
];

const races = [];
for (const race of raceScenarios) {
  clock = START;
  lastJob = null;
  const jobs = {};
  const replies = {};
  const context = { callerSessionId: 'lead', ownerSessionId: 'lead', clientHostPid: 4242, cwd: '/work' };
  let world;
  let host = null;
  if (race.kind === 'spawn') {
    world = newSpawnWorld({ args: { agent: 'worker' }, ...race.scenario });
    host = hostAnswers(world, { args: { agent: 'worker' }, ...race.scenario });
  } else {
    world = newSendWorld({ ...race.scenario });
  }
  const calls = world.calls;
  for (const op of race.ops) {
    if (op.op === 'start') {
      jobs[op.as] = world.deferred.startDeferredSpawnJob(op.args, '/work', context, context, {});
      world.setJob(jobs[op.as]);
    } else if (op.op === 'dispatch') {
      const prepared = { args: { tag: 'scout', prompt: 'follow up' }, session: world.session, sessionId: world.session.id, prompt: 'follow up' };
      const before = lastJob;
      const reply = await world.flow.dispatchToExistingSession(prepared, context, {});
      replies[op.as] = typeof reply === 'string' && reply.startsWith('agent message queued') ? { queued: reply } : { task: true };
      if (lastJob !== before) jobs[op.as] = lastJob;
    } else if (op.op === 'until') {
      const matches = (c) => (op.head ? (Array.isArray(c) ? c[0] : c) === op.head : sameEntry(c, op.log));
      if (op.notices) while (world.notices.length < op.notices) await tick();
      else while (calls.filter(matches).length < op.count) await tick();
    } else if (op.op === 'release') {
      world.release(op.n);
    } else if (op.op === 'cancel') {
      bg.cancelBackgroundTask(jobs[op.as].taskId, op.reason);
    } else if (op.op === 'settle') {
      await settle();
      await settle();
    }
  }
  const finals = Object.fromEntries(Object.entries(jobs).map(([alias, task]) => [alias, taskState(task)]));
  races.push({
    name: race.name,
    kind: race.kind,
    scenario: { ...(race.kind === 'spawn' ? { config: world.config, canonical: true } : { config: BASE_CONFIG, surface: 'process', session: JSON.parse(JSON.stringify(world.session)) }), ...race.scenario },
    ops: race.ops,
    host,
    result: maskJobs({ replies, calls, notices: world.notices, finals }, jobs),
  });
}
write('races.json', races);


// FINALIZE
const manifest = JSON.parse(readFileSync(join(stage, 'MANIFEST.json'), 'utf8'));
refreshSetManifest(stage, nodeRoot, 'HEAD', {
  exclusions: {
    ...manifest.exclusions,
    'flows/spawn.json "staleNotifyCalls" (the stale-context scenario)': 'the context Node is handed carries a routing session id (routingSessionId) and a notify callback (notifyFn) that the core\'s SpawnContext has no field for: neither input exists on the Rust side. The number of calls Node\'s callback got (recorded 0) is compared with the notices the replay delivered to the stale session id it passes in the context\'s session id (sessionId, which Node ignores while a caller session id is set); the completion reaching the caller alone is compared through the notices, whole',
  },
});
commitStage(stage, here);
console.log('flows recorded');
process.exit(0);
