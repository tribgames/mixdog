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
for (const compact of [true, false, undefined]) {
  await set.run(`fork asks the lifecycle with compact ${compact}`, async () => {
    const calls = [];
    const lifecycle = { inheritToNewSession: async (id, options) => (calls.push([id, options]), { sessionId: 'new-1', compacted: compact === true }) };
    const { execute } = harness({ getLifecycleApi: () => lifecycle });
    const out = await execute('session', { action: 'fork', ...(compact === undefined ? {} : { compact }) }, {});
    return { out, calls };
  });
}

await set.finish({
  entry: 'internal-tool-executor.mjs createInternalToolExecutor (the session tool, actions compact and fork, over a lifecycle stand-in that answers {sessionId: "new-1", compacted: compact === true}); turn-settle.mjs createTurnSettlement.settleTurn with the pending-compact seams',
  replay: { entry: 'SessionTool::call over DirectorySessionPort (the tool answer of compact and fork, and the requests the port makes); the settle cases through the session actor: a thread whose compaction was scheduled compacts when its turn settles, once, and another thread\'s turn does not run it', normalised: {} },
  exclusions: { 'fork without a lifecycle API': 'Node answers "session: fork is unavailable in this runtime" when no lifecycle is installed; the core always has the thread requests, so no client can reach it' },
});
process.exit(0);
