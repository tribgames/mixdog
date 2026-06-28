#!/usr/bin/env node
// Focused parallelism smoke for the agent spawn fanout.
//
// Goals validated here (no network, fake askSession):
//   1. A batch of independent spawns fired together each return a task_id
//      *immediately* (sync return is fast and never blocks on prep/model).
//   2. The fanout returns all task_ids well before any single agent's work
//      finishes — i.e. spawn returns are non-blocking.
//   3. ensureProvider() is collapsed: N same-provider spawns trigger at most
//      one initProviders() pass (shared in-flight + already-registered guard).
//   3b. A provider CONFIG CHANGE still re-runs initProviders() (the de-dup is
//      keyed on provider + effective-config signature, not on "is registered"),
//      while an unchanged config is skipped.
//   4. A wedged prep step trips the independent spawn-prep cap even when the
//      first-response watchdog is explicitly disabled (firstResponseTimeoutMs:0).
//   5. spawnPrepTimeoutMs:0 disables the prep cap even when an env default cap
//      is set (explicit per-call override beats the env default).
//
// Run: node scripts/agent-parallel-smoke.mjs
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  closeSession,
  getSession,
  getSessionLastProgressAt,
  getSessionRuntime,
  enqueuePendingMessage,
  listSessions,
} from '../src/runtime/agent/orchestrator/session/manager.mjs';
import {
  getProvider as realGetProvider,
  initProviders as realInitProviders,
} from '../src/runtime/agent/orchestrator/providers/registry.mjs';

// Trace flush is irrelevant here and must never hold the loop open.
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
// Set a real env prep-cap BEFORE importing agent-tool.mjs so its module-load
// `DEFAULT_SPAWN_PREP_TIMEOUT_MS` actually captures this value — that is what
// makes the "spawnPrepTimeoutMs:0 disables prep even with an env default"
// assertion below genuine. Kept large enough that normal (fast) prep never
// trips it, but small enough that a deliberately slow 200ms prep would.
const ENV_PREP_CAP_MS = 150;
process.env.MIXDOG_AGENT_SPAWN_PREP_TIMEOUT_MS = String(ENV_PREP_CAP_MS);
// Dynamic import AFTER the env is set (static imports hoist and would capture
// the default before this line runs).
const { createStandaloneAgent } = await import('../src/standalone/agent-tool.mjs');

