#!/usr/bin/env node
// What Node writes when its progress watchdog stops a turn, from both places that arm one, on real Node with its interval
// timers and clock mocked (node:test `mock.timers`: due time, then registration order, one callback at a time):
//   - `dispatch`: `startDispatchWatchdog` (agent-runtime/agent-dispatch/watchdog.mjs), a hidden role's dispatch;
//   - `registry`: `createProgressWatchdogRegistry(...).start` (session-runtime/services/agent-watchdog-registry.mjs) over the real
//     agent tree's manager facade (standalone/session-service/agent-tree.mjs), a worker's turn.
// Each run drives the real runtime-liveness state of one session (ask, request, stream, tool) and arms its watchdog; the clock moves
// a second at a time until the watchdog has aborted. Recorded per run: the progress snapshot each sweep read (its input), when it
// aborted and with what sentence; and, once, the two files the stops wrote: `history/tool-failures.jsonl` (the `stall_abort` rows)
// and `history/agent-trace.jsonl` (`MIXDOG_DIAGNOSTICS=1`), written by Node's own exit flush. Recorded three times: twice as is
// (the registry's `registration_id`, `randomUUID().slice(0, 8)`, is shown to be the only difference, and is named
// `<registration:N>` in order of appearance, as the manifest declares) and once with `MIXDOG_AGENT_TRACE_DISABLE=1`.
//
//   node benchmarks/rust-core/recorders/record-watchdog-stall-rows.mjs --tree <exact export of b6f10295a> [--only <run>]
//
// Output: native/core/fixtures/watchdog-stall-rows/golden.json (+ MANIFEST.json). With --only, the runs are printed, not written.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mock } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const SELF = fileURLToPath(import.meta.url);
const T0 = 1_700_000_000_000;
// Deadlines small enough that a run ends in seconds of mocked time; the stop itself is what is recorded, not the policy.
const POLICY = { firstTransportMs: 5000, firstSemanticMs: 8000, idleStaleMs: 10000 };
const AGENT = 'worker';
// Steps at milliseconds after the run's start; the watchdog is armed after the steps at 0. No later step falls on a sweep's
// instant (a whole second), so the snapshot read after each sweep is the one the sweep read.
const SCENARIOS = [
  { name: 'idle-after-output', steps: [[0, 'ask'], [0, 'requesting'], [1500, 'delta', 'text']] },
  { name: 'no-transport', steps: [[0, 'ask'], [0, 'requesting']] },
  { name: 'transport-without-output', steps: [[0, 'ask'], [0, 'requesting'], [500, 'delta', 'transport']] },
  { name: 'next-request-after-a-tool', steps: [[0, 'ask'], [0, 'requesting'], [100, 'delta', 'text'], [200, 'tool', 'shell'], [300, 'requesting']] },
];
const SITES = ['dispatch', 'registry'];
const RUNS = SITES.flatMap((site) => SCENARIOS.map((scenario) => ({ site, ...scenario, sessionId: `sess_stall_${site}_${scenario.name}` })));
// The most sweeps a run may take before the recording fails: every scenario stops well before.
const MAX_SWEEPS = 60;

const deadline = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

