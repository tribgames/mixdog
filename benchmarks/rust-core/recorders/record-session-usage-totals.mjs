#!/usr/bin/env node
// Records `sessionUsageTotals(session)` (src/runtime/shared/session-usage-totals.mjs) for the session records of
// session-usage-totals.test.mjs:13 and the stored rows of :46/:83 (counted, legacy without counters).
//
//   node benchmarks/rust-core/recorders/record-session-usage-totals.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/session-usage-totals/golden.json (+ MANIFEST.json).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-session-usage-totals.mjs';
const { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const { sessionUsageTotals } = await importFrom(tree, 'src/runtime/shared/session-usage-totals.mjs');
const S = 'src/runtime/agent/orchestrator/session';
const { usageDeltaEvent } = await importFrom(tree, `${S}/loop/usage.mjs`);
const { applyAskTerminalUsageTotals } = await importFrom(tree, `${S}/manager/usage-metrics.mjs`);
const { providerInputExcludesCache } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/registry.mjs');
const rowsMod = await importFrom(tree, `${S}/store-agent-worker-rows.mjs`);
const poolProgress = await importFrom(tree, `${S}/agent-pool-progress.mjs`);
const runtimeState = await importFrom(tree, `${S}/manager/runtime-state.mjs`);
const { createAgentList } = await importFrom(tree, 'src/session-runtime/services/agent-tool/job-views/agent-list.mjs');
const { createSessionProgress, liveAgentStatusRow } = await importFrom(tree, 'src/session-runtime/services/agent-tool/job-views/session-progress.mjs');

// --- :32 tool calls accumulate per provider response, not recounted at turn end ---------------------------------
const NOW = 1_800_000_000_000;
Date.now = () => NOW;
const deltaUsage = { inputTokens: 10, outputTokens: 2 };
const deltas = [3, undefined].map((toolCalls) => ({
  toolCalls: toolCalls ?? null,
  event: JSON.parse(JSON.stringify(usageDeltaEvent({ sessionId: 's', iterationIndex: 1, requestedModel: 'm', model: 'm', usage: deltaUsage, sendTools: [], toolCalls }))),
}));
const terminalSession = { provider: 'openai', totalInputTokens: 0, totalOutputTokens: 0 };
const terminal = [false, true].map((incremental) => {
  const header = structuredClone(terminalSession);
  const result = { usage: deltaUsage, toolCallsTotal: 4 };
  applyAskTerminalUsageTotals(terminalSession, result, incremental ? { skipTotalsIfIncremental: true } : {});
  return { header, result, incremental, excludesCache: providerInputExcludesCache('openai'), now: NOW, after: JSON.parse(JSON.stringify(terminalSession)) };
});

// --- :46 the stored agent pool rows carry the session totals -----------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'mixdog-pool-usage-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));
const stamp = new Date(NOW).toISOString();
const headers = {
  'usage-child': JSON.stringify({ id: 'usage-child', owner: 'agent', agent: 'reviewer', createdAt: stamp, updatedAt: stamp, totalInputTokens: 900, totalOutputTokens: 100, totalToolCalls: 12 }),
  'usage-legacy': JSON.stringify({ id: 'usage-legacy', owner: 'agent', agent: 'reviewer', createdAt: stamp, updatedAt: stamp }),
};
for (const [id, text] of Object.entries(headers)) writeFileSync(join(root, 'sessions', `${id}.json`), text);
const agentIndex = JSON.stringify({
  workers: [
    { sessionId: 'usage-child', tag: 'a', agent: 'reviewer', status: 'completed', updatedAt: stamp },
    { sessionId: 'usage-legacy', tag: 'b', agent: 'reviewer', status: 'completed', updatedAt: stamp },
  ],
});
writeFileSync(join(root, 'agent-workers.json'), agentIndex);
const syncRows = JSON.parse(JSON.stringify(rowsMod.listStoredAgentWorkers()));
const listed = await rowsMod.listStoredAgentWorkersAsync({ runningSessionIds: () => new Set() });
// The daemon's chain over the listing (daemon-desktop-runtime.mjs), with nothing live.
const chained = poolProgress.withTurnProgress(
  poolProgress.withLedgerToken(poolProgress.withLiveUsage(poolProgress.withLiveTodo(listed, () => null), () => null), () => new Map()),
  () => undefined,
  runtimeState.isTurnInFlight,
  () => false,
);
const stored = { now: NOW, files: { agentIndex, leadIndex: null, headers }, syncRows, rows: JSON.parse(JSON.stringify(chained)) };
rmSync(root, { recursive: true, force: true });
delete process.env.MIXDOG_DATA_DIR;

// --- :83 the live agent list rows carry the in-memory session totals ---------------------------------------------
const liveSession = { id: 'live-1', agent: 'worker', status: 'running', stage: 'streaming', totalInputTokens: 40, totalOutputTokens: 2, totalToolCalls: 5 };
const mgr = { getSession: (id) => (id === 'live-1' ? liveSession : null), getSessionRuntime: () => null, getSessionProgressSnapshot: () => null, getSessionPendingMessageDepth: () => null, loadSessionStatus: () => liveSession.status };
const list = createAgentList({
  mgr,
  refreshTagsFromSessions: () => {},
  agentSessionEntries: () => [{ tag: 'w', session: liveSession, indexRow: null, loaded: true }],
  progress: createSessionProgress({ mgr }),
});
// The core lists live rows on the status pulse (`statusFor`: memoryOnly), whose role policy is held: the first read
// finds none and resolves it after the read, so both reads are recorded.
const pulse = () => JSON.parse(JSON.stringify(list({ memoryOnly: true }).map(liveAgentStatusRow)));
const firstPulse = pulse();
await new Promise((resolve) => setImmediate(resolve));
const live = { tag: 'w', session: liveSession, now: NOW, rows: JSON.parse(JSON.stringify(list().map(liveAgentStatusRow))), pulses: [firstPulse, pulse()] };

const sessions = [
  { totalInputTokens: 120, totalOutputTokens: 30, totalToolCalls: 7 },
  { totalInputTokens: 0, totalOutputTokens: 0, totalToolCalls: 0 },
  { totalInputTokens: 5, totalOutputTokens: 1 },
  null,
  {},
  { totalInputTokens: 'x', totalToolCalls: -1 },
  { totalInputTokens: 900, totalOutputTokens: 100, totalToolCalls: 12 },
  { totalInputTokens: 40, totalOutputTokens: 2, totalToolCalls: 5 },
];
const cases = sessions.map((session) => ({ session, totals: sessionUsageTotals(session) }));

const finalDir = join(FIXTURES_ROOT, 'session-usage-totals');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's session usage totals at ${NODE_COMMIT} over the cases of session-usage-totals.test.mjs`, cases, deltas, terminal, stored, live });
writeSetManifest(stage, {
  set: 'session-usage-totals',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    tests: ['src/runtime/shared/session-usage-totals.test.mjs (:13, :32, :46, :83)'],
    exclusions: {
      undefinedSession: 'the test also passes undefined; JSON has no undefined, and `session?.` reads it exactly as null, which is recorded',
      storedRows: ':46 calls listStoredAgentWorkers; the core lists through the async reader and the daemon chain (record-agent-pool.mjs), recorded with nothing live; the recorder records both and the replay checks the sync rows equal the async listing',
      liveProgress: ':83 stubs progress with {}; the recorder runs the real session progress over a manager holding no runtime, and the rows pass liveAgentStatusRow as the core publishes them; `pulses` are two status-pulse reads (memoryOnly) around the role policy resolving, the path the core lists live rows on',
      deltaSendTools: ':32 passes no sendTools; the loop always reports the request tools (the core event always carries the list), so the recorder passes an empty list',
      clock: 'Date.now is fixed at `now` so the stamps and the pane window are reproducible',
    },
  },
});
commitStage(stage, finalDir);
console.log(`cases=${cases.length}`);
