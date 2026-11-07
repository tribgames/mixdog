#!/usr/bin/env node
// Golden twin of the lifecycle barriers and the generation fence of the session store:
// `bumpSessionGenerationAttempt` (the detach, `store/lifecycle-barriers.mjs:269-285`), `markSessionClosedAttempt`
// (the tombstone, `:209-256`) and the save fence `_dropsAgainst` (`store.mjs:149-153`), over the real
// `createSession` / `saveSessionAsync` of the session store.
//
// `barriers`: a session's lifecycle header before and after a sequence of barriers. `fence`: for a record
// at a recorded generation (open after a detach, or closed), a late copy that names an expected generation is
// saved: the outcome.
//
//   node benchmarks/rust-core/recorders/record-session-lifecycle.mjs --tree <dir with node_modules>
import { mkdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

export const FIXED_NOW = 1_700_000_000_000;
// The store's locks and timers read the clock, so it is the real one; a timestamp the barriers wrote is recorded as the
// step whose call window holds it (windows are kept apart by a pause), not as a number.
const pause = () => new Promise((done) => setTimeout(done, 5));

const cli = parseArgs();
const tree = resolveTree(cli);
// A child process lands one barrier in the parent's data dir and exits: the record then reaches the parent as it would
// reach another process, with no live recorder of this process holding it (which would drop every late copy outright).
const child = cli.get('child');
let stage;
let outDir;
if (child) {
  process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
} else {
  outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'session-lifecycle');
  stage = stageSet(outDir);
  const work = mkdtempSync(join(tmpdir(), 'session-lifecycle-'));
  const data = join(work, 'data');
  mkdirSync(data, { recursive: true });
  process.env.MIXDOG_DATA_DIR = data;
  process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
}
const dir = 'src/runtime/agent/orchestrator';
const { createSession } = await importFrom(tree, `${dir}/session/manager/session-lifecycle.mjs`);
const store = await importFrom(tree, `${dir}/session/store.mjs`);
const { _withRegisteredProviderForTestAsync } = await importFrom(tree, `${dir}/providers/registry.mjs`);
if (child) {
  const [op, reason] = child.split(':');
  const id = cli.get('id');
  if (op === 'detach') await store.bumpSessionGenerationAttempt(id, reason, { outcome: {} });
  else await store.markSessionClosedAttempt(id, reason, { outcome: {} });
  process.exit(0);
}
const OTHER_PROCESS = [process.argv[1], '--tree', tree];

const providerName = 'session-lifecycle-twin';
const provider = { name: providerName, contextWindow: 128000, async send() { throw new Error('no turn runs'); } };
const options = { provider: providerName, model: 'fake-model', owner: 'cli', agent: 'lead', lane: 'cli', sourceType: 'lead', sourceName: 'main', skipSkills: true };

const KEYS = ['generation', 'updatedAt', 'detachedReason', 'ownerClosedAt', 'closed', 'closedReason', 'status', 'cancelStatus', 'cancelledAt'];
const windows = [];
const stamp = (value) => {
  const at = windows.findIndex(([from, to]) => value >= from && value <= to);
  return at < 0 ? value : { step: at };
};
const TIMES = new Set(['updatedAt', 'ownerClosedAt', 'cancelledAt']);
const lifecycle = (id) => {
  const session = store.loadSession(id);
  const out = {};
  for (const key of KEYS) if (session[key] !== undefined) out[key] = TIMES.has(key) ? stamp(session[key]) : session[key];
  return out;
};
const fresh = async () => {
  windows.length = 0;
  await pause();
  const from = Date.now();
  const session = createSession(options);
  await store.saveSessionAsync(session, {});
  windows.push([from, Date.now()]);
  await pause();
  return session.id;
};

const barriers = [];
const BARRIER_CASES = [
  { name: 'detach', steps: [{ op: 'detach', reason: 'no live session clients' }] },
  { name: 'detach-twice', steps: [{ op: 'detach', reason: 'no live session clients' }, { op: 'detach', reason: 'SIGTERM' }] },
  { name: 'owner-close', steps: [{ op: 'detach', reason: 'cli-agent-close', ownerClose: true }] },
  { name: 'close', steps: [{ op: 'close', reason: 'idle-sweep' }] },
  { name: 'detach-then-close', steps: [{ op: 'detach', reason: 'cli-exit' }, { op: 'close', reason: 'manual' }] },
  { name: 're-close', steps: [{ op: 'close', reason: 'manual' }, { op: 'close', reason: 'desktop-session-delete' }] },
  { name: 'cancel-close', steps: [{ op: 'close', reason: 'agent-task-cancel' }] },
];
const fence = [];
await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
  for (const c of BARRIER_CASES) {
    const id = await fresh();
    const record = [];
    for (const step of c.steps) {
      const before = lifecycle(id);
      const from = Date.now();
      const generation = step.op === 'detach'
        ? await store.bumpSessionGenerationAttempt(id, step.reason, { outcome: {}, ownerClose: step.ownerClose === true })
        : await store.markSessionClosedAttempt(id, step.reason, { outcome: {} });
      windows.push([from, Date.now()]);
      await pause();
      record.push({ ...step, before, generation, after: lifecycle(id) });
    }
    barriers.push({ name: c.name, steps: record });
  }

  // The fence: a record in each lifecycle state, a late copy per expected generation.
  const STATES = [
    { name: 'open-fresh', ops: [] },
    { name: 'open-detached-once', ops: [{ op: 'detach', reason: 'cli-exit' }] },
    { name: 'open-detached-twice', ops: [{ op: 'detach', reason: 'cli-exit' }, { op: 'detach', reason: 'cli-exit' }] },
    { name: 'closed', ops: [{ op: 'close', reason: 'manual' }] },
  ];
  for (const state of STATES) {
    for (const expected of [null, 0, 1, 2]) {
      const id = await fresh();
      const late = structuredClone(store.loadSession(id));
      store.drainSessionStore();
      // Each barrier lands in another process; this one then holds nothing of the session (its writer lock is free).
      for (const op of state.ops) {
        execFileSync(process.execPath, [...OTHER_PROCESS, '--child', `${op.op}:${op.reason}`, '--id', id], { stdio: 'inherit' });
      }
      const recorded = lifecycle(id);
      late.messages.push({ role: 'user', content: `late write ${state.name} ${expected}` });
      const outcome = await store.saveSessionAsync(late, expected === null ? {} : { expectedGeneration: expected });
      fence.push({
        state: state.name,
        recorded: { generation: recorded.generation ?? 0, closed: recorded.closed === true },
        expected,
        outcome,
        dropped: outcome !== 'saved',
      });
    }
  }
});

writeJson(join(stage, 'twin.json'), { clock: FIXED_NOW, barriers, fence });
writeSetManifest(stage, {
  set: 'session-lifecycle',
  recorder: 'benchmarks/rust-core/recorders/record-session-lifecycle.mjs',
  command: 'node benchmarks/rust-core/recorders/record-session-lifecycle.mjs --tree <tree>',
  identityTree: cli.get('identity-tree') ?? tree,
});
commitStage(stage, outDir);
console.log(`session-lifecycle: ${barriers.length} barrier cases, ${fence.length} fence cases -> ${outDir}`);
// The session writers still hold their lock files; the sandbox is swept with the temp dir.
process.exit(0);