const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-parallel-'));
const dataDir = join(root, '.mixdog-data');
mkdirSync(dataDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function taskId(text) { return String(text).match(/agent task: (\S+)/)?.[1] || null; }

// Wrap the REAL registry so createSession()'s internal getProvider() resolves a
// genuine provider instance, while we still count initProviders() passes and can
// simulate "not yet registered" to exercise ensureProvider's collapse path.
let initProvidersCalls = 0;
let forceProviderMiss = false;
const reg = {
  getProvider(name) { return forceProviderMiss ? undefined : realGetProvider(name); },
  async initProviders(config) {
    initProvidersCalls += 1;
    await sleep(5); // simulate a small async cost
    return realInitProviders(config);
  },
};

// Mutable provider config so a regression test can change it and assert the
// signature-keyed ensureProvider() re-runs initProviders().
let providerConfig = { 'openai-oauth': { enabled: true } };
const cfgMod = {
  loadConfig() {
    return {
      providers: providerConfig,
      agents: {
        worker: { provider: 'openai-oauth', model: 'gpt-5.5', effort: 'low', fast: true },
        reviewer: { provider: 'openai-oauth', model: 'gpt-5.5', effort: 'low' },
        debugger: { provider: 'openai-oauth', model: 'gpt-5.5', effort: 'low' },
      },
      presets: [
        { id: 'fake-worker', name: 'Fake Worker', provider: 'openai-oauth', model: 'gpt-5.5', tools: 'full', effort: 'low', fast: true },
      ],
    };
  },
  resolveRuntimeSpec(preset, ctx) {
    return { lane: 'agent', scopeKey: `parallel:${ctx.agentId}`, provider: preset.provider, model: preset.model };
  },
};

const askStartedAt = [];
let askConcurrency = 0;
let maxAskConcurrency = 0;
async function fakeAskSession(sessionId, prompt) {
  const session = getSession(sessionId);
  if (session) { session.status = 'running'; session.lastStreamDeltaAt = Date.now(); }
  askStartedAt.push(Date.now());
  askConcurrency += 1;
  maxAskConcurrency = Math.max(maxAskConcurrency, askConcurrency);
  try {
    await sleep(300); // each agent's "work" lasts noticeably longer than spawn return
    return { content: `ack ${session?.role || 'worker'}` };
  } finally {
    askConcurrency -= 1;
    if (session) { session.status = 'idle'; session.lastStreamDeltaAt = Date.now(); }
  }
}

const mgr = {
  getSession,
  listSessions,
  closeSession,
  getSessionRuntime,
  enqueuePendingMessage,
  getSessionLastProgressAt,
  askSession: fakeAskSession,
};

const agent = createStandaloneAgent({ cfgMod, reg, mgr, dataDir, cwd: root });

async function waitJob(out, pattern, label, tries = 60) {
  const id = taskId(out);
  assert(id, `missing task ID for ${label}: ${out}`);
  let last = '';
  for (let i = 0; i < tries; i += 1) {
    last = await agent.execute({ type: 'read', task_id: id }, { invocationSource: 'model-tool', cwd: root });
    if (pattern.test(last)) return last;
    if (/status: error/.test(last)) return last;
    await sleep(50);
  }
  throw new Error(`${label} did not finish with ${pattern}: ${last}`);
}

async function main() {
  // Register the real provider once so createSession() can resolve it.
  await realInitProviders({ 'openai-oauth': { enabled: true } });

  // --- 1+2: parallel spawns return task_ids fast and non-blocking ---
  const batchSize = 6;
  const t0 = Date.now();
  const outs = await Promise.all(
    Array.from({ length: batchSize }, (_, i) => agent.execute({
      type: 'spawn',
      role: i % 2 === 0 ? 'worker' : 'reviewer',
      tag: `par${i}`,
      cwd: root,
      prompt: `parallel task ${i}`,
    }, { invocationSource: 'model-tool', cwd: root })),
  );
  const spawnReturnMs = Date.now() - t0;
  assert(outs.every((o) => /agent task:/.test(o)), `all spawns must return task ids: ${outs.join('\n---\n')}`);
  assert(outs.every((o) => /status: running/.test(o)), 'spawns must report running immediately');
  // The whole batch must return long before any single agent finishes (300ms each).
  assert(spawnReturnMs < 250, `parallel spawn return too slow (${spawnReturnMs}ms) — fanout is blocking`);

  // Wait for all to finish; they must have overlapped.
  await Promise.all(outs.map((o, i) => waitJob(o, /ack (worker|reviewer)/, `parallel ${i}`)));
  assert(maxAskConcurrency >= 2, `agents did not overlap; maxAskConcurrency=${maxAskConcurrency}`);

  // --- 3: provider init collapsed across the first fanout ---
  // ensureProvider has no completed-skip entry yet (first run this process), so
  // the batch DOES init once — but the in-flight collapse must keep it to a
  // SINGLE initProviders() pass across all 6 spawns, not one per spawn.
  assert(initProvidersCalls === 1, `first fanout must share a single init; calls=${initProvidersCalls}`);

  // Force getProvider() to report a miss across a parallel batch so the
  // completed-skip cannot short-circuit; every spawn routes through the init
  // path again, but the in-flight collapse must still produce exactly ONE more
  // init for the batch (before+1).
  forceProviderMiss = true;
  const beforeMissBatch = initProvidersCalls;
  const initBatch = await Promise.all(
    Array.from({ length: 4 }, (_, i) => agent.execute({
      type: 'spawn',
      role: 'worker',
      tag: `init${i}`,
      cwd: root,
      prompt: `init task ${i}`,
    }, { invocationSource: 'model-tool', cwd: root })),
  );
  await Promise.all(initBatch.map((o, i) => waitJob(o, /ack worker/, `init ${i}`)));
  assert(initProvidersCalls === beforeMissBatch + 1,
    `forced-miss fanout must share a single init; before=${beforeMissBatch} after=${initProvidersCalls}`);
  forceProviderMiss = false;

  // --- 3b: provider CONFIG CHANGE must re-run initProviders() ---
  // The completed-skip cache is keyed on provider + effective-config signature,
  // not on "is the provider registered". The provider stays registered here, so
  // a registered-only fast path would WRONGLY skip init after a config edit.
  // Changing the config must flip the signature and force exactly one new init.
  const callsBeforeChange = initProvidersCalls;
  // Same config first: must be skipped (no new init).
  await waitJob(await agent.execute({
    type: 'spawn', role: 'worker', tag: 'cfgSame', cwd: root, prompt: 'cfg same',
  }, { invocationSource: 'model-tool', cwd: root }), /ack worker/, 'cfg same');
  assert(initProvidersCalls === callsBeforeChange,
    `unchanged config must not re-init; before=${callsBeforeChange} after=${initProvidersCalls}`);
  // Now mutate the provider config and spawn again → must re-init once.
  providerConfig = { 'openai-oauth': { enabled: true, baseUrl: 'https://changed.example' } };
  await waitJob(await agent.execute({
    type: 'spawn', role: 'worker', tag: 'cfgChanged', cwd: root, prompt: 'cfg changed',
  }, { invocationSource: 'model-tool', cwd: root }), /ack worker/, 'cfg changed');
  assert(initProvidersCalls === callsBeforeChange + 1,
    `config change must trigger exactly one re-init; before=${callsBeforeChange} after=${initProvidersCalls}`);

  // --- 3c: stale (slow OLD-config) init must NOT overwrite a newer config ---
  // A(old) init is SLOW; before it finishes, B(new) is requested. The per-
  // provider serialize + latest-generation guard must ensure the registry ends
  // on B(new) and the stale A(old) init never lands last.
  const raceRoot = mkdtempSync(join(tmpdir(), 'mixdog-agent-race-'));
  const raceDataDir = join(raceRoot, '.mixdog-data');
  mkdirSync(raceDataDir, { recursive: true });
  let lastAppliedConfig = null;
  const raceReg = {
    getProvider() { return undefined; }, // always force the init path
    async initProviders(config) {
      const url = config?.['openai-oauth']?.baseUrl || 'base';
      // OLD config is deliberately slow, NEW config is fast — without
      // serialization the slow OLD init would resolve last and clobber NEW.
      await sleep(url.includes('old') ? 200 : 20);
      lastAppliedConfig = url;
    },
  };
  let raceConfig = { providers: { 'openai-oauth': { enabled: true, baseUrl: 'old' } } };
  const raceCfgMod = {
    loadConfig() {
      return {
        providers: raceConfig.providers,
        agents: { worker: { provider: 'openai-oauth', model: 'gpt-5.5', effort: 'low' } },
        presets: [{ id: 'fake-worker', name: 'Fake Worker', provider: 'openai-oauth', model: 'gpt-5.5', tools: 'full', effort: 'low' }],
      };
    },
    resolveRuntimeSpec(preset, ctx) {
      return { lane: 'agent', scopeKey: `race:${ctx.agentId}`, provider: preset.provider, model: preset.model };
    },
  };
  const raceAgent = createStandaloneAgent({ cfgMod: raceCfgMod, reg: raceReg, mgr, dataDir: raceDataDir, cwd: raceRoot });
  // Fire OLD (slow) then immediately switch config to NEW (fast) and fire it.
  const oldOut = await raceAgent.execute({
    type: 'spawn', role: 'worker', tag: 'raceOld', cwd: raceRoot, prompt: 'race old',
  }, { invocationSource: 'model-tool', cwd: raceRoot });
  raceConfig = { providers: { 'openai-oauth': { enabled: true, baseUrl: 'new' } } };
  const newOut = await raceAgent.execute({
    type: 'spawn', role: 'worker', tag: 'raceNew', cwd: raceRoot, prompt: 'race new',
  }, { invocationSource: 'model-tool', cwd: raceRoot });
  await Promise.all([
    waitJob(oldOut, /ack worker/, 'race old'),
    waitJob(newOut, /ack worker/, 'race new'),
  ]);
  // Give any (incorrectly) un-serialized slow OLD init time to land last.
  await sleep(250);
  assert(lastAppliedConfig === 'new',
    `stale slow init overwrote newer config; lastApplied=${lastAppliedConfig}`);
  raceAgent.closeAll('agent-parallel-smoke-race-end');
  rmSync(raceRoot, { recursive: true, force: true });

  // --- 4: spawn-prep cap fires even with firstResponseTimeoutMs:0 ---
  // Dedicated agent whose provider init hangs forever, so prep can never
  // resolve. The model watchdog is disabled (firstResponseTimeoutMs:0) but the
  // independent prep cap must still abort the job so a single hung prep cannot
  // wedge the whole fanout.
  const hangRoot = mkdtempSync(join(tmpdir(), 'mixdog-agent-hang-'));
  const hangDataDir = join(hangRoot, '.mixdog-data');
  mkdirSync(hangDataDir, { recursive: true });
  const hangReg = {
    getProvider() { return undefined; },           // never registered → init runs
    initProviders() { return new Promise(() => {}); }, // hangs forever
  };
  const hangAgent = createStandaloneAgent({ cfgMod, reg: hangReg, mgr, dataDir: hangDataDir, cwd: hangRoot });
  const wedgeStart = Date.now();
  const wedged = await hangAgent.execute({
    type: 'spawn',
    role: 'worker',
    tag: 'wedge1',
    cwd: hangRoot,
    prompt: 'wedge prep',
    firstResponseTimeoutMs: 0,   // model watchdog disabled
    spawnPrepTimeoutMs: 150,     // but prep cap is short
  }, { invocationSource: 'model-tool', cwd: hangRoot });
  assert(/agent task:/.test(wedged), 'wedge spawn should still return a task id immediately');
  // Spawn return itself must be immediate even though prep will hang.
  assert(Date.now() - wedgeStart < 100, 'wedge spawn return must not block on hung prep');
  const wedgeResult = await waitJob(wedged, /status: error|timed out/, 'wedge prep cap', 40);
  assert(/timed out/.test(wedgeResult) || /status: error/.test(wedgeResult),
    `prep cap did not abort hung spawn: ${wedgeResult}`);
  try { hangAgent.closeAll('agent-parallel-smoke-hang-end'); } catch {}
  rmSync(hangRoot, { recursive: true, force: true });

  // --- 5: spawnPrepTimeoutMs:0 disables the prep cap even when an env default
  // is set. The module captured ENV_PREP_CAP_MS (150ms) at load. A prep step
  // that runs longer than that (300ms) would normally be aborted by the env
  // cap, but the explicit per-call spawnPrepTimeoutMs:0 must win and let prep
  // finish.
  const slowRoot = mkdtempSync(join(tmpdir(), 'mixdog-agent-slowprep-'));
  const slowDataDir = join(slowRoot, '.mixdog-data');
  mkdirSync(slowDataDir, { recursive: true });
  let slowInitDone = false;
  const slowReg = {
    getProvider() { return undefined; }, // force init path
    async initProviders(config) {
      await sleep(300); // longer than the 150ms env cap
      slowInitDone = true;
      return realInitProviders({ 'openai-oauth': { enabled: true }, ...config });
    },
  };
  const slowAgent = createStandaloneAgent({ cfgMod, reg: slowReg, mgr, dataDir: slowDataDir, cwd: slowRoot });
  const slowStart = Date.now();
  const slowOut = await slowAgent.execute({
    type: 'spawn',
    role: 'worker',
    tag: 'slowprep1',
    cwd: slowRoot,
    prompt: 'slow prep override',
    spawnPrepTimeoutMs: 0, // explicit disable beats the env cap
  }, { invocationSource: 'model-tool', cwd: slowRoot });
  const slowResult = await waitJob(slowOut, /ack worker/, 'slow prep override', 40);
  assert(/ack worker/.test(slowResult),
    `spawnPrepTimeoutMs:0 must disable prep cap despite env default; got ${slowResult}`);
  assert(slowInitDone, 'slow prep init should have completed, not been aborted by env cap');
  assert(Date.now() - slowStart >= 280,
    'slow prep should have run its full duration (cap was disabled), not been cut short');
  try { slowAgent.closeAll('agent-parallel-smoke-slowprep-end'); } catch {}
  rmSync(slowRoot, { recursive: true, force: true });

  process.stdout.write(`agent parallel smoke passed (spawnReturn=${spawnReturnMs}ms, maxConcurrency=${maxAskConcurrency}, initCalls=${initProvidersCalls})\n`);
}

try {
  await main();
} finally {
  try { agent.closeAll('agent-parallel-smoke-end'); } catch {}
  rmSync(root, { recursive: true, force: true });
}
