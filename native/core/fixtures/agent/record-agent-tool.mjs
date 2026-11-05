// Records the goldens of the agent tool's request dispatch (agent-tool/execute.mjs with the
// real spawn/send dispatch, tag resume and close flow) against a scripted world.
//
//   node native/core/fixtures/agent/record-agent-tool.mjs --tree <node checkout with node_modules>
//
// The collaborators the Rust port reaches through traits (registry, send/spawn flows, views,
// session manager, catalog, terminal trace) are fakes that answer from `world` and log every
// effect and flow call; the background-task table is the real one. Each scenario's trace (the
// effect calls in order) and rendered result land in `agent_tool/cases.json`, which
// `tests/agent_tool.rs` replays on the Rust runtime over the same world.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitStage, parseArgs, refreshSetManifest, resolveTree, stageSet } from '../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
const stage = stageSet(here, ['agent_tool']);
process.env.MIXDOG_DATA_DIR = join(stage, '.data-unused');
const load = (rel) => import(pathToFileURL(join(nodeRoot, rel)).href);
const { createAgentExecute } = await load('src/session-runtime/services/agent-tool/execute.mjs');
const { createCloseFlow } = await load('src/session-runtime/services/agent-tool/close-flow.mjs');
const { callerSessionForContext, terminalPidForContext, rowMatchesContext } = await load(
  'src/session-runtime/services/agent-tool/helpers.mjs'
);
const tasksModule = await load('src/runtime/shared/background-tasks.mjs');

const CTX = { callerSessionId: 'lead1', clientHostPid: 4242, cwd: '/work' };
const OWNED = { parentSessionId: 'lead1' };
const live = (id, agent = 'worker', cwd = '/work') => ({ id, agent, cwd, ...OWNED });

