#!/usr/bin/env node
// Recording of the `session` tool's compact and fork actions (internal-tool-executor.test.mjs :218 compact, :238 fork) and of what
// the turn settle does with a scheduled compaction (turn/turn-run/turn-settle.test.mjs): the tool's answer, the pending set it
// leaves, whether the settle of a turn runs the compaction (only for the session that scheduled it, once), and what the fork
// asks the lifecycle for.
//
//   node benchmarks/rust-core/recorders/record-session-compact-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import-time sweeps act on user directories: every one is a fresh temp dir before any Mixdog module loads.
const sandbox = mkdtempSync(join(tmpdir(), 'session-compact-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const { openSet } = await import('./lib/case-set.mjs');

const set = openSet('session-compact-cases', import.meta.url);
const { createInternalToolExecutor } = await set.load('src/session-runtime/internal-tool-executor.mjs');
const { createTurnSettlement } = await set.load('src/session-runtime/turn/turn-run/turn-settle.mjs');

function harness(overrides = {}) {
  const rt = { session: { id: 'sess-1', controller: new AbortController() }, mode: 'lead', currentCwd: 'C:/work', config: {} };
  const record = () => () => 'ok';
  const execute = createInternalToolExecutor({
    rt,
    channels: { isChannelTool: () => false, execute: record() },
    goalRuntime: { executeTool: record() },
    agentTool: { execute: record() },
    setupTool: { execute: record() },
    featureDisallowedTools: () => [],
    getWebSearchModule: async () => null,
    getMemoryModule: async () => null,
    getCodeGraphModule: async () => null,
    notifyFnForSession: () => record(),
    runNativeWebSearch: record(),
    activeToolSurface: () => ({ tools: [] }),
    mcpStatus: () => ({ servers: [] }),
    skillToolContent: record(),
    ...overrides,
  });
  return { execute, rt };
}

const pendingOf = (rt) => [...(rt.pendingCompactSessionIds ?? [])];

/** `settleTurn` of `turn.session0.id`, with `current` the live session: the sessions whose compaction it ran. */
async function settle({ settled, current, pending }) {
  const ran = [];
  let active = 1;
  const { settleTurn } = createTurnSettlement({
    refreshStatuslineUsageAfterTurn: () => {},
    getSession: () => ({ id: current }),
    setSession() {},
    mgr: {},
    transcript: {},
    hooks: { emit() {}, dispatch() {} },
    hookCommonPayload: (payload) => payload,
    endComputerExecution: async () => {},
    deferComputerSessionRelease() {},
    getActiveTurnCount: () => active,
    setActiveTurnCount: (value) => { active = value; },
    isFirstTurnCompleted: () => true,
    takePendingCompact: (id) => pending.delete(id),
    runPendingCompact: (id) => ran.push(id),
  });
  await settleTurn({ session0: { id: settled }, emitTiming() {}, armHeavyRuntimeWarmup() {}, snapshot: { finish: async () => {} }, timing: {} });
  return { ran, pending: [...pending] };
}

await set.run('compact schedules one compaction and asking again changes nothing', async () => {
  const { execute, rt } = harness();
  const first = await execute('session', { action: 'compact' }, {});
  const afterFirst = pendingOf(rt);
  const second = await execute('session', { action: 'compact' }, {});
  return { first, afterFirst, second, afterSecond: pendingOf(rt) };
});
await set.run('compact belongs to the Lead session', async () => {
  const { execute, rt } = harness();
  return await execute('session', { action: 'compact' }, { callerSessionId: 'w' }).catch((error) => ({ error: error.message, pending: pendingOf(rt) }));
});
await set.run('the settle of the scheduled session runs the compaction once', () => settle({ settled: 'A', current: 'A', pending: new Set(['A']) }));
await set.run('the settle of another session leaves the compaction pending', () => settle({ settled: 'A', current: 'B', pending: new Set(['A']) }));
await set.run('a settle with nothing scheduled runs nothing', () => settle({ settled: 'A', current: 'A', pending: new Set() }));
for (const compact of [false, undefined]) {
  await set.run(`fork asks the lifecycle with compact ${compact}`, async () => {
    const calls = [];
    const lifecycle = { inheritToNewSession: async (id, options) => (calls.push([id, options]), { sessionId: 'new-1', compacted: compact === true }) };
    const { execute } = harness({ getLifecycleApi: () => lifecycle });
    const out = await execute('session', { action: 'fork', ...(compact === undefined ? {} : { compact }) }, {});
    return { out, calls };
  });
}

// `fork` with `compact: true` through Node's own lifecycle: the real compaction of the copy, the provider answering the
// summary request, and the stored copy read back whole.
{
  const { loadSession, saveSessionAsync } = await set.load('src/runtime/agent/orchestrator/session/store.mjs');
  const manager = await set.load('src/runtime/agent/orchestrator/session/manager.mjs');
  const { _withRegisteredProviderForTestAsync } = await set.load('src/runtime/agent/orchestrator/providers/registry.mjs');
  const { createLifecycleApi } = await set.load('src/session-runtime/lifecycle-api.mjs');
  const { createWorkspaceToolHandlers } = await set.load('src/session-runtime/internal-tool-executor/workspace-tools.mjs');
  const { inheritanceCompactionPlan } = await set.load('src/session-runtime/inheritance-fit.mjs');
  await set.run('fork with compact true compacts the copy with the real compaction', async () => {
    const sessionId = 'sess_fork_compact_src';
    const messages = [{ role: 'system', content: 'system rules stay exact' }];
    for (let turn = 0; turn < 30; turn += 1) {
      messages.push({ role: 'user', content: `request ${turn} ${'context '.repeat(400)}` }, { role: 'assistant', content: `answer ${turn} ${'detail '.repeat(400)}` });
    }
    const source = { id: sessionId, title: 'Source', provider: 'anthropic', model: 'fake-model', owner: 'cli', sourceType: 'lead', contextWindow: 100_000, compactBoundaryTokens: 100_000, messages, tools: [], generation: 0, closed: false, compaction: { conversationThresholdTokens: 1 } };
    await saveSessionAsync(structuredClone(source));
    const summary = ['## Goal', '- keep the work', '## Progress', '- older turns summarized', '## Next Steps', '- continue'].join('\n');
    const requests = [];
    const provider = { name: 'anthropic', contextWindow: 128_000, send: async (...sent) => { requests.push(sent.length); return { content: summary }; } };
    const lifecycle = createLifecycleApi({ getSession: () => null, getRoute: () => ({ provider: 'anthropic', model: 'fake-model' }), mgr: manager, invalidateContextStatusCache() {}, saveSession() {} });
    const rt = { session: { id: sessionId, sourceType: 'lead' }, config: {} };
    const handler = createWorkspaceToolHandlers({ rt, getLifecycleApi: () => lifecycle, getSessionManager: () => null }).session;
    const out = await _withRegisteredProviderForTestAsync('anthropic', provider, () => handler({ action: 'fork', compact: true }, { callerCtx: { callerSessionId: sessionId }, callerCwd: '/p' }));
    const heirId = JSON.parse(out).sessionId;
    const heir = loadSession(heirId);
    const { messages: stored, title, titleLocked, titleSource, inheritedFromSessionId } = heir;
    return {
      source,
      summary,
      out: out.replace(heirId, '<heir>'),
      summaryRequests: requests.length,
      budgetTokens: inheritanceCompactionPlan(heir).budgetTokens,
      heir: { title, titleLocked, titleSource, inheritedFromSessionId, messages: stored },
    };
  });
}
await set.finish({
  entry: 'internal-tool-executor.mjs createInternalToolExecutor (the session tool, actions compact and fork, over a lifecycle stand-in that answers {sessionId: "new-1", compacted: false}; the fork with compact true through the real lifecycle and compaction, the provider answering the summary request); turn-settle.mjs createTurnSettlement.settleTurn with the pending-compact seams',
  replay: { entry: 'SessionTool::call over DirectorySessionPort (the tool answer of compact and fork, and the requests the port makes); the settle cases through the session actor: a thread whose compaction was scheduled compacts when its turn settles, once, and another thread\'s turn does not run it', normalised: {} },
  exclusions: { 'fork without a lifecycle API': 'Node answers "session: fork is unavailable in this runtime" when no lifecycle is installed; the core always has the thread requests, so no client can reach it' },
});
process.exit(0);