if (process.argv[2] === '--child') {
  const tree = process.env.RECORDER_TREE;
  const at = (path) => import(pathToFileURL(join(tree, path)).href);
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: T0 });
  const liveness = await at('src/runtime/agent/orchestrator/session/manager/runtime-liveness.mjs');
  // manager.mjs wires runtime-liveness to the session store (configureRuntimeLiveness), as in the product.
  await at('src/runtime/agent/orchestrator/session/manager.mjs');
  const { startDispatchWatchdog } = await at('src/runtime/agent/orchestrator/agent-runtime/agent-dispatch/watchdog.mjs');
  const { createProgressWatchdogRegistry } = await at('src/session-runtime/services/agent-watchdog-registry.mjs');
  const { createAgentTree } = await at('src/standalone/session-service/agent-tree.mjs');

  // The agent tree over in-process runtimes: `getTurnLiveness` is turn-run.mjs's (a copy of the manager's snapshot), `abort` the stop.
  const owners = new Map();
  const tree_ = createAgentTree({ sessionOwner: (id) => owners.get(id) ?? null, stateBusy: () => true, entryForSession: () => null, retainUnwatched: () => {}, createSession: async () => null });
  const registry = createProgressWatchdogRegistry({ mgr: tree_.agentManager });

  const step = async (id, [, kind, arg]) => {
    if (kind === 'ask') liveness.markSessionAskStart(id);
    else if (kind === 'requesting') liveness.updateSessionStage(id, 'requesting');
    else if (kind === 'delta') await liveness.markSessionStreamDelta(id, arg);
    else if (kind === 'tool') liveness.markSessionToolCall(id, arg);
    else throw new Error(`unknown step ${kind}`);
  };
  const out = [];
  const only = process.env.RECORDER_ONLY;
  for (const run of RUNS) {
    if (only && run.name !== only && `${run.site}/${run.name}` !== only) continue;
    const origin = Date.now();
    const id = run.sessionId;
    const sweeps = [];
    let handle;
    let signal;
    for (const s of run.steps.filter(([t]) => t === 0)) await step(id, s);
    if (run.site === 'dispatch') {
      handle = startDispatchWatchdog({ agent: AGENT, sessionId: id, policy: POLICY });
      signal = handle.signal;
    } else {
      tree_.linkAgentDescriptor({ id, parentSessionId: 'sess_stall_parent', agent: AGENT });
      let aborted = null;
      owners.set(id, {
        runtime: {
          getTurnLiveness: () => {
            const snapshot = liveness.getSessionProgressSnapshot(id);
            return snapshot ? { ...snapshot } : null;
          },
          getState: () => ({}),
          abort: async ({ cause }) => {
            aborted = cause;
          },
        },
      });
      handle = registry.start(id, POLICY, AGENT);
      signal = { get aborted() { return aborted !== null; }, get reason() { return aborted; } };
    }
    if (!handle) throw new Error(`${run.site}/${run.name}: the watchdog was not armed`);
    const later = run.steps.filter(([t]) => t > 0);
    if (later.some(([t]) => t % 1000 === 0)) throw new Error(`${run.site}/${run.name}: a step on a sweep's instant`);
    let now = 0;
    let abortedAt = null;
    for (let sweep = 1; sweep <= MAX_SWEEPS && abortedAt === null; sweep += 1) {
      const next = sweep * 1000;
      for (const s of later.filter(([t]) => t > now && t <= next)) {
        mock.timers.tick(s[0] - now);
        now = s[0];
        await step(id, s);
      }
      mock.timers.tick(next - now);
      now = next;
      // What the sweep that just ran read: the manager's snapshot at this instant (the clock does not move inside a tick).
      sweeps.push({ at: now, snapshot: liveness.getSessionProgressSnapshot(id) });
      if (signal.aborted) abortedAt = now;
    }
    if (abortedAt === null) throw new Error(`${run.site}/${run.name}: no stop within ${MAX_SWEEPS} sweeps`);
    handle.stop();
    const reason = signal.reason;
    out.push({ site: run.site, name: run.name, sessionId: id, agent: AGENT, origin, steps: run.steps, sweeps, abortedAt, message: String(reason?.message ?? reason) });
  }
  mock.timers.reset();
  process.stdout.write(JSON.stringify(out));
  // The rows are written by Node's own exit flush (`_flushToolFailuresSync`, `_flushLocalTraceSync`).
  process.exit(0);
}

const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const args = process.argv.slice(2);
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args[onlyAt + 1] : null;
const tree = resolveTree(parseArgs(onlyAt >= 0 ? args.filter((_, i) => i !== onlyAt && i !== onlyAt + 1) : args));
const identity = exactProductIdentity(tree, NODE_COMMIT);
const recorder = 'benchmarks/rust-core/recorders/record-watchdog-stall-rows.mjs';
const scratch = process.env.MIXDOG_RECORDER_SCRATCH;
if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name this run\'s scratch parent (under D:\\mixdog-build\\tmp\\<slot>)');
mkdirSync(scratch, { recursive: true });
const run = mkdtempSync(join(scratch, 'rec-stall-rows-'));
// The environment every recording child is given besides its own profile folders (the trace-disabled one adds
// MIXDOG_AGENT_TRACE_DISABLE=1): `MIXDOG_DIAGNOSTICS=1` turns the local trace file on.
const ENV = { MIXDOG_DIAGNOSTICS: '1', MIXDOG_SKIP_USER_DATA_BACKUP: '1', MIXDOG_FEATURE_MEMORY: '0' };
const PROFILE_DIRS = ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'];