const scenarios = [
  { name: 'unknown_type', args: { type: 'frobnicate' } },
  {
    name: 'list_roster',
    args: { type: 'list', tag: 'al' },
    world: {
      workers: [
        { tag: 'alpha', status: 'running', active: true, stage: 'tool_running' },
        { tag: 'beta', status: 'idle', active: false },
      ],
      jobs: [
        { task_id: 't1', type: 'spawn', status: 'running', tag: 'alpha', finished: false },
        { task_id: 't2', type: 'spawn', status: 'completed', tag: 'beta', finished: true },
      ],
    },
  },
  {
    name: 'status_with_target',
    args: { type: 'status', tag: 'alpha' },
    world: { job: { taskId: 't9', sessionId: 's9', view: { task_id: 't9', status: 'completed', type: 'spawn', tag: 'alpha', sessionId: 's9', result: '<final-answer>done</final-answer>' } } },
  },
  {
    name: 'status_without_target_is_the_roster',
    args: { type: 'status' },
    world: { workers: [], jobs: [] },
  },
  {
    name: 'read_worker_without_task_uses_handoff',
    args: { type: 'read', tag: 'alpha' },
    world: { job: { taskId: null, sessionId: 's9', view: { task_id: 'w9', status: 'idle', type: 'spawn', tag: 'alpha', sessionId: 's9' } }, handoff: 'the handoff' },
  },
  {
    name: 'read_with_task_ignores_handoff',
    args: { type: 'read', task_id: 't9' },
    world: { job: { taskId: 't9', sessionId: 's9', view: { task_id: 't9', status: 'running', type: 'spawn' } }, handoff: 'ignored' },
  },
  { name: 'cleanup', args: { type: 'cleanup' }, world: { tags: { a: 's1', b: 's2' }, jobs: [{ task_id: 't1', status: 'running' }], workers: [{ tag: 'a' }] } },
  {
    name: 'close_live_session_forgets_row_and_descendants',
    args: { type: 'close', tag: 'w1' },
    world: { tags: { w1: 's1' }, tagAgents: ['w1'], live: { s1: live('s1') }, descendants: { s1: ['d1', 'd2'] }, closeOk: true },
  },
  {
    name: 'close_that_fails_keeps_the_row',
    args: { type: 'cancel', sessionId: 's1' },
    world: { tags: { w1: 's1' }, live: { s1: live('s1') }, closeOk: false },
  },
  { name: 'close_unknown_target', args: { type: 'close', tag: 'ghost' }, world: {} },
  { name: 'close_without_target', args: { type: 'close' }, world: {} },
  {
    name: 'close_lead_session_is_refused',
    args: { type: 'close', tag: 'boss' },
    world: { tags: { boss: 's0' }, live: { s0: live('s0', 'Lead') } },
  },
  {
    name: 'close_stale_local_tag_is_forgotten',
    args: { type: 'close', tag: 'old' },
    world: { tags: { old: 'gone' }, tagAgents: ['old'], rows: [{ tag: 'old', sessionId: 'gone', agent: 'worker', cwd: '/work', ...OWNED }], unresolvable: ['old'] },
  },
  {
    name: 'close_by_task_id_only',
    args: { type: 'close', task_id: 'task-A' },
    world: { tasks: [{ task_id: 'task-A', sessionId: null, tag: 'tagA' }] },
  },
  {
    name: 'close_cancels_the_sessions_tasks',
    args: { type: 'close', tag: 'w1', task_id: 'task-B' },
    world: {
      tags: { w1: 's1' },
      live: { s1: live('s1') },
      closeOk: true,
      tasks: [
        { task_id: 'task-B', sessionId: 's1', tag: 'w1' },
        { task_id: 'task-C', sessionId: 's1', tag: null },
        { task_id: 'task-D', sessionId: 'other', tag: 'zzz' },
      ],
    },
  },
  { name: 'send_to_live_tag', args: { type: 'send', tag: 'w1', message: 'go' }, world: { prepare: [{ ok: { sessionId: 's1', agent: 'worker', cwd: '/work' } }] } },
  {
    name: 'send_explicit_session_that_is_gone_errors',
    args: { type: 'send', tag: 'sess_abc', message: 'go' },
    world: { prepare: [{ err: 'agent send: target "sess_abc" not found' }] },
  },
  {
    name: 'send_other_failure_is_not_a_dead_target',
    args: { type: 'send', tag: 'w1', message: 'go' },
    world: { prepare: [{ err: 'agent send: queue is full' }] },
  },
  {
    name: 'send_dead_tag_with_no_evidence_errors',
    args: { type: 'send', tag: 'w1', message: 'go' },
    world: { prepare: [{ err: 'agent send: target "w1" not found' }, { err: 'agent send: target "w1" not found' }] },
  },
  {
    name: 'send_dead_tag_resumes_the_reaped_session',
    args: { type: 'send', tag: 'w1', message: 'continue' },
    world: {
      prepare: [{ err: 'agent send: target "w1" not found' }, { err: 'agent send: target "w1" is closed' }],
      tombstones: [{ tag: 'w1', sessionId: 's1', agent: 'worker', cwd: '/work', ...OWNED }],
      resumable: { 'w1|s1': { session: { id: 's1', agent: 'worker', cwd: '/work' } } },
    },
  },
  {
    name: 'send_dead_tag_respawns_when_the_session_cannot_continue',
    args: { type: 'send', tag: 'w1', message: 'continue', agent: 'reviewer' },
    world: {
      prepare: [{ err: 'agent send: target "w1" not found' }, { err: 'agent send: target "w1" not found' }],
      rows: [{ tag: 'w1', sessionId: 's1', agent: 'worker', cwd: '/work', ...OWNED }],
      resumable: { 'w1|s1': null },
    },
  },
  {
    name: 'send_dead_tag_revived_by_a_competing_resume',
    args: { type: 'send', tag: 'w1', message: 'go' },
    world: {
      prepare: [{ err: 'agent send: target "w1" not found' }, { ok: { sessionId: 's1', agent: 'worker', cwd: '/work' } }],
    },
  },
  {
    name: 'send_dead_tag_resume_gone_cwd_is_refused',
    args: { type: 'send', tag: 'w1', message: 'go' },
    world: {
      prepare: [{ err: 'agent send: target "w1" not found' }, { err: 'agent send: target "w1" not found' }],
      tombstones: [{ tag: 'w1', sessionId: 's1', agent: 'worker', cwd: '/work', ...OWNED }],
      resumable: { 'w1|s1': { session: null, missingCwd: '/gone/dir' } },
    },
  },
  {
    name: 'send_dead_tag_other_agent_gets_a_fresh_session',
    args: { type: 'send', tag: 'w1', message: 'go', agent: 'reviewer' },
    world: {
      prepare: [{ err: 'agent send: target "w1" not found' }, { err: 'agent send: target "w1" not found' }],
      tombstones: [{ tag: 'w1', sessionId: 's1', agent: 'worker', cwd: '/work', ...OWNED }],
      resumable: { 'w1|s1': { session: { id: 's1', agent: 'worker', cwd: '/work' } } },
    },
  },
  { name: 'spawn_without_a_tag', args: { prompt: 'do it', agent: 'worker' }, world: {} },
  { name: 'spawn_model_without_provider_on_a_headless_surface', args: { prompt: 'x', model: 'gpt-5' }, world: {} },
  { name: 'spawn_provider_without_model', args: { prompt: 'x', provider: 'openai' }, world: {} },
  { name: 'spawn_punctuation_model_is_not_found', args: { prompt: 'x', model: '???', provider: 'openai' }, world: {} },
  { name: 'spawn_exact_provider_and_model_pass_through', args: { prompt: 'x', model: 'gpt-5', provider: 'openai' }, world: {} },
  {
    name: 'spawn_model_resolves_through_the_catalog',
    args: { prompt: 'x', model: 'sonnet 4', provider: 'anth' },
    world: {
      catalog: [
        { provider: 'anthropic', id: 'claude-sonnet-4', display: 'Claude Sonnet 4', catalogComplete: true },
        { provider: 'anthropic', id: 'claude-opus-4', display: 'Claude Opus 4', catalogComplete: true },
        { provider: 'openai', id: 'gpt-5', display: 'GPT 5', catalogComplete: true },
      ],
    },
  },
  {
    name: 'spawn_model_ambiguous',
    args: { prompt: 'x', model: 'claude' },
    world: {
      catalog: [
        { provider: 'anthropic', id: 'claude-sonnet-4', display: 'Claude Sonnet 4', catalogComplete: true },
        { provider: 'anthropic', id: 'claude-opus-4', display: 'Claude Opus 4', catalogComplete: true },
      ],
    },
  },
  {
    name: 'spawn_model_not_found_lists_the_provider',
    args: { prompt: 'x', model: 'llama', provider: 'openai' },
    world: { catalog: [{ provider: 'openai', id: 'gpt-5', display: 'GPT 5', catalogComplete: true }] },
  },
  {
    name: 'spawn_provider_with_no_models',
    args: { prompt: 'x', model: 'llama', provider: 'nowhere' },
    world: { catalog: [] },
  },
  {
    name: 'spawn_tag_on_a_live_session_reuses_it',
    args: { prompt: 'again', tag: 'w1', model: 'gpt-5', provider: 'openai', effort: 'high', fast: true },
    world: {
      tags: { w1: 's1' },
      live: { s1: live('s1') },
      prepare: [{ ok: { sessionId: 's1', agent: 'worker', cwd: '/work' } }],
    },
  },
  {
    name: 'spawn_tag_with_a_terminal_trace_reaps_it',
    args: { prompt: 'x', tag: 'w1' },
    world: { traces: ['w1'] },
  },
  {
    name: 'spawn_tag_resumes_from_its_tombstone',
    args: { prompt: 'continue', tag: 'w1' },
    world: {
      tombstones: [{ tag: 'w1', sessionId: 's1', agent: 'worker', cwd: '/work', ...OWNED }],
      resumable: { 'w1|s1': { session: { id: 's1', agent: 'worker', cwd: '/work' } } },
    },
  },
  {
    name: 'spawn_tag_tombstone_that_cannot_resume_inherits_agent_and_cwd',
    args: { prompt: 'x', tag: 'w1' },
    world: {
      tombstones: [{ tag: 'w1', sessionId: 's1', agent: 'worker', cwd: '/old', ...OWNED }],
      resumable: { 'w1|s1': null },
    },
  },
  {
    name: 'spawn_tag_foreign_tombstone_is_refused',
    args: { prompt: 'x', tag: 'w1' },
    world: { foreignTombstones: [{ tag: 'w1', sessionId: 's7', agent: 'worker', cwd: '/work', parentSessionId: 'other' }] },
  },
  {
    name: 'spawn_tag_resumes_its_last_session_record',
    args: { prompt: 'continue', tag: 'w1' },
    world: {
      lastSessions: { w1: { tag: 'w1', sessionId: 's5', agent: 'worker', cwd: '/work', ...OWNED } },
      resumable: { 'w1|s5': { session: { id: 's5', agent: 'worker', cwd: '/work' } } },
    },
  },
  { name: 'spawn_new_tag_is_fresh', args: { prompt: 'x', tag: 'brand-new' }, world: {} },
  {
    name: 'spawn_ambiguous_tag_falls_through_to_a_fresh_spawn',
    args: { prompt: 'x', tag: 'dup' },
    world: { ambiguous: ['dup'] },
  },
];

const scopeKey = (ctx) => ({ s: callerSessionForContext(ctx), p: terminalPidForContext(ctx) });
const jsonable = (v) => JSON.parse(JSON.stringify(v ?? null));

async function runScenario(scenario) {
  const world = structuredClone(scenario.world || {});
  const trace = [];
  let finished = false;
  const log = (...entry) => {
    if (!finished) trace.push(jsonable(entry));
  };
  const tags = new Map(Object.entries(world.tags || {}));
  const tagAgents = new Map((world.tagAgents || []).map((t) => [t, 'worker']));
  const liveSession = (id) => (id && world.live?.[id] ? world.live[id] : null);
  const prepareScript = [...(world.prepare || [])];

  const mgr = {
    rehydrateAgentSessions: async () => log('rehydrate'),
    readSessionHandoff: async () => world.handoff ?? null,
    closeSession: async (id, reason, opts) => {
      log('closeSession', id, reason, opts);
      return world.closeOk === true;
    },
    descendantSessionIds: (id) => world.descendants?.[id] || [],
  };
  const registry = {
    resolveTombstoneOwners: () => log('resolveTombstoneOwners'),
    refreshTagsFromSessions: ({ scanSessions, context }) => log('refreshTags', scanSessions, scopeKey(context)),
    wantsSessionScan: (args = {}) => args.recover === true || args.scanSessions === true || args.scan_sessions === true,
    resolveTag: (tag, context, opts = {}) => {
      log('resolveTag', tag, scopeKey(context), { scan: opts.scanSessions === true, traces: opts.excludeTerminalTraces === true });
      if (world.ambiguous?.includes(tag)) throw new Error(`agent: tag "${tag}" is ambiguous across terminals`);
      if (world.unresolvable?.includes(tag)) return null;
      return tags.get(tag) || (liveSession(tag) ? tag : null);
    },
    getLiveSession: (id) => liveSession(id),
    tags,
    tagAgents,
    tagForSession: (id) => [...tags.entries()].find(([, sid]) => sid === id)?.[0] ?? null,
    unbindTag: (tag) => {
      log('unbindTag', tag);
      tags.delete(tag);
      tagAgents.delete(tag);
    },
    bindTag: (tag, session) => log('bindTag', tag, session.id),
    forgetTerminalSession: (tag, sessionId) => log('forgetTerminalSession', tag, sessionId),
    removeWorkerRow: (row) => log('removeWorkerRow', row.sessionId),
    markReleased: (ids) => log('markReleased', ids),
    readWorkerRows: (context) => (world.rows || []).filter((row) => rowMatchesContext(row, context)),
    readAllTagTombstones: () => [...(world.tombstones || []), ...(world.foreignTombstones || [])],
    tagTombstoneForTag: (tag, context) =>
      (world.tombstones || []).find((row) => row.tag === tag && rowMatchesContext(row, context)) || null,
    consumeTagTombstone: (row) => log('consumeTagTombstone', row.tag, row.sessionId),
    lastTagSession: (tag, context) => {
      const row = world.lastSessions?.[tag];
      return row && rowMatchesContext(row, context) ? { id: row.sessionId, agent: row.agent, cwd: row.cwd } : null;
    },
    resumableTagSession: async (tag, sessionId, context) => {
      log('resumableTagSession', tag, sessionId, scopeKey(context));
      const found = world.resumable?.[`${tag}|${sessionId}`];
      if (found === undefined || found === null) return null;
      return { session: found.session ? { ...found.session, ...OWNED } : null, missingCwd: found.missingCwd };
    },
  };
  const envelope = (job) => {
    if (job.view) return { ...job.view, ...(job.result !== undefined ? { result: job.result } : {}) };
    return { task_id: job.taskId, status: 'running', type: 'spawn', ...(job.respawned ? { respawned: true } : {}) };
  };
  const views = {
    getJobOrWorker: () => structuredClone(world.job),
    renderJob: (job) => envelope(job),
    list: () => world.workers || [],
    listJobs: () => world.jobs || [],
  };
  const sendFlow = {
    prepareSend: async (args, context) => {
      const step = prepareScript.shift() || { ok: { sessionId: 'sess_default', agent: 'worker', cwd: '/work' } };
      log('prepareSend', args, scopeKey(context));
      if (step.err) throw new Error(step.err);
      return { args, sessionId: step.ok.sessionId, session: { id: step.ok.sessionId, agent: step.ok.agent, cwd: step.ok.cwd }, prompt: null };
    },
    adoptCaller: async (prepared) => log('adoptCaller', prepared.sessionId),
    dispatchToExistingSession: (prepared, _ctx, opts = {}) => {
      log('dispatch', { args: prepared.args, sessionId: prepared.sessionId, prompt: prepared.prompt ?? null, route: prepared.route ?? null }, { reused: opts.reused === true, resumed: opts.resumed === true });
      return `dispatched ${prepared.sessionId}`;
    },
  };
  let jobs = 0;
  const spawnFlow = {
    startDeferredSpawnJob: (args, callerCwd, _ctx, _notify, opts = {}) => {
      jobs += 1;
      log('startSpawn', args, callerCwd, { respawned: opts.respawned === true });
      return { taskId: `job-${jobs}`, respawned: opts.respawned === true };
    },
  };
  const terminalTrace = {
    hasTerminalTrace: (tag) => (world.traces || []).includes(tag),
    reapTerminalTraceForTag: (tag) => log('reapTrace', tag),
  };
  const listProviderModels = world.catalog
    ? async (opts = {}) => {
        log('listModels', { quick: opts.quick === true, force: opts.force === true, provider: opts.provider ?? null });
        return structuredClone(world.catalog);
      }
    : null;
  const closeFlow = createCloseFlow({ mgr, registry, views });
  const execute = createAgentExecute({
    mgr,
    defaultCwd: '/work',
    awaitKeychainPrewarm: async () => {},
    registry,
    views,
    spawnFlow,
    sendFlow,
    closeFlow,
    terminalTrace,
    listProviderModels,
  });

  const registered = [];
  for (const task of world.tasks || []) {
    registered.push(
      tasksModule.registerBackgroundTask({
        taskId: task.task_id,
        surface: 'agent',
        context: CTX,
        meta: { ...(task.sessionId ? { sessionId: task.sessionId } : {}), ...(task.tag ? { tag: task.tag } : {}) },
        cancel: () => log('cancelTask', task.task_id),
      })
    );
  }
  const result = await execute(structuredClone(scenario.args), { ...CTX });
  finished = true;
  // The task table is process-wide: settle what this scenario left running.
  for (const task of registered) tasksModule.reconcileBackgroundTask(task.taskId, { status: 'cancelled' });
  return { trace, result };
}

const out = [];
for (const scenario of scenarios) {
  const { trace, result } = await runScenario(scenario);
  out.push({ name: scenario.name, args: scenario.args, context: CTX, world: scenario.world || {}, trace, result });
}
const dir = join(stage, 'agent_tool');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'cases.json'), `${JSON.stringify(out, null, 2)}\n`);
refreshSetManifest(stage, nodeRoot);
commitStage(stage, here);
for (const c of out) console.log(c.name.padEnd(64), JSON.stringify(c.result).slice(0, 90));
process.exit(0);