/** One recording child in its own profile under the run's folder; ended only through the handle held here. Its two files, or null. */
async function recordOnce(label, extra) {
  const sandbox = join(run, label);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, RECORDER_TREE: tree, ...ENV, ...extra, ...(only ? { RECORDER_ONLY: only } : {}) };
  for (const name of PROFILE_DIRS) {
    env[name] = join(sandbox, name.toLowerCase());
    mkdirSync(env[name], { recursive: true });
  }
  const child = spawn(process.execPath, [SELF, '--child'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let result;
  try {
    result = await deadline(exited, 120_000, `the recording child ${label}`);
  } catch (error) {
    child.kill();
    await deadline(exited, 30_000, `the recording child ${label} ending after its kill`);
    throw new Error(`${error.message}; the folder ${run} is kept\n${stderr}`);
  }
  if (result.code !== 0) throw new Error(`the recording child ${label} failed (${result.code ?? result.signal}); the folder ${run} is kept:\n${stderr}`);
  const history = join(env.MIXDOG_DATA_DIR, 'history');
  const read = (name) => (existsSync(join(history, name)) ? readFileSync(join(history, name), 'utf8') : null);
  return { runs: JSON.parse(stdout), failures: read('tool-failures.jsonl'), trace: read('agent-trace.jsonl') };
}

/** The registry's `registration_id`s (`randomUUID().slice(0, 8)`, agent-watchdog-registry.mjs:161), each 8 hex digits, named by order of appearance. */
function maskRegistrations(text) {
  const registrations = new Map();
  return text.replace(/"registration_id":("[^"]*"|null)/g, (whole, value) => {
    if (value === 'null') return whole;
    const id = JSON.parse(value);
    if (!/^[0-9a-f]{8}$/.test(id)) throw new Error(`registration id ${id} is not 8 hex digits`);
    if (!registrations.has(id)) registrations.set(id, `<registration:${registrations.size + 1}>`);
    return `"registration_id":"${registrations.get(id)}"`;
  });
}

const a = await recordOnce('a', {});
const b = await recordOnce('b', {});
const off = await recordOnce('trace-disabled', { MIXDOG_AGENT_TRACE_DISABLE: '1' });
// The registration id is the run's own: two recordings of the same input write different ids and nothing else differs.
if (a.failures === null || a.trace === null) throw new Error(`recording a wrote no ${a.failures === null ? 'tool-failures.jsonl' : 'agent-trace.jsonl'}`);
if (JSON.stringify(a.runs) !== JSON.stringify(b.runs) || a.trace !== b.trace) throw new Error('two recordings differ in their runs or their trace');
if (b.failures === null || maskRegistrations(a.failures) !== maskRegistrations(b.failures)) throw new Error('two recordings differ in their failure rows beyond the registration ids');
if (a.failures === b.failures && /"registration_id":"/.test(a.failures)) throw new Error('two recordings wrote the same registration ids: the id is not shown to be the run\'s own');
if (JSON.stringify(off.runs) !== JSON.stringify(a.runs)) throw new Error('the trace-disabled recording stopped its runs otherwise');
rmSync(run, { recursive: true, force: true });
const golden = {
  note: 'the stall_abort rows of Node\'s progress watchdog (dispatch and registry), recorded at b6f10295a on mocked interval timers and clock; traceDisabled: the same runs with MIXDOG_AGENT_TRACE_DISABLE=1 (null: the file was not written)',
  t0: T0,
  policy: POLICY,
  runs: a.runs,
  failures: maskRegistrations(a.failures),
  trace: a.trace,
  traceDisabled: { failures: off.failures, trace: off.trace },
};
if (only) {
  console.log(JSON.stringify(golden, null, 1));
  process.exit(0);
}
const finalDir = join(FIXTURES_ROOT, 'watchdog-stall-rows');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, {
  set: 'watchdog-stall-rows',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    node: process.version,
    recorderSha256: createHash('sha256').update(readFileSync(SELF)).digest('hex'),
    syntheticInputs: {
      clockEpoch: T0,
      mockedTimers: { api: 'node:test mock.timers.enable', apis: ['setInterval', 'Date'], now: T0, order: 'due time, then registration order, one callback at a time', step: 'one second per sweep; a step tick at its own instant first', maxSweeps: MAX_SWEEPS },
      environment: { ...ENV, profileFolders: PROFILE_DIRS.map((name) => `${name}=<the recording's own folder>`), traceDisabledRun: { MIXDOG_AGENT_TRACE_DISABLE: '1' } },
      sessionIds: [...RUNS.map((r) => r.sessionId), 'sess_stall_parent (the registry runs\' parentSessionId)'],
      policy: POLICY,
      agent: AGENT,
      scenarios: SCENARIOS,
      runtime: 'an in-process agent runtime object (getTurnLiveness = the manager snapshot copy, abort recorded)',
    },
    runOwnValues: {
      registration_id: {
        source: 'src/session-runtime/services/agent-watchdog-registry.mjs:161 randomUUID().slice(0, 8)',
        placeholder: '<registration:N>, N by order of appearance in history/tool-failures.jsonl; each id checked to be 8 lowercase hex digits',
        proof: 'two recordings of the same input (a, b): their failure rows differ, and are identical once the ids are named so; their runs and traces are identical',
      },
    },
  },
});
commitStage(stage, finalDir);
console.log(`runs=${golden.runs.length} failures=${golden.failures.split('\n').length - 1} trace=${golden.trace.split('\n').length - 1}`);
process.exit(0);